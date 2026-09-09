---
layout: post
title: "The snapshot that silently ate the routing table"
---

An earlier concurrency fix in comqtt made snapshot restore decode into a copy of the routing table. The decoder could return success while the live table remained unchanged. A fresh node could therefore miss subscriptions stored in its snapshot; a node with existing state could keep stale subscriptions instead.

The earlier commit made `KV.GetAll()` return a copy of the routing table. That was the right call for the problem it fixed, because `Persist` iterates the table while other goroutines mutate it, and a concurrent read during snapshot serialization would race. The problem was what the two restore paths did next:

```go
gob.NewDecoder(ir).Decode(f.GetAll())
```

`GetAll` hands back a pointer to a throwaway copy, so gob dutifully decoded the entire snapshot into a map that was then discarded. The live table never changed. What made this so nasty is that everything runs without a complaint: the code compiles, `Restore` returns no error, and decoding into the wrong map is not something gob warns you about.

Snapshot installation is used during recovery and when Raft needs to bring a follower up to date. In those paths, successfully decoding bytes is not enough: the restored table must become the state consulted by routing. The observed outcome depends on the node's prior state and any subsequent log replay; this bug does not establish that every graceful restart of every deployment necessarily leaves an empty table.

For remote subscription filters that are missing from the live table, `Lookup` returns no route and `pickNodes` cannot select the subscriber's node. Messages for those subscriptions may stop being forwarded despite a successful restore. Existing routes, later log replay, or a new subscription can change that outcome; the failure is specifically that the snapshot did not update the live routing state.

The fix adds a proper `Restore` method on the KV store that decodes into a fresh map and swaps it in under lock:

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

Both backends, the hashicorp raft FSM and the etcd-based kvstore, now call `KV.Restore` instead of decoding into `GetAll()`'s copy. Replace rather than merge is deliberate here: raft's contract says a restore must discard previous state and replace it with the snapshot, so a restore must not retain stale filters absent from the selected snapshot. Raft decides which snapshot is valid to install. And a corrupt snapshot returns an error while leaving the existing state untouched, which the tests pin down explicitly.

The unit tests exercise the serialization and restore code, including a test SnapshotSink for the hashicorp backend. They do not restart a real multi-node cluster. Build an FSM, add filters including a shared subscription, snapshot it, feed those bytes into a fresh FSM, and verify `Lookup` sees exactly what the snapshot contained and nothing else. Round-trip tests cover the KV itself and both backends, with corrupt-snapshot cases and a check that the restored map doesn't share slices with the source.

One thing I deliberately left alone: `notifyReplay` replays every restored filter including ones the local node itself owns. That behavior predates this bug, and changing it felt out of scope, but I flagged it in [the PR](https://github.com/wind-c/comqtt/pull/173) in case it matters down the road.

The practical symptom is missing or stale cross-node subscription routing after a snapshot-based recovery, despite the decode reporting success. The fix is merged in [comqtt #173](https://github.com/wind-c/comqtt/pull/173). Round-trip tests through both Raft backends check the live lookup result, which is the state that message forwarding actually uses.

Implementation reference: [merged commit](https://github.com/wind-c/comqtt/commit/40fdcac5d6811fe9ae5abe169fa1c242584ef9b9) (2026-09-03).
