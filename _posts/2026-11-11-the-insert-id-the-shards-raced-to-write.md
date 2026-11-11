---
layout: post
title: "The insert id every shard wrote at once"
permalink: /notes/the-insert-id-the-shards-raced-to-write/
categories: [concurrency, databases]
excerpt: "A one-line field write in Vitess's vtgate was tripping the race detector, and the comment above the function swore it couldn't happen."
---

After the ExecuteOptions race fix landed in Vitess's vtgate, I went back through the streaming path to see what else touched shared session state without taking a lock. I didn't have to look long. A streamed scatter query under the race detector produced a `WARNING: DATA RACE` on `SafeSession.LastInsertId`, and the writer was `wrapCallback` in the executor context package: a single line that assigns a result's insert id straight onto the session.

What made it worse is that the codebase had been asserting the opposite. The comment above `StreamExecuteMulti` claimed the callback "will not be called concurrently by multiple go routines, through processOneStreamingResult." That guarantee is real for one specific path, the message stream, but it does not cover the general callback. Every shard stream runs in its own goroutine and invokes the callback directly. The comment was a promise the code didn't keep.

## One goroutine per shard

`StreamExecuteMulti` fans a query out to every shard and runs one goroutine per shard. When a shard's stream produces a result with `InsertIDUpdated()` set, that goroutine calls the wrapped callback straight away. Nothing serializes those calls. A `select last_insert_id(id) from user` in OLAP mode across several shards is enough: several goroutines, one session field, no mutex.

The same shape exists in the buffered path. A `UNION ALL` outside a transaction runs each source concurrently through `Concatenate.parallelExec`, which lands in `ExecutePrimitive` and `ExecuteMultiShard`. Both had their own copies of the same direct write, and `ExecuteStandalone` had a fourth:

```go
if res != nil && res.InsertIDUpdated() {
    vc.SafeSession.LastInsertId = res.InsertID
}
```

## The setter was already there

The fix turned out to be small, because the locked setter already existed:

```go
func (vc *VCursorImpl) SetLastInsertID(id uint64) {
    vc.SafeSession.mu.Lock()
    defer vc.SafeSession.mu.Unlock()
    vc.SafeSession.LastInsertId = id
}
```

The session type is documented as a mutex-protected version of the proto session, and the other accessors that read session state do so under that same mutex. So the bare write wasn't just racing against other writers; it was racing against every locked reader too. My patch in [PR #21639](https://github.com/vitessio/vitess/pull/21639) routes all four remaining direct writes through the setter, and rewrites the misleading comment in `scatter_conn.go` to state what the code actually does:

```go
if res != nil && res.InsertIDUpdated() {
    vc.SetLastInsertID(res.InsertID)
}
```

## Which id wins

The honest caveat is that the mutex doesn't decide which shard's id wins. It never did, and it still doesn't. The lock makes the concurrent write well-defined under the Go memory model; the winner remains whichever goroutine happens to write last.

For last-insert-id semantics across a sharded stream, that's the same observable behavior as before. On the platforms Vitess supports, a uint64 store doesn't tear, so no user ever saw a corrupted value. This race was silent: undefined behavior that only a race-instrumented build would ever catch. That's also why I didn't bother trying to make the winner deterministic. Deciding which of several concurrent streams "owns" the last insert id would have been a semantic change, and a strange one to smuggle into a fix like this.

I briefly considered an atomic store instead. It would have fixed the race too, but it would have left the field with two write disciplines: lock for some callers, atomics for others. The setter approach gives the field one rule, and the diff stays close to a mechanical substitution.

## Making the race deterministic

Race bugs that only appear under load are miserable to prove fixed, so both regression tests hammer the write from 32 goroutines at once. `TestWrapCallbackLastInsertIDConcurrent` drives the wrapped stream callback with insert-id-bearing results, with and without inter-op stats enabled. `TestExecuteMultiShardLastInsertIDConcurrent` drives `ExecuteMultiShard` itself, which is the buffered `UNION ALL` shape. Both trip the detector on the old code and pass on the new.

The assertions are deliberately `NotZero`: any writer may win. What's under test is the absence of a data race, not the ordering, and writing the test that way keeps the intent honest.

This was the third race of the same family to surface in that corner of vtgate, after the concurrent map write and the shared ExecuteOptions race. Each one was a single field or line that had simply never been put under the session's locking discipline. The sharding layer that grew out of YouTube's MySQL stack has a lot of concurrency, but this bug wasn't exotic. It was a one-line write and a comment that had drifted from the code.
