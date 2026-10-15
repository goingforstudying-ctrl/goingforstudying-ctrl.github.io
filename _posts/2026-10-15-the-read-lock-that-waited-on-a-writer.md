---
layout: post
title: "The read lock that waited on a writer"
permalink: /notes/the-read-lock-that-waited-on-a-writer/
categories: [concurrency, go]
excerpt: "A load test wedged an MQTT broker's subscriber loop solid. The goroutine dump pointed at an inflight queue that takes RLock twice, and Go's RWMutex turns that into a deadlock the moment a writer shows up."
---

I was load-testing [comqtt](https://github.com/wind-c/comqtt), a Go MQTT broker, with a bunch of QoS 1 publishers aimed at one slow subscriber, and the subscriber's read loop wedged solid. Not degraded — wedged. The goroutine dump showed the client stuck in `Inflight.NextImmediate` and a publisher stuck in `Inflight.Set`, and neither was ever going to make progress again.

Some quick context for the shape of the bug: QoS 1 in MQTT means the broker holds a copy of every outbound message until the subscriber acknowledges it, and re-sends anything unacknowledged on reconnect. That bookkeeping lives in an `Inflight` struct, a map of packets guarded by a `sync.RWMutex`. Publishers call `Set` (a writer) as messages go out; the per-client packet loop calls `NextImmediate` (a reader) to find what's due for resend.

## Two read locks with a writer in between

Here's the deadlock:

```go
func (i *Inflight) NextImmediate() (packets.Packet, bool) {
	i.RLock()
	defer i.RUnlock()

	m := i.GetAll(true) // takes RLock again
	...
}
```

`NextImmediate` acquires the read lock, then calls `GetAll`, which acquires the read lock *again*. Recursive read locking feels harmless — readers don't exclude each other, so what's one more? The catch is in how Go's `RWMutex` treats writers. As soon as a writer is queued, `Lock` documentation says the mutex blocks new readers: that's the writer-starvation guard. So the sequence that kills you is:

1. `NextImmediate` takes the first `RLock`.
2. A publisher calls `Set` and queues as a writer.
3. `NextImmediate` calls `GetAll`, which tries to take the second `RLock` — and blocks, because a writer is waiting.
4. The writer waits for all readers to drain. The reader holds one lock and waits on the writer.

Nobody moves. And because the per-client packet loop in `server.go` hits this resend path whenever the inflight map is non-empty and send quota is free, one unlucky interleaving hangs the entire client session. That's exactly what the load test found: enough QoS 1 traffic that a `Set` reliably landed in the gap.

The fix is the standard one — split the function into a locking wrapper and a no-lock variant, and use the no-lock variant when you already hold the lock:

```go
func (i *Inflight) GetAll(immediate bool) []packets.Packet {
	i.RLock()
	defer i.RUnlock()
	return i.getAllNoLock(immediate)
}

// NextImmediate now locks exactly once:
func (i *Inflight) NextImmediate() (packets.Packet, bool) {
	i.RLock()
	defer i.RUnlock()
	m := i.getAllNoLock(true)
	...
}
```

Every public method keeps its old locking contract; nothing else in the package had to change.

## The quota that counted to 65 out of 64

While staring at the file, two more things looked off. The quota helpers did load-then-add:

```go
if atomic.LoadInt32(&i.sendQuota) > 0 {
	atomic.AddInt32(&i.sendQuota, -1)
}
```

Each operation is atomic on its own, but the pair isn't. Two goroutines can both observe quota 1, both decrement, and land at -1 — or both observe 63 of 64 free, both increment, and land at 65. Publishers targeting the same subscriber run on different goroutines, so this isn't theoretical. My stress test with 32 goroutines pushing decrements pushed the send quota to 65 with a configured max of 64. Overshooting the max means the broker hands out send slots that don't exist, which is precisely the flow control QoS 1 is supposed to provide.

The fix is a CAS loop so the bound check and the mutation are one decision:

```go
for {
	q := atomic.LoadInt32(&i.sendQuota)
	if q <= 0 || atomic.CompareAndSwapInt32(&i.sendQuota, q, q-1) {
		return
	}
}
```

I flagged this in the PR as a judgment call — an alternative is to fold quota updates under the existing mutex, which is simpler to reason about but puts the counters on the hot path's lock. CAS keeps them lock-free, and the loop only spins when there's actual contention.

## The sort that wraps every 18 hours

The third one is my favorite because it's so quiet. `GetAll` sorts resends by creation time, and it did so like this:

```go
sort.Slice(m, func(i, j int) bool {
	return uint16(m[i].Created) < uint16(m[j].Created)
})
```

`Created` is an int64 unix timestamp in seconds. Truncating it to `uint16` keeps only the low 16 bits, and 2^16 seconds is about 18.2 hours. So every 18 hours the sort key wraps to zero, and resend-on-reconnect ordering scrambles across the boundary: packets created at timestamps 65534 through 65537 come back ordered 65536, 65537, 65534, 65535. A broker that behaves perfectly all day reorders its resend queue once it crosses the wrap. The fix is one deletion — compare the int64 timestamps directly. If a broker ever runs long enough for int64 seconds to matter, it has much bigger problems.

## Proving each fix with its own failure

Each bug got a regression test that fails on the old code for its own reason. The deadlock test runs a goroutine hammering `Set` in a loop while another calls `NextImmediate` 500 times; on the old code it wedges immediately and dies on a 10-second timeout, and on the fixed code it finishes in about 0.2 seconds. The quota tests run 32 goroutines through 2000 increments and decrements and assert the counter lands exactly on the bound — 0 or 64, never past it. The sort test inserts packets at timestamps straddling 65536 and asserts they come back in insertion order. The full package passes under `go test ./mqtt/ -race -count=1`.

Who hits this in production: anyone running comqtt with QoS 1 traffic and slow consumers — the deadlock needs a writer to land in a nanosecond-scale gap, which load testing found in seconds. The quota drift shows up under any fan-in of concurrent publishers to one subscriber. The ordering bug only needs uptime.

My [comqtt PR #174](https://github.com/wind-c/comqtt/pull/174) merged on October 15, 2026. [Implementation and tests](https://github.com/wind-c/comqtt/pull/174/files).
