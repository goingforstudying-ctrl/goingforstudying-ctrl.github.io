---
layout: post
title: "When revoking one task hangs the whole chord"
---

I was digging through Celery's worker control commands to understand how revoke interacts with chords, and found a hole that's easy to step into. Revoke a single member of a chord through `app.control.revoke()` while the worker already has the task locally, and the chord just sits there forever. The member gets marked REVOKED in the result backend, but the chord never learns about it, so the group keeps waiting for a task that will never run.

The bug is an asymmetry between two code paths that are supposed to do the same thing. When a task is revoked on the worker side, `Request._announce_revoked()` calls the backend's `mark_as_revoked()` with the request object attached, and the backend uses that to do chord bookkeeping:

```python
if request and request.chord:
    self.on_chord_part_return(request, state, exc)
```

That call is how a chord accounts for a member that died: `on_chord_part_return` updates the internal counter the callback joins on. But the control command path went through `_revoke()` in `celery/worker/control.py`, which called the backend without a request:

```python
state.app.backend.mark_as_revoked(task_id, reason='revoked', store_result=True)
```

No request, no `.chord` attribute, no bookkeeping. The backend dutifully stores REVOKED for the task id, which is technically correct, but the chord's accounting never advances. One member of the group is now in a terminal state the chord can't see, so the chord waits indefinitely, and nothing logs an error. The system just quietly stops making progress.

The fix gives the control path the same information the worker-side path has always had. `_revoke()` already had access to `_find_requests_by_id()`, a helper that maps task ids to the requests the worker currently knows about, so the change builds that map and passes the request through:

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
        task_id, reason='revoked', store_result=True, request=request)
```

A few details in there mattered. The `unrevoked_ids` filter keeps a repeated revoke command from running the bookkeeping twice for members that were already accounted for. Active requests are only passed when `terminate=True`, because a plain revoke doesn't stop a task that's already executing: that task will report its real result when it finishes, and the chord should wait for that result rather than an artificial REVOKED. And the backend is taken from the request when there is one, since a task can override its backend and the bookkeeping has to land in the same place the chord is tracked.

There's one more subtle piece. After the backend runs the bookkeeping, `_revoke()` sets `request._revoked_in_backend = True`. Later, when the worker discards the revoked task, `_announce_revoked()` checks that flag and skips the `mark_as_revoked()` call it would otherwise make, so the member isn't reported to the chord a second time.

Testing this properly meant a smoke test with a real worker, not just unit tests. The tricky part is that the bug only triggers when the worker already knows the request locally. A task still sitting on the broker was never affected, because when it eventually reaches a worker the revoked check runs through the worker-side path, which passes the request. So the smoke test pins worker concurrency to 1, starts a chord whose first member blocks for 8 seconds, waits until the second member is prefetched and reserved, and then revokes it through the control command. Before the fix the chord hangs; after, it reaches a terminal state. The revoked member is stored as REVOKED, the blocking member runs to completion, and the chord's callback fails with TaskRevokedError, which is the expected way to account for a member that was revoked out from under you.

I left `revoke_by_stamped_headers` alone: it has a different shape, and its termination goes through the request path anyway.

The affected audience is anyone whose ops code revokes tasks inside chords through the control API: cleanup jobs, dead-letter sweeps, operators pruning stuck work. Celery is one of the most widely deployed Python task queues, and chords are the standard way to fan work out and aggregate it back, so a hang like this doesn't fail loudly. The callback never fires and the group just sits there until someone notices the backlog. The full report is in [issue #10526](https://github.com/celery/celery/issues/10526), and the fix landed in [this PR](https://github.com/celery/celery/pull/10527).
