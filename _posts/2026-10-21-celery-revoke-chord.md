---
layout: post
title: "The chord that kept waiting for a revoked member"
permalink: /notes/celery-revoke-chord/
categories: [concurrency, task-queues]
excerpt: "Revoking a chord member through Celery's control API marked it REVOKED but never told the chord. The group result hung on a member that was already gone."
---

Revoking a task is supposed to be boring. You call `app.control.revoke(task_id)`, the worker marks the task REVOKED in the result backend, and everything moves on. That's exactly what happened — except the task was a chord member, and the chord's group result sat there waiting on it forever.

The member looked done. The backend said REVOKED. The chord body never ran.

## Two ways to revoke, only one told the chord

Celery's worker has two paths that revoke a task. The one you get for free is request-side: when the worker discards a revoked request, `Request._announce_revoked` calls the backend's `mark_as_revoked` and passes the request along. The other is the control command, `_revoke()` in `celery/worker/control.py`, which handles `app.control.revoke()` broadcasts. That one used to call:

```python
state.app.backend.mark_as_revoked(
    task_id, reason='revoked', store_result=True
)
```

No request. Which wouldn't matter, except that `BaseBackend.mark_as_revoked()` only runs chord bookkeeping when it gets one:

```python
if request and request.chord:
    self.on_chord_part_return(request, state, exc)
```

`on_chord_part_return` is what stores the member's result and decrements the chord's counter so the group can settle. Skip it, and the chord simply never learns that one of its members is gone. The task is revoked; the chord waits anyway. That's the bug — issue #10526 has the full reproduction, and [the fix is in PR #10527](https://github.com/celery/celery/pull/10527).

## The fix is a lookup, plus three guards

The control handler knows only task ids. The bookkeeping needs the worker's local `Request` objects, so the fix builds a map between them with `_find_requests_by_id()` and passes each request through:

```python
requests_by_id = {
    request.id: request
    for request in _find_requests_by_id(unrevoked_ids)
    if terminate or request not in worker_state.active_requests
}

for task_id in task_ids:
    request = requests_by_id.get(task_id)
    backend = request.task.backend if request is not None else state.app.backend
    backend.mark_as_revoked(
        task_id, reason='revoked', store_result=True,
        request=request)
```

Each piece of that is doing work. `unrevoked_ids` filters out tasks that were already revoked — control commands can be repeated, and chord bookkeeping must not run twice for the same member or the counter gets decremented twice. Active requests are excluded unless `terminate=True`: a plain revoke doesn't stop a task that's already executing, so it will finish and report its real result, and the accounting happens then. Only a terminating revoke kills the task, so only then is it safe to account for it immediately. And the bookkeeping goes through `request.task.backend`, because tasks can override their backend and a chord tracked by a custom backend has to be accounted for in the right place. Unknown ids — tasks this worker never saw — fall back to `state.app.backend` with `request=None`, exactly the old behavior.

There's one more seam. When the worker later discards the revoked request, `_announce_revoked` runs, and it also calls `mark_as_revoked` with the request. Without coordination the member would be reported twice: once by the control handler, once by the announce. So the control path flags the request after a successful backend update:

```python
request._revoked_in_backend = True
```

and `_announce_revoked` skips its backend call when the flag is set. Two revocation paths, one report per member.

## Staging the exact race in a smoke test

The unit tests pin the contract directly: a known request gets passed through, an unknown id gets `request=None`, a custom task backend gets used, and a chord member revoke actually reaches `on_chord_part_return`. Those are cheap and precise, but the bug only bites when the timing lines up, so I wanted a test that forces the real interleaving.

The smoke test does that against a real worker. It sets `worker_concurrency = 1`, then starts a chord of `[long_running_task.s(8), add.s(1, 2)]`. The slow member occupies the single slot while the fast member gets prefetched — its `Request` exists locally even though it hasn't run, which is the exact state the bug needs. The test polls `inspect.reserved()` until the fast member shows up, then revokes it with `app.control.revoke(quick_id)`.

Before the fix, the chord hangs. After it, the chord reaches a terminal state: the group result is FAILURE with `TaskRevokedError`, the revoked member is stored as REVOKED, and the slow member still runs to completion. The whole lifecycle, exercised end to end.

## What I left alone

`revoke_by_stamped_headers` looks adjacent, but when it terminates a task the request path handles the bookkeeping, so I didn't touch it. The change is deliberately narrow: one lookup, one kwarg, one flag.

Who hits this in production: anyone driving cancellation through the control API — admin tooling, watchdog scripts, a "cancel this stuck task" button — while using chords and collecting their results. The failure mode is nasty because it looks like success. The revoked member is genuinely REVOKED; you got what you asked for. You only notice when the chord body never fires and the group result sits in PENDING until whatever timeout you have, or forever. And revocation gets used most when something is already wrong, which is the worst time for a silent hang.

My [Celery PR #10527](https://github.com/celery/celery/pull/10527) merged on September 3, 2026. [Implementation and tests](https://github.com/celery/celery/pull/10527/files).
