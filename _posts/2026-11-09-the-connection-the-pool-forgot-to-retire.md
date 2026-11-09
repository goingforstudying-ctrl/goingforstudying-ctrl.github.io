---
layout: post
title: "The connection the pool forgot to retire"
permalink: /notes/the-connection-the-pool-forgot-to-retire/
categories: [rust, distributed-systems]
excerpt: "Ballista's executors share one gRPC connection per peer for pipelined shuffles. Nothing ever closed the quiet ones, and an eviction race could strand a fresh connection where nobody would find it."
---

I came across apache/datafusion-ballista#2673 while reading the pipelined reader's pool code. It had been raised in a review thread and never got a follow-up, which usually means the bug is real but annoying to fix. It was both.

Ballista is a distributed SQL engine: a scheduler hands query stages to executors, and during a pipelined shuffle those executors stream record batches from each other over Arrow Flight. Opening a fresh gRPC connection per stream would be wasteful, so the executor's client pool keeps one *shared* connection per `(host, port, config)` tuple. Any number of readers multiplex their streams over it.

The checked-out side of the pool had an idle timeout. The shared side had nothing.

## Two leaks and a race

The shared map only ever shrank when a caller explicitly discarded a connection after a failure, and even then the dead slot sat in the map until the next eviction pass happened to run. With executor churn — autoscaling, spot termination, rolling upgrades — those slots pile up for the life of the process. Each one is a map entry plus whatever the dead connection was still holding.

The second leak was worse in a quiet way: a shared connection that stays healthy but never gets requested again was *never* closed. The idle timeout only covered the checked-out deque. A peer you talked to once during a reshuffle kept its connection open forever.

And there was a race hiding in the connect path. `shared()` cloned the slot out of the map, then did the actual TCP+TLS connect *outside* the shard lock. If an eviction pass ran in that window, it dropped the slot; when the connect finished, the fresh connection went into a slot that was no longer in the map. The connection worked — the caller that opened it could use it — but the next caller couldn't see it and opened another one. Every eviction race cost the pool a duplicate connection.

## Stamp every handout

The fix gives each slot a small state struct: the connection plus `last_handout`, an `Instant` stamped every time the pool hands the connection out. Eviction keeps a live connection only while it's been requested within `idle_timeout` — which is just the executor's existing `client_ttl` knob, thirty seconds by default, the same one the checked-out pool already used:

```rust
fn survives_eviction(&self, now: Instant, idle_timeout: Duration) -> bool {
    let state = self.state.lock().unwrap();
    match state.as_ref() {
        Some(state) if !state.connection.is_discarded() => {
            now.duration_since(state.last_handout) < idle_timeout
        }
        _ => self.connecting.try_lock().is_err(),
    }
}
```

The `_` arm is doing quiet work: an empty slot survives eviction only while a connect is in flight on it. A slot left empty by a failed connect gets collected instead of lingering.

The issue had proposed `Arc::strong_count == 1` as the "nobody holds this" signal, and I tried that first. It doesn't work: the pipelined reader drops its `Arc<SharedClient>` the moment the stream is open (`open_remote_once` returns the stream, not the handle), so the count sits at one while the connection is actively streaming. Strong count measures handles, not usage. Last-handout time measures the thing we actually care about — whether the pool is still routing new work to this connection.

## Re-attaching after the race

For the stranded-connection race, every return path out of `shared()` now passes through `reattach_shared_slot`, which puts the slot back in the map if eviction removed it. The ordering matters: if a *different* slot already reconnected for the same key, the newcomer defers to that live connection instead of replacing it. Two racers produce one connection, not two. Callers already holding the detached slot keep working; their connection closes once they and their in-flight streams finish.

Retiring a connection doesn't kill its streams, which is what makes the whole thing safe. Tonic multiplexes streams over one channel, and the stream holds its own handle to the transport. Eviction only changes when the *pool* lets go. The timeout measures handouts, not stream activity, so a stream running longer than `client_ttl` can briefly overlap with a brand-new connection to the same peer. That's fine — bounding retention is the goal, not minimizing connection count to exactly one at every instant.

## Six tests, including a real shuffle

The new tests cover the discard-preserves-slot reconnect serialization (a burst of retries opens exactly one replacement, and a late discard on the old connection can't kill it), stale-but-live eviction with a fresh handout surviving, failed-connect slot cleanup, and both ends of the mid-connect eviction race.

My favorite is `evict_idle_keeps_open_pipelined_stream_readable`: it stands up a real `PipelinedShuffleWriterExec` against a real gRPC server, opens a stream through the pool, evicts the connection out from under it, verifies the pool's last strong reference is gone — and then has the producer send the final batch, which the orphaned stream still delivers. That's the property the whole design rests on, tested end to end.

My [Ballista PR #2779](https://github.com/apache/datafusion-ballista/pull/2779) merged on November 8, 2026. [Implementation and tests](https://github.com/apache/datafusion-ballista/pull/2779/files). `cargo test -p ballista-core -p ballista-executor --lib client_pool` is green, eighteen tests, six of them new; clippy and rustfmt are clean on both crates.
