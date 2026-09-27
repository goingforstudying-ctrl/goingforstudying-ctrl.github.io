---
layout: post
title: "The quorum that rounded up"
---

I found this one by accident, and the accident has a lesson in it.

There's a small Raft implementation in Rust I've been poking at, and it comes with a simulation harness — deterministic seeds, fault injection, the works. The harness runs a cluster, partitions it, heals it, throws client commands at it, and asserts the usual Raft safety properties: at most one leader per term, committed entries never get overwritten, that kind of thing.

The harness only ever ran 3-node and 5-node clusters. Odd sizes. That detail matters, and nobody had noticed it mattered.

On a whim I made it run 4-node clusters on a third of the seeds. The very first batch lit up: seed 5 produced two leaders in the same term at tick 13. Seeds 8, 11, and 17 committed entries and then overwrote them. Four of the first twenty seeds tripped a safety property. In Raft terms, that's the whole thing on fire.

## The math

A Raft quorum has to be a strict majority: `floor(n/2) + 1`. That's what makes two quorums overlap in at least one node, and since a node votes at most once per term, that overlap is the entire reason two leaders can't coexist in the same term.

The code computed it like this:

```rust
/// quorum = ceil((peers.length + 1)/2)
pub fn quorum_size(&self) -> usize {
    // add an extra because self.peers doesn't include self
    self.peers.len().saturating_add(2).div(2)
}
```

`peers` doesn't include the node itself, so `n = peers.len() + 1`. The formula is `(n + 1) / 2`, which is `ceil(n/2)`. For odd `n`, `ceil(n/2)` and `floor(n/2) + 1` agree, which is why 3- and 5-node clusters were fine. For even `n`, they don't:

- n=4: computed quorum is 2, correct is 3
- n=6: computed quorum is 3, correct is 4
- n=2: computed quorum is 1

Read that last one again. A 2-node cluster where each node is its own quorum. Partition the two nodes and both sides self-elect, both sides accept client commands, both sides commit. That's exactly what the simulation showed, and at n=4 a 2-2 split does the same thing: each half thinks 2 out of 4 is a majority, so you get a leader on each side of the partition in the *same* term. Worse, commit bookkeeping counts acks against that same wrong quorum, so both sides commit their own client commands at the same log index. Two different commands committed at index 0. State machine safety, gone.

## The uncomfortable part

The bug wasn't just in the code. It was in the test suite.

There was a test called `two_cluster_partition_has_two_leaders` that partitioned a 2-node cluster and asserted `num_leaders() == 2`. The suite had codified the split-brain as the expected behavior. The test passed on CI every day, quietly asserting that Raft's core safety property didn't hold.

This is the part I keep thinking about. The off-by-one is a one-line fix. But the reason it survived is that the tests were written against the implementation, not against the protocol. Someone read the code, observed what it did, and wrote a test that pinned it down. The test suite and the code agreed with each other and both disagreed with Raft.

The fix itself:

```rust
/// quorum = floor(n/2) + 1, a strict majority of the cluster
pub fn quorum_size(&self) -> usize {
    // peers doesn't include self, so n = peers.len() + 1
    (self.peers.len() + 1) / 2 + 1
}
```

Alongside it, I flipped the old test to assert the correct behavior — a partitioned 2-node cluster elects no leader, because quorum is 2 and neither side has it — and added a dedicated test file for even clusters: a strict-majority table for n=1 through 7, a 4-node 2-2 split test that asserts no leader emerges, client requests get rejected everywhere, and nothing commits, plus a heal-and-recover test showing the cluster comes back once the partition clears. Then I taught the simulation to sweep 3, 4, and 5 nodes so even sizes get exercised permanently. With the fix, 150 seeds came back clean across all three sizes.

The full change is in [miniraft PR #6](https://github.com/jackyzha0/miniraft/pull/6).

## Why this shape of bug is worth remembering

Even-sized clusters aren't exotic. People run 4-node and 6-node deployments constantly — often deliberately, for cost or topology reasons, accepting that an even size buys you no extra fault tolerance over the odd size below it. Any hand-rolled quorum math anywhere near a system like this deserves a paranoid second look, because `ceil(n/2)` *sounds* like "majority" if you say it fast enough. It's off by exactly the boundary case: even `n`, split exactly in half.

Two takeaways I'm keeping. First, if your fault-injection harness only exercises odd cluster sizes, you haven't tested your quorum. Sweep the parity. Second, when a test asserts behavior that would violate a safety property of the underlying protocol, the test is the bug's accomplice. Pinning down observed behavior is not the same as specifying correct behavior, and the difference only shows up at the worst possible time — a network partition, in production, with two nodes both certain they're in charge.
