---
layout: post
title: "When a deferred task gets a spurious retry"
---

Some bugs you can read straight out of a log timeline. [Issue #67287](https://github.com/apache/airflow/issues/67287) against Apache Airflow came with one: a task instance starts at 13:37:14, the worker pauses it as DEFERRED at 13:37:18, and at 13:37:45 the scheduler writes that the task finished with state success while its state attribute is queued — and marks it up_for_retry. The task had done nothing wrong. It deferred cleanly, exactly as designed, and the scheduler punished it with a spurious retry and a misleading failure.

To see why, you have to know how deferral works in Airflow 3. A worker runs a task until it calls `defer()`, then exits and reports success to the executor — "my turn with this task is done." Later, a trigger fires and moves the task instance back to `scheduled`, with `next_method` recording the method to run on resume. The scheduler can then queue it again. The race lives in the gap between those two events: by the time the scheduler processes the executor's success event from the defer exit, the trigger has often already resumed the task. Depending on exactly where the scheduler loop was, the task can have been moved all the way to `queued` by then. In `process_executor_events`, the scheduler saw the stale success, looked at the task's state, found `queued`, and concluded the task must have been killed externally. The guard in `scheduler_job_runner.py` looked like this:

```python
# Resume-after-defer: trigger moved TI to scheduled (next_method set) before we saw the
# executor success from the defer exit for the same try_number.
ti.state == TaskInstanceState.SCHEDULED
and state == TaskInstanceState.SUCCESS
and ti.next_method is not None
```

That branch was added by an earlier fix, #66431, which covered the case where the trigger resumes the task into `scheduled`. It didn't cover `queued` — and the production logs in the issue showed that under load, the resume can land in either state. The same logical race, two outcomes, and only one was being caught. The fix extends the condition:

```python
ti.state in (TaskInstanceState.SCHEDULED, TaskInstanceState.QUEUED)
and state == TaskInstanceState.SUCCESS
and ti.next_method is not None
```

`next_method`, together with the surrounding state and executor-event checks, identifies the resume case this guard handles. The field records the method to run when execution resumes; a task that is plain `queued` with a stale success and no `next_method` does not qualify for this exemption. If the other requeue exclusions also do not apply, the existing mismatch-handling path still runs. Widening the guard to "never fail a queued task on a success event" would swallow those, and the `killed_externally` metric is exactly how operators notice them. The test encodes both halves: the positive case sets a task to `queued` with `next_method` set, injects the stale success into the executor's event buffer, and asserts the task stays `queued` with no callback fired and no metric emitted. The negative case clears `next_method` and asserts the external-kill counter does increment.

The change itself, [PR #68741](https://github.com/apache/airflow/pull/68741), is three lines of condition plus a regression test and a newsfragment. The issue discussion focused on whether the `queued` variant is the same race and not something new — the issue's timeline settled that, with the task resuming into `queued` and failing a few dozen seconds later. Who hits this in production: deployments running the affected Airflow code with deferrable operators under scheduler load, where the timing window between a trigger firing and the scheduler processing executor events gets wide enough to matter. It's timing-dependent, so it tends to show up in exactly the deployments that are hardest to debug — the symptoms are healthy tasks marked up_for_retry, wasted retry slots, and operators chasing alerts for tasks that never actually failed.

Implementation reference: [merged commit](https://github.com/apache/airflow/commit/938f09c60215ce7407c6cf78861805ebef124ed0) (2026-07-02).
