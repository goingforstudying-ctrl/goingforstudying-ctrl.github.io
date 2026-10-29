---
layout: post
title: "The unmount that lost to EBUSY"
permalink: /notes/the-unmount-that-lost-to-ebusy/
categories: [linux, containers, go]
excerpt: "Dagger's executor cleanup responded to a failed unmount by recursively deleting through the mount that was still alive. The fix was a smaller syscall: os.Remove."
---

The issue report read like a ghost story. Four Dagger engine sessions had finished their work, their cleanup had failed with `device or resource busy`, and their rootfs mounts were still sitting there long after. That's the visible part. The invisible part is what the cleanup did next: it kept going, and it deleted the contents of those still-mounted filesystems on its way down.

The reporter on [dagger#14744](https://github.com/dagger/dagger/issues/14744) had done the work already — a deterministic repro with a tmpfs, a sentinel file inside it, and a child process holding the mount busy. Unmount returns EBUSY, `os.RemoveAll` runs anyway, the sentinel is gone. I read through the cleanup chain on main and the failure mode checked out, so I put together [the fix](https://github.com/dagger/dagger/pull/14811).

## Two cleanups, one wrong assumption

`setupRootfs` builds a container rootfs by creating a temp dir, mounting into it, and registering cleanup callbacks as it goes. The registration order looks innocent:

```go
state.cleanups.Add("remove rootfs temp dir", func() error {
    return os.RemoveAll(state.rootfsPath)
})
// ... mount into rootfsPath ...
state.cleanups.Add("unmount rootfs", func() error {
    return mount.Unmount(state.rootfsPath, 0)
})
```

`Cleanups.Run` walks the list in reverse — unmount first, then remove — which is the right order. The subtle part is the second half of its contract: it accumulates errors and keeps going. That's usually what you want from a cleanup stack; one failure shouldn't skip the remaining teardown. But combined with `RemoveAll`, it means an EBUSY from the unmount doesn't even slow the removal down. The remove walks straight into a mount that's still alive.

Here's the thing about `os.RemoveAll` on a mountpoint: it can't unlink the mountpoint itself while the mount is busy, but nothing stops it from unlinking everything *inside* it first. The syscall walks the tree through the live filesystem, deletes the contents, and only then fails on the directory itself. So you get the worst of both worlds — the mount leaks anyway, and whatever the mount was holding is destroyed. In the incident report, the process holding those mounts was never identified. It didn't need to be; the deletion-through-the-mount is a defect regardless of who the holder is.

## Let the filesystem say no

The fix leans on an invariant the filesystem already enforces: you cannot remove a non-empty directory. Both removals now go through a helper that is deliberately boring:

```go
// removeMountTempDir removes a temporary directory that served as a mount
// target. It deliberately does not recurse: the directory is only empty when
// the earlier unmount cleanup succeeded, so a plain os.Remove is enough.
func removeMountTempDir(path string) error {
	return os.Remove(path)
}
```

Walk the two cases. Unmount succeeded: the stubs were already cleaned out of the mounted filesystem, the temp dir is empty, `os.Remove` succeeds — exactly the old behavior. Unmount failed with EBUSY: the mount is live, the dir is non-empty from the kernel's point of view, `os.Remove` comes back with ENOTEMPTY, and whatever the mount holds stays put. The error still surfaces through the normal joined-error path, so nothing about failure reporting changes. The cleanup still fails loudly — it just stops being destructive while it does it.

I considered two alternatives and rejected both. Reordering the registrations doesn't help: the remove has to happen after the unmount, and the problem was never the order — it was running a recursive delete whose precondition (the mount is gone) had just demonstrably failed. The other option was making `Cleanups.Run` stop at the first error. That changes semantics for every caller of a shared utility, and a fail-fast cleanup stack trades data loss for resource leaks — the remaining cleanups would never run. Shrinking the syscall keeps the blast radius to these two call sites.

While I was in there, I audited the other temp-dir removals for the same hazard. The runc pidfile dir and the resolv.conf/hosts temp files aren't mount targets, so `RemoveAll` on them reduces to `Remove` anyway. The rro probe mounts inside a private namespace on a locked thread, and those mounts never exist in the namespace that runs its `RemoveAll`. The overlay volatile check only ever endangers its own throwaway probe dirs. The rootfs and meta mount paths were the only two with a live-mount descendant.

## Proving the ordering, not just the helper

`TestRemoveMountTempDir` covers the helper's two cases directly — empty dir goes away, non-empty dir survives with its sentinel. The more valuable test drives the real `Cleanups` machinery in the real registration order, with an unmount stubbed to return EBUSY:

```go
c.Add("remove rootfs temp dir", func() error { return removeMountTempDir(rootfsPath) })
c.Add("unmount rootfs", func() error { return unix.EBUSY })

err := c.Run()
require.ErrorIs(t, err, unix.EBUSY)
require.FileExists(t, sentinel)
```

The error still propagates, the sentinel survives, and the test fails against the old `RemoveAll`. That's the regression shape I wanted: not "the helper works" but "the cleanup stack, run in production order, is no longer destructive when an unmount loses."

Who hits this in production? Anyone whose Dagger engine cleans up an exec while something still holds the rootfs — a leaked process with its cwd inside, a mount that outlived its session for reasons you haven't found yet. EBUSY on unmount is rare but not exotic on a busy executor, and the pre-fix behavior turned "a mount leaked, go investigate" into "a mount leaked and its contents were silently shredded." The full `engineutil` suite passes with the change, and the merged PR is [dagger#14811](https://github.com/dagger/dagger/pull/14811). Sometimes the whole fix is admitting that the smaller syscall was the correct one all along.
