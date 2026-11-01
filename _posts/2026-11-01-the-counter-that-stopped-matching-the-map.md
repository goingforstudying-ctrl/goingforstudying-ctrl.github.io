---
layout: post
title: "The counter that stopped matching the map"
permalink: /notes/the-counter-that-stopped-matching-the-map/
categories: [concurrency, go]
excerpt: "memos' in-memory cache kept its entry count in a separate atomic from the sync.Map it described. Under concurrent expiry the two drifted apart, and the size cap quietly stopped existing."
---

I was reading through `store/cache` in memos while chasing something else entirely, and the shape of the code bothered me. The cache is a `sync.Map` plus an `atomic.Int64` named `itemCount`, and the invariant is obvious: the counter should always equal the number of keys in the map. The problem is that nothing enforced it. Every map mutation and every counter update happened as two separate operations, and under concurrency the pair drifted apart in four different directions.

The drift that matters most starts in `Get`. When a read hits an expired entry, the old code removed it and paid the count down, unconditionally:

```go
if time.Now().After(itm.expiration) {
    c.data.Delete(key)
    (&c.itemCount).Add(-1)
    ...
}
```

Two goroutines can read the same expired key at the same time. Both observe it, both delete, both decrement. One entry left the map; the counter went down by two. The background sweeper races readers the same way. Run that long enough and `Size()` drifts below the true count, which sounds harmless until you follow the counter to its other job: the `MaxItems` check in `SetWithTTL`. The eviction guard asks `itemCount > MaxItems` before calling `cleanupOldest`. With the count stuck artificially low, that question never comes back yes. The sweeper stops running, and a cache with a configured cap grows past it for as long as the server stays up. A slow, silent leak in exactly the component whose entire job is bounding memory.

## The same line that over-counts also eats fresh writes

That `Delete(key)` removes whatever is currently stored under the key, not whatever the goroutine looked at. So: `Get` observes expired entry E1, a concurrent `Set` publishes fresh entry E2 under the same key, and then the reader's `Delete` fires. E2 is gone. No eviction callback, and the decrement pays down a count that `Set` had already accounted for. The cache accepted a write and then lost it a microsecond later. From the caller's perspective: you set a key, read it back, and it isn't there.

The writers had their own version. `SetWithTTL` did `Load`, decided whether the key existed, then `Store`. Two writers on the same new key both take the "doesn't exist" branch and both increment. Now the count runs high, which flips the failure over: the eviction guard trips early and `cleanupOldest` starts throwing out live entries. And for a final bit of variety, `Close` used a `select`/`default` to decide whether to `close(stopChan)`. Two concurrent callers could both fall into the default branch. Closing a closed channel is a panic, so a racy shutdown could take the process down with it.

## Pairing every decrement with a removal you actually did

The fix, in [my PR #6513](https://github.com/usememos/memos/pull/6513), is to stop treating the counter as a thing you adjust near map operations and start treating it as a derived property of the map's contents. The trick is storing `*item` instead of `item`, so every entry has a pointer identity, and then leaning on `sync.Map`'s compare-and-delete (it's had `CompareAndSwap` and `CompareAndDelete` since Go 1.20). The expired-read path becomes:

```go
if c.data.CompareAndDelete(key, value) {
    (&c.itemCount).Add(-1)
    ...
    return nil, false
}
// The expired entry was replaced while we looked at it;
// loop and read the fresher one.
```

`CompareAndDelete` only removes the entry if the map still holds that exact pointer. The decrement now happens exclusively in the goroutine that performed the removal, so fifty racing readers of one expired key produce exactly one decrement. And if a fresh `Set` swapped the entry in between, the CAS fails, the loop goes around, and the reader returns the fresh value. The write-eating bug dies because nobody deletes by key blindly anymore.

Writes use the same discipline from the other side. Replacing an existing key is a `CompareAndSwap` against the observed old pointer, with no count change. Inserting a new key reserves the count *before* publishing:

```go
(&c.itemCount).Add(1)
if _, loaded := c.data.LoadOrStore(key, entry); !loaded {
    break
}
(&c.itemCount).Add(-1) // another writer published first; undo and retry
```

The reservation ordering is deliberate: a concurrent remover can never decrement a count that hasn't been incremented yet. Every increment pairs with a publish this goroutine completed; every decrement pairs with a removal it completed. The invariant holds by construction rather than by luck.

`Close` got the boring fix it needed: an `atomic.Bool` compare-and-swap, so exactly one caller closes the channel and waits for the cleanup goroutine to exit, and everyone else returns nil. No more double-close panic.

## The one place the count is allowed to lie

The reservation scheme has a consequence worth a paragraph. Between `Add(1)` and `LoadOrStore` succeeding, the counter transiently over-counts: it claims an entry exists that isn't published yet. If `cleanupOldest` trusted `itemCount` in that window, it could evict live entries off the strength of a phantom. So the eviction path no longer trusts the counter at all. It counts published entries itself, during the same `Range` scan that picks the eviction candidates, and only evicts through `CompareAndDelete` on the pointer it observed. The counter remains the cheap check for "are we maybe over the limit"; the scan is the authority for "should we actually evict." One of the regression tests fakes an in-flight reservation with a manual `itemCount.Add(1)` and asserts the live entry survives — that test fails if anyone ever "simplifies" the scan back to trusting the counter.

I did consider the obvious alternative: one mutex around the whole cache. It would have been a tenth the code and much easier to reason about. But it serializes reads, and the entire reason this cache is built on `sync.Map` is a lock-free read path on a read-heavy workload. The CAS version keeps reads exactly as cheap as they were. Only mutators pay for the retry loops, and only when they genuinely race.

The tests are the part I'm happiest with. Each failure mode got a dedicated `-race` test that fails on master: thirty-two readers racing one expired key across fifty rounds must produce exactly fifty eviction callbacks and a size of zero; sixteen workers overwriting eight keys two hundred times must settle at exactly eight; a hundred rounds of a stale `Get` racing a fresh `Set` must never lose the fresh value; sixteen goroutines calling `Close` together must not panic. Deterministic enough to run in CI, racy enough to have caught the originals.

Who actually hits this? Any long-running memos server under concurrent API load. A cache stampede on a hot key is the normal case, not the pathological one — several requests expiring the same entry at the same time is precisely what caches are for. Each race nudged the counter a little further from reality, the cap check drifted with it, and the "my cache is bounded" assumption stopped holding without anything logging a word about it.

The merged diff is at [usememos/memos#6513](https://github.com/usememos/memos/pull/6513/files) — about sixty lines of cache logic and two hundred sixty lines of tests that now keep the counter honest.
