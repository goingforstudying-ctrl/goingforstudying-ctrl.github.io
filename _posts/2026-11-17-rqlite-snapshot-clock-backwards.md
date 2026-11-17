---
layout: post
title: "The clock went backwards and the snapshots lied about their order"
permalink: /notes/rqlite-snapshot-clock-backwards/
categories: [distributed-systems, consensus]
excerpt: "rqlite snapshot IDs embed a wall-clock timestamp. If the clock steps backwards between two snapshots at the same term and index, the newer one sorts as older."
---

Snapshot IDs in rqlite embed three things: the Raft term, the Raft index, and a wall-clock millisecond timestamp. The sort order that decides which snapshot is "newest" uses all three. When two snapshots share a term and an index, the timestamp breaks the tie.

That design is fine as long as the wall clock is honest. The bug shows up when it isn't.

The trigger is any event that steps the clock backwards: an NTP slew that ends up as a step, a VM migration, a manual `date` adjustment, a host resuming from a long pause with a skewed RTC. Between the step and the next snapshot, rqlite can produce a snapshot whose timestamp is *earlier* than the snapshot it's replacing — same term, same index, smaller msec field. From the sort order's point of view, the newer state looks older.

## Where the wrong order actually bites

The snapshot store keeps a set of on-disk snapshots and answers questions like "give me the newest one" or "give me the newest full snapshot." Those queries feed real decisions: which snapshot to restore from on startup, which one to send to a follower that's fallen behind, which ones are safe to reap.

If the order is wrong, a stale snapshot can win "newest." A follower catching up via snapshot transfer gets handed an older state than the leader actually has. The store treats it as the latest and proceeds. Nothing crashes; nothing logs a warning. The system just quietly walks backwards.

The specific path the original issue describes involves reap: rqlite reaps old snapshots, then creates a new one. If the clock has stepped backwards in between, the new snapshot can sort *before* the snapshot it replaces. Now the store's idea of "latest" points at the older data.

I find this shape of bug uncomfortable in a particular way. Everything downstream of the sort order trusts it completely. The order is the invariant. If you break it, the failures show up one or two layers removed from the actual mistake, in code that has every reason to assume the sort was correct.

## The fix is a floor, not a clock correction

The natural first instinct is "make the clock monotonic." That's not really a thing rqlite can do — it gets its time from the operating system, and the operating system is allowed to step backwards. Trying to detect and compensate for every possible clock behavior inside the namer turns a simple component into a time-keeping subsystem.

The cleaner fix is local: when naming a new snapshot, look at the snapshots that already exist at the same term and index. Find the largest timestamp among them. Use `max(current_time, largest + 1)` for the new name.

```go
func (sn *SnapshotNamer) MakeName(set SnapshotSet, term, index uint64, gen int64) string {
    minMsec := int64(math.MinInt64)
    if newest, ok := set.WithTermIndex(term, index).Newest(); ok {
        if _, _, msec, _, err := ParseSnapshotName(newest.id); err == nil {
            minMsec = msec + 1
        }
    }
    return sn.makeName(term, index, gen, minMsec)
}
```

The floor lands in a single private helper, `makeName`, which takes the wall-clock reading and raises it to `minMsec` if the clock is below the floor. The change is small but it converts a global assumption ("wall clock goes forward") into a local guarantee ("a new snapshot at this term and index always sorts after the existing ones"). The clock can do whatever it wants. The order still holds.

The floor is only consulted when there's an existing snapshot at the same term and index, so the common case — a fresh term/index pair — behaves exactly as before. No extra work, no extra allocation, just the same name it would have made anyway.

## Placing the read is the tricky part

The namer needs to see the current set of snapshots, but the set is mutable. A reap can be in flight at the same moment `Store.Create` is naming a new snapshot. If the create reads the set, then a reap runs, then the create finishes writing — the new snapshot was named against a state of the world that no longer exists, and the floor guarantee is gone.

The fix has to be careful about locking. `Store.Create` now scans the snapshot directory under a read lock, so its view of "what exists at this term and index" can't race with a concurrent reap that's about to remove things. `reapInternal` gets the same treatment in reverse: when it needs a name for the snapshot it's about to write, it reuses the set it already scanned, rather than asking for a fresh one.

I left `Clone` alone. It doesn't rely on sort order the way `Newest` does — it errors out on an ID collision directly — so it doesn't benefit from the floor. Changing it would have been motion without effect.

There's also still a generation-bump loop as a backstop. If two names collide on disk, the store bumps a generation counter and retries. That stays. The floor prevents the *ordering* bug; the generation loop prevents the *collision* bug. They solve different problems and both are cheap.

## The tests pin the clock and step it backwards

The namer takes a `nowFn` — a function that returns the current time — so tests can drive it with a fixed clock. That's been there since before this patch. What's new is using it to set up the failure case directly: create a snapshot at time T, step the clock backwards to T−Δ, create another snapshot at the same term and index, and assert the second one sorts after the first.

Two regression tests do that against the real `Store`. One drives `Create` with a stepped-back clock and checks the resulting ID has the floor-applied timestamp. The other drives `Reap` the same way — reap produces a new snapshot internally, so the same path has to hold. Both fail without the patch and pass with it.

The unit tests around the floor itself cover the edge cases that the integration tests don't reach cleanly: what happens when the clock is ahead of every existing snapshot (the floor is ignored), when the set is empty (no floor), when the newest existing ID doesn't parse (fall back to no floor rather than crash), and when a generation number is supplied alongside the floor (both fields land correctly).

## Who runs into this

Anyone running rqlite on infrastructure where the clock isn't a guarantee. VMs that migrate between hosts. Containers on hosts with aggressive NTP corrections. Anything that suspends and resumes. The window is narrow — you need a snapshot at the same term and index to land within the stepped-back interval — but the consequence is the store restoring or shipping the wrong state, which is the kind of thing you don't notice until much later.

The patch doesn't try to detect bad clocks. It just removes the assumption that the wall clock is part of the correctness story.

My [rqlite PR #2812](https://github.com/rqlite/rqlite/pull/2812) merged on September 22, 2026. [Namer change and clock-stepping tests](https://github.com/rqlite/rqlite/pull/2812/files).
