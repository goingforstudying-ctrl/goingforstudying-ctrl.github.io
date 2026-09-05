---
layout: post
title: "The snapshot that silently ate the routing table"
---

I was reading through comqtt's cluster raft code when I spotted a regression that had been hiding in plain sight. An earlier concurrency fix had accidentally broken snapshot restore in both raft backends, and the failure mode was completely silent: a node that installed a snapshot would come back with an empty subscription routing table, and every message that should have been forwarded across the cluster just stopped going anywhere.

The earlier commit made `KV.GetAll()` return a copy of the routing table. That was the right call for the problem it fixed, because `Persist` iterates the table while other goroutines mutate it, and a concurrent read during snapshot serialization would race. The problem was what the two restore paths did next:

```go
gob.NewDecoder(ir).Decode(f.GetAll())
```

`GetAll` hands back a pointer to a throwaway copy, so gob dutifully decoded the entire snapshot into a map that was then discarded. The live table never changed. What made this so nasty is that everything runs without a complaint: the code compiles, `Restore` returns no error, and decoding into the wrong map is not something gob warns you about.

The trigger conditions are more common than you'd expect. A snapshot gets installed whenever a follower falls far enough behind that the leader sends `InstallSnapshot`, and when a partitioned node rejoins. But the worst one is the most mundane: on every graceful restart, since `Peer.Stop()` takes a snapshot right before shutdown and raft replays it on the way back up. So any clustered comqtt deployment that restarts a node ends up with that node's routing table empty until clients happen to re-subscribe.

And the downstream effects were invisible at the broker level. `Lookup` returns nothing for the affected filters, `pickNodes` finds no remote nodes, and publishes stop being forwarded to subscribers on other nodes. Nothing logs an error, because as far as the cluster is concerned everything worked: the snapshot installed cleanly. For long-lived bridged clients that subscribe once and hold the connection open, those subscriptions are simply gone, and nothing re-establishes them. Messages silently don't route.

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

Both backends, the hashicorp raft FSM and the etcd-based kvstore, now call `KV.Restore` instead of decoding into `GetAll()`'s copy. Replace rather than merge is deliberate here: raft's contract says a restore must discard previous state and replace it with the snapshot, so a node restoring an older snapshot shouldn't keep filters the snapshot doesn't know about. And a corrupt snapshot returns an error while leaving the existing state untouched, which the tests pin down explicitly.

The tests go through the real Persist and Restore path rather than mocks. Build an FSM, add filters including a shared subscription, snapshot it, feed those bytes into a fresh FSM, and verify `Lookup` sees exactly what the snapshot contained and nothing else. Round-trip tests cover the KV itself and both backends, with corrupt-snapshot cases and a check that the restored map doesn't share slices with the source.

One thing I deliberately left alone: `notifyReplay` replays every restored filter including ones the local node itself owns. That behavior predates this bug, and changing it felt out of scope, but I flagged it in [the PR](https://github.com/wind-c/comqtt/pull/173) in case it matters down the road.

For anyone running comqtt, the clustered MQTT broker at [github.com/wind-c/comqtt](https://github.com/wind-c/comqtt), with bridged or otherwise long-lived clients, this one hurts: the node looks healthy, the cluster looks healthy, and messages are being dropped. The fix is merged in [comqtt#173](https://github.com/wind-c/comqtt/pull/173).
