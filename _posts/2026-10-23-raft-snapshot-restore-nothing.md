---
layout: post
title: "The snapshot that restored nothing"
permalink: /notes/raft-snapshot-restore-nothing/
categories: [distributed-systems, raft, mqtt]
excerpt: "A comqtt node that installed a raft snapshot came back with an empty routing table. The restore was decoding into a throwaway copy, and nothing logged an error."
---

Restart a comqtt broker node and, for a while, everything looks fine. Clients reconnect, local subscriptions rebuild, messages flow. But subscribers on *other* nodes quietly stop receiving publishes for topics this node handles, and they stay silent until each client happens to re-subscribe — which for long-lived bridged clients may be never. No error is logged anywhere. The messages just don't route.

The trigger isn't the restart itself. It's that the restart replays a raft snapshot, and the snapshot restore was writing into memory that immediately became garbage.

## A good fix with an invisible side effect

The story starts with an earlier, correct fix. `KV.GetAll` returns the routing table — the map from topic filter to the set of nodes interested in it. Callers used to get the live map, which meant a concurrent reader during `Persist` could hit a fatal concurrent-map-access panic. The fix made `GetAll` return a copy. Correct, and the panic went away.

But both snapshot restore paths still looked like this:

```go
gob.NewDecoder(ir).Decode(f.GetAll())
```

`GetAll` now hands back a pointer to a throwaway copy. The gob decoder faithfully decodes the snapshot into that copy, the call returns, the copy is discarded, and the live routing table never changes. The bug isn't in the decode — it's that the destination stopped being real. Both raft backends had it: the HashiCorp FSM's `Restore` and the etcd-backed store's `recoverFromSnapshot`.

What makes this nasty is how often restore runs. Raft calls it when a follower falls far enough behind that the leader sends `InstallSnapshot`, when a partitioned node rejoins, and on every graceful restart — because `Peer.Stop` snapshots right before shutdown and raft replays that snapshot on the way back up. So the most routine operation in the cluster, a clean bounce, wiped a node's cross-node routing. `Lookup` returned nothing for restored filters, `pickNodes` found no remote nodes, and forwarding to other nodes' subscribers stopped.

## Replace, don't merge

The fix in [PR #173](https://github.com/wind-c/comqtt/pull/173) gives the store a real restore entry point and points both backends at it:

```go
func (k *KV) Restore(r io.Reader) error {
	var d data
	if err := gob.NewDecoder(r).Decode(&d); err != nil {
		return err
	}
	if d == nil {
		d = make(data)
	}
	k.Lock()
	defer k.Unlock()
	k.data = d
	return nil
}
```

Three details carry the weight. First, the decode target is a fresh local map, not whatever `GetAll` happened to return — the decoded data actually lands somewhere. Second, the swap happens under the write lock, so a `Lookup` mid-restore sees either the old table or the new one, never a half-written map. Third, restore *replaces* rather than merges. Raft's contract is that a snapshot holds the complete state up to its index, so a node restoring an older snapshot must not keep filters the snapshot doesn't know about. Merging would resurrect stale routes; discarding first is the only correct read of the contract.

The corrupt-snapshot path also falls out naturally: if the decode fails, the function returns before touching `k.data`, so a truncated snapshot leaves the existing state untouched rather than half-replacing it.

## Round-tripping the real path

The tests reproduce the exact production flow rather than testing the map in isolation: build a source FSM, add routes, take a real snapshot, `Persist` it into a sink, then `Restore` those bytes into a fresh FSM and ask it what it knows:

```go
src := NewFsm(nil)
src.Add("topic/a", "node1")
snap, _ := src.Snapshot()
snap.Persist(sink)
dst := NewFsm(nil)
dst.Restore(io.NopCloser(bytes.NewReader(sink.Bytes())))
dst.Lookup("topic/a") // nil before the fix, [node1] after
```

Before the fix, that final lookup returns nil — the bytes went nowhere. After it, the restored node knows the route. The tests also seed the destination with a stale entry and assert it's gone after restore (replace-not-merge), truncate the snapshot bytes and assert the error leaves prior state intact, and confirm the restored map shares no slices with the source, so later mutation can't alias across the two. Same coverage for both backends, since both had the bug.

One thing I deliberately left alone: `notifyReplay` replays every restored filter including ones the local node itself owns. That was the pre-existing behavior, and changing it felt out of scope for a restore correctness fix — but it's flagged in the PR in case it matters to someone running this in production.

The broader lesson I keep relearning: changing what a getter *returns* is a breaking change even when the signature doesn't move. Every `Decode(dst)` call site is making an assumption about whether `dst` is live storage. When `GetAll` started returning a copy, every decode-into-it caller silently became a no-op, and the only observable symptom was missing messages three hops away in the broker's forwarding path.
