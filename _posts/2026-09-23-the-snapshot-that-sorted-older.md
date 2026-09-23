---
layout: post
title: "The snapshot that sorted older than the one it replaced"
---

Every distributed system eventually learns the same lesson the hard way: wall-clock time is not a monotonic sequence, and the moment you embed it in a sort key, you've signed up for a correctness bug. I ran into a clean instance of this in rqlite, the distributed SQLite database built on HashiCorp's Raft, where a backwards clock step could make the store treat a stale snapshot as its latest state.

Snapshots in rqlite are directories under the store root, and the directory name is the snapshot ID: `term-index-milliseconds`, with an optional generation suffix. That millisecond field is straight from the system clock. Ordering is derived from the name — snapshots sort by term, then index, then that timestamp. Everything that needs to know "what is my newest state?" goes through that ordering: `Newest`, `NewestFull`, `PartitionAtFull`. If the sort lies, all of them lie.

Here's the scenario that breaks it. Reaping is the compaction step: it takes the newest full snapshot plus its accumulated WAL files and consolidates them into one new full snapshot. The consolidated snapshot sits at the same Raft term and index as the snapshot it replaces — same log position, newer content. Same thing happens when the leader ships you a snapshot via `InstallSnapshot` at a term and index you already have. In both cases the new snapshot's identity differs from the old one's only in the timestamp field.

Now step the clock backwards. NTP corrects a drifted clock, a VM gets live-migrated or resumed, someone runs `date` by hand — it doesn't matter which. The new snapshot gets named with an *earlier* millisecond value than the snapshot it replaces. It sorts as older. The store now believes the pre-reap, pre-transfer state is the freshest thing it has. The consolidated snapshot you just wrote is invisible to every code path that asks for the newest.

The first instinct is "use a monotonic clock," but the timestamp has to survive restarts and mean something across processes, so it has to be wall-clock. The fix I landed in [rqlite PR 2812](https://github.com/rqlite/rqlite/pull/2812) takes the other route: keep the wall clock, but floor it against what's already on disk. When naming a new snapshot, find the existing snapshots with the same term and index, take the largest timestamp T among them, and use `max(now, T+1)`:

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

An ID with an unparsable timestamp can't participate in the floor, so it gets ignored rather than poisoning it. When the set is empty — the common case, and every existing caller like `Clone` — the floor is `MinInt64` and behavior is byte-for-byte identical to before.

Two details took actual thought. The first is the read in `Store.Create`. Naming now needs to look at the current snapshot set, and that read has to be consistent with a reap that might be running concurrently — otherwise you scan, get a stale floor, and a reap renames things underneath you before the sink's ID is committed. The store already has an `mrsw` read/write gate for exactly this kind of exclusion, so `Create` scans under a blocking read:

```go
s.mrsw.BeginReadBlocking()
snapSet, err := s.getSnapshots()
s.mrsw.EndRead()
```

The second is that `reapInternal` already scans the store as part of its normal work, so it just reuses the set it has instead of scanning twice. And the old generation-bump collision loop stays in place as a backstop — the floor makes collisions not happen in the cases that matter, but the loop is cheap insurance for anything I didn't think of. `Clone` I deliberately left alone: it errors out on an ID collision instead of relying on sort order, so the bug never reached it.

One satisfying side effect: the two existing name-collision tests changed character. They used to simulate a collision with a fixed clock and expect the generation counter to bump while the timestamp stayed put. With the floor, the same fixed-clock setup now produces a bumped *timestamp* and the generation never increments — the collision the loop was defending against simply doesn't occur anymore. The tests now document the ordering guarantee directly.

The regression tests drive the real paths with a stepped-backwards clock: seed a snapshot at millisecond 1000, move the clock to 500, then call `Store.Create` at the same term and index and assert the sink gets `3-100-1001` and that `ListAll` reports it as newest. Same drill for `Reap` with the clock behind every snapshot in the store. `go test -race ./snapshot/` passes, which matters here because the whole point of the read lock is a concurrent reap.

Who hits this: anyone running rqlite on infrastructure where clocks step — VM migration, aggressive NTP, laptops in test clusters. It's silent when it happens, which is the worst kind: no error, just a store that quietly considers stale state current. The general lesson travels well beyond rqlite, though. A timestamp in an identifier is fine for human readability and rough grouping, but the instant ordering correctness depends on it, you need a floor, a version counter, or a monotonic source — something that cannot go backwards even when the clock does.
