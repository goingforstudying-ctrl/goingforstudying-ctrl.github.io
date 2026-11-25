---
layout: post
title: "The startup that blanked the config"
permalink: /notes/backintime-config-wipe-race/
categories: [concurrency, desktop-linux]
excerpt: "Two backup profiles whose cron entries landed on the same minute kept resetting Back In Time to factory state. The culprit was a config rewrite that truncated the file before writing it."
---

Every now and then, Back In Time would start up and claim it had never been configured. All profiles gone, the config file reset to a single empty one, and "Back In Time is not configured!" sitting in the journal like nothing happened. It took me embarrassingly long to connect that to the two profiles I had scheduled whose cron entries fired at the same minute.

When a cron job and the desktop session start Back In Time at the same time, you don't get two processes. You get about four, because the startup spawns systray subprocesses too. All four open the same config file, and that's where the trouble starts.

## The truncate-then-write window

The config module has a helper called `_fix_enum_values()` that exists to repair a legacy bug: old config files sometimes stored enum names (`TimeUnit.YEAR`) instead of their integer values. The helper read the whole file, did string replacements, and then did this on every startup:

```python
path.write_text(''.join(lines))
```

`Path.write_text()` truncates the file before writing. So on every single startup — even when there was nothing to fix, which is almost always — the config file briefly became zero bytes long. `Konfig.save()` had the same shape.

Now line that up with four processes starting together. Process A truncates the file and begins rewriting it. Process B opens it in that exact window, reads zero bytes, builds an empty in-memory config, and happily saves that on exit. The rewrite from A is long gone; B's empty config is what survives. Next launch: "not configured." The profiles were never corrupted — they were read at the wrong moment and then overwritten with nothing.

Once I saw it, the intermittent pattern made sense: it only happened when two schedules collided, and cron's one-minute granularity makes those collisions rare but inevitable.

## Two fixes, because one only shrinks the window

The first part is a new `tools.atomic_write_text()` that writes to a temp file in the same directory and moves it into place:

```python
fd, tmp_name = tempfile.mkstemp(
    dir=path.parent,
    prefix=f'.{path.name}.',
    suffix='.tmp',
)
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    if path.exists():
        shutil.copymode(path, tmp_name)
    os.replace(tmp_name, path)
```

Same directory matters: `os.replace()` is only atomic within a filesystem. The `fsync` before the rename is for the crash case, not the race case — after a power cut you get either the old file or the new one, not an empty directory entry. And `copymode` keeps the existing file's permissions, which a fresh temp file would otherwise lose.

With atomic replace, a concurrent reader sees the old config or the new config, never a truncated one. That alone would have fixed the data loss.

But I didn't want every startup to rewrite the file at all. The second part makes `_fix_enum_values()` track whether any line actually changed:

```python
if not modified:
    return
tools.atomic_write_text(path, ''.join(lines))
```

The common case is "nothing to fix," and in that case the function now does nothing. No write, no window, no wear on the file. The legacy-repair path still works when it needs to — it just stops being a startup tax everyone pays forever for a bug from an old version.

## Proving a race with a stress test

Races are miserable to test if you wait for the real timing. Instead I wrote a stress test that manufactures the timing: one thread saves the config in a loop while three threads read it in a loop, and every read asserts the content is either complete or complete — never truncated. On the old code it fails within a second. With the atomic write it runs clean.

Around that: a test that a config with no legacy values is never rewritten (verified by mocking `atomic_write_text` and asserting it's not called), a test that actual legacy enum names do get replaced with their values, and one that the file mode survives the write. The full module suite passed, and ruff, flake8, and codespell are clean.

The edge case I deliberately left alone: two processes doing atomic writes concurrently can interleave, but each individual write is complete, so the worst outcome is last-writer-wins on whole files — which is the same semantics the file always had, minus the corruption.

Anyone who schedules more than one profile, or has desktop autostart overlapping a cron entry, was exposed to this. My [backintime PR #2653](https://github.com/bit-team/backintime/pull/2653) merged on November 24, 2026, and landed in the 1.7.0 line. [Implementation and tests](https://github.com/bit-team/backintime/pull/2653/files).
