---
layout: post
title: "When revoking one task hangs the whole chord"
---

Revoking a reserved member of a Celery chord can leave the group waiting when the control path records REVOKED without notifying the chord backend. [Issue #10526](https://github.com/celery/celery/issues/10526) and its fix focus on a task the worker already knows about, rather than every possible revoke request.

The bug is an asymmetry between two code paths that are supposed to do the same thing. When a task is revoked on the worker side, `Request._announce_revoked()` calls the backend's `mark_as_revoked()` with the request object attached, and the backend uses that to do chord bookkeeping:

```python
if request and request.chord:
    self.on_chord_part_return(request, state, exc)
```

That call is how a chord accounts for a member that died: `on_chord_part_return` invokes the backend's chord-completion bookkeeping, whose implementation depends on the result backend. But the control command path went through `_revoke()` in `celery/worker/control.py`, which called the backend without a request:

```python
state.app.backend.mark_as_revoked(task_id, reason='revoked', store_result=True)
```

No request, no `.chord` attribute, no bookkeeping. The backend can store REVOKED for the task id without advancing the chord accounting associated with that request. One member of the group is now in a terminal state the chord can't see, so the chord waits indefinitely, and nothing logs an error. The system just quietly stops making progress.

The fix gives the control path the same information the worker-side path has always had. `_revoke()` already had access to `_find_requests_by_id()`, a helper that maps task ids to the requests the worker currently knows about, so the change builds that map and passes the request through. This excerpt omits exception handling and the subsequent bookkeeping flag:

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

There's one more subtle piece. After the backend call returns without an exception, `_revoke()` sets `request._revoked_in_backend = True`. Later, when the worker discards the revoked task, `_announce_revoked()` checks that flag and skips the `mark_as_revoked()` call it would otherwise make, so the member isn't reported to the chord a second time.

The PR adds a smoke test with a real worker alongside the unit coverage. The tricky part is that the bug only triggers when the worker already knows the request locally. The issue treats tasks not yet consumed by a worker, for which no local request exists, as a separate limitation. This patch does not establish that all such cases are safe. So the smoke test pins worker concurrency to 1, starts a chord whose first member blocks for 8 seconds, waits until the second member is prefetched and reserved, and then revokes it through the control command. The regression expectation is that the chord reaches a terminal state instead of waiting indefinitely. The revoked member is stored as REVOKED, the blocking member runs to completion, and the chord's callback fails with TaskRevokedError, which is the expected way to account for a member that was revoked out from under you.

I left `revoke_by_stamped_headers` alone: it has a different shape, and its termination goes through the request path anyway.

This is relevant when control code revokes a chord member already reserved on a worker. Active tasks, requests still at the broker, termination, and repeated revocations take different paths, so the request bookkeeping and duplicate-report guard matter. The full report is [#10526](https://github.com/celery/celery/issues/10526); the fix merged in [#10527](https://github.com/celery/celery/pull/10527).

Implementation reference: [merged commit](https://github.com/celery/celery/commit/a7d9c79688d3b5dd527fe2b2228b3041a6a602ac) (2026-09-03).
