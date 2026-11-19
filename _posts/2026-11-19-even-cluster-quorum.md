---
layout: post
title: "The test that asserted the split-brain"
permalink: /notes/even-cluster-quorum/
categories: [distributed-systems, consensus]
excerpt: "A Raft quorum computed as ceil(n/2) instead of floor(n/2)+1 lets a 2-2 partition elect two leaders in the same term. The test suite had the bug written into it as the expected behavior."
---

I found a Raft cluster electing two leaders in the same term, and the test suite was fine with it. Not because the tests were missing, but because one of them asserted the split-brain as the correct outcome.

The cluster was [miniraft](https://github.com/jackyzha0/miniraft), a small Raft implementation with a simulation harness. I was poking at the harness when I noticed it only ever ran 3- or 5-node clusters. Odd sizes. Nobody had asked what happens at n=4.

What happens at n=4 is that quorum math matters.

## ceil(n/2) is not a majority

The quorum calculation was one line:

```rust
pub fn quorum_size(&self) -> usize {
    // add an extra because self.peers doesn't include self
    self.peers.len().saturating_add(2).div(2)
}
```

`peers` doesn't count self, so `peers.len() + 1` is the cluster size n. The formula computes `(n + 1) / 2`, which is ceil(n/2). For odd n that's the same as a strict majority: n=3 gives 2, n=5 gives 3. For even n it's one vote short. n=4 gives 2, when a majority of 4 is 3. n=2 gives 1, meaning a single node is a "majority" of two.

Raft's whole safety argument rests on the fact that any two quorums intersect. Any two strict majorities share at least one node, so a leader's log and a committed entry can never silently diverge. Two disjoint halves of an even cluster are each "half", and ceil(n/2) calls half a quorum. The intersection argument is gone.

I set up the repro: a 4-node cluster, partition it 2-2, tick the clock forward:

```
leaders after 2-2 partition: [(0, 1), (3, 1)]
quorum_size() for n=4 is 2
node0 first entry/committed: Some((1, 100))
node3 first entry/committed: Some((1, 200))
```

Both sides elected a leader in term 1. Worse, `commit_log_entries` counts acks against the same wrong quorum, so both sides committed. Two different commands at log index 0, both marked committed. That's the thing Raft exists to prevent, gone because of one division.

## The test had the bug in it

The part I keep thinking about: there was already a test for the 2-node partition case, and it passed:

```rust
fn two_cluster_partition_has_two_leaders() {
    let mut cluster = TestCluster::new(2, 0, DEFAULT_CFG);
    cluster.drop_between(0, 1);
    cluster.tick_by(MAX_WAIT);
    assert_eq!(cluster.num_leaders(), 2);
}
```

With quorum 1 for n=2, each side of a partitioned pair self-elects, and the test asserted exactly that. The name says it plainly: `two_cluster_partition_has_two_leaders`. Someone wrote down the observed behavior as the expected behavior. It's the easiest trap in consensus testing — the implementation is the reference, so whatever it does becomes the spec.

The fix flips the assertion to what Raft actually requires: a 2-node cluster needs both nodes for a majority, so neither side of a partition leads. Both keep campaigning forever, which is fine — unavailability is the correct price for safety.

## The fix is one line, the proof is the tests

```rust
pub fn quorum_size(&self) -> usize {
    // peers doesn't include self, so n = peers.len() + 1
    (self.peers.len() + 1) / 2 + 1
}
```

floor(n/2) + 1. The strict-majority table for n=1 through 7 now sits in a test so the definition is pinned down: 1→1, 2→2, 3→2, 4→3, 5→3, 6→4, 7→4.

The rest of [the PR](https://github.com/jackyzha0/miniraft/pull/6) is tests, because a one-line arithmetic fix deserves evidence that the arithmetic was the whole problem. A new `even_cluster_quorum.rs` partitions a 4-node cluster 2-2 and asserts the safe outcome: no leader, every client request rejected, nothing committed on any node. Then it heals the partition and checks the cluster elects one leader and commits again — fixing availability without giving back safety. And it sanity-checks that a healthy 4-node cluster still elects exactly one leader, because an overcorrected quorum would be its own bug.

The harness change was the other half: the simulator now runs 4-node clusters on a third of its seeds instead of only 3 and 5. With the old formula, the sim trips election or commit-durability safety on 4 of the first 20 seeds — seed 5 produces two leaders in one term at tick 13. With the fix, 150 seeds run clean across 3-, 4-, and 5-node clusters.

## What I took from it

The bug survived because every test input was odd. Odd cluster sizes are the comfortable default — etcd runs 3 or 5, the Raft paper's examples are 3 and 5, and every tutorial reaches for them. But even sizes are exactly where an off-by-one in majority math becomes a second disjoint quorum. If your property tests only generate odd n, you've tested the cases where ceil and floor agree.

The other lesson is the test-name one. When a test asserts something surprising, the surprising thing is either a subtle correct behavior or a bug someone canonized. "Two leaders after a partition" should read as an alarm, not a spec.

My [miniraft PR #6](https://github.com/jackyzha0/miniraft/pull/6) merged on September 25, 2026. [Implementation and tests](https://github.com/jackyzha0/miniraft/pull/6/files).
