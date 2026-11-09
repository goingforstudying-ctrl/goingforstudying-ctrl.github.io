---
layout: post
title: "The stop signal with nowhere to go"
permalink: /notes/the-stop-signal-with-nowhere-to-go/
categories: [concurrency, go]
excerpt: "An MQTT broker that ignores SIGTERM looks like an orchestration problem. This one was a nil channel in the memberlist delegate, and it had company."
---

I was reading through the memberlist discovery code in comqtt after an earlier fix of mine landed, and the delegate's `Stop()` jumped out at me:

```go
func (d *Delegate) Stop() {
	d.stop <- struct{}{}
	close(d.msgCh)
}
```

`d.stop` is declared on the struct but never initialized in `NewDelegate`. A send on a nil channel doesn't fail; it blocks forever. So a broker running with `discovery-way: memberlist` hangs on shutdown: SIGTERM, nothing happens, and eventually the orchestrator gets bored and SIGKILLs it. I assume most comqtt users run serf for discovery, because this had been sitting there a while.

Two more bugs fell out while I stared at the file, and they were worse than the hang.

## The gossip callbacks race the map

The delegate implements hashicorp/memberlist's `Delegate` interface, whose own docs say the methods "can and generally will be called concurrently." Here's what `LocalState` did:

```go
func (d *Delegate) LocalState(join bool) []byte {
	if d.server != nil {
		d.State[d.LocalNode.Name] = d.server.Info.ClientsConnected
	}
	bs, _ := json.Marshal(d.State)
	return bs
}
```

No lock. Meanwhile `MergeRemoteState`, which memberlist calls from a different goroutine during the same push/pull exchange, took the lock before touching the same map. Two overlapping push/pulls, or one during a join, and you have an unsynchronized write plus an iteration on a Go map. That's not a data race you can shrug off: the runtime detects concurrent map writes and throws a fatal error. No recover, no defer, the process just dies. On a broker, it dies mid-gossip.

There was a subtler race in the same two lines. `ClientsConnected` is incremented elsewhere with `atomic.AddInt64`, so reading it as a plain field is itself a data race even if you hold the map lock. The read had to become `atomic.LoadInt64(&d.server.Info.ClientsConnected)`.

And `Membership.Stat()` returned `m.delegate.State` directly: the live map, handed to whoever called the stats endpoint, still being written by the gossip handlers.

## Fixing the shutdown first

The deadlock fix is two lines, but the shape of it matters. A send needs a receiver that's actually listening at that moment; if the queue pruner already exited, or hasn't started, the send parks the caller. Closing a channel is a broadcast: every current and future receiver unblocks, and nobody has to be ready. Combined with `sync.Once`, repeat calls become no-ops instead of a second panic:

```go
func (d *Delegate) Stop() {
	d.stopOnce.Do(func() {
		close(d.stop)
	})
}
```

The second line of the old `Stop()` had to go entirely. `d.msgCh` is the agent's inbound channel; the delegate doesn't own it, it just writes to it. Closing someone else's channel during shutdown means an in-flight `NotifyMsg` from a memberlist handler panics on send-to-closed, and a second `Stop()` panics on the double close. Ownership is the whole rule: whoever created the channel closes it.

For the map, `LocalState` now takes the write lock (it writes, then marshals, so a read lock doesn't cover it), and there's a new `Stats()` that copies the map under the read lock. `Membership.Stat()` calls that instead of handing out the live reference. Callers get a snapshot; the gossip handlers keep their map; nobody meets.

## Proving it with the race detector

The new `delegate_test.go` covers the shutdown path with a timeout-wrapped `Stop`, a double-`Stop`, and a `NotifyMsg` delivered after `Stop` to prove the channel survives. The interesting test is the stress one: four goroutines each hammering `LocalState`, `MergeRemoteState`, and `Stats` for 300 rounds, run under `go test -race`.

The satisfying part was running that same test file against unmodified main: `Stop` deadlocks on the first test and the race detector lights up the state map on the stress test. Two sentences in the memberlist docs, and the whole delegate was living on borrowed time.

My [comqtt PR #193](https://github.com/wind-c/comqtt/pull/193) merged on November 9, 2026. [Implementation and tests](https://github.com/wind-c/comqtt/pull/193/files). `go test -race ./cluster/discovery/mlist/` is green on the merge; the only failures in the wider suite (`cmd/cluster` leak checks and the postgres auth plugin) fail identically on unmodified main and want a real postgres, so I left them alone.
