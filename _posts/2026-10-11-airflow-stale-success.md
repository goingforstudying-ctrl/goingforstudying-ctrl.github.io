---
layout: post
title: "A late success sent Airflow down the failure path"
permalink: /notes/airflow-stale-success/
categories: [distributed-systems, state-machines]
excerpt: "The worker's success report was accurate. By the time the scheduler read it, the task had already resumed, and the state guard was one state short."
---

The worker reported `SUCCESS`. Airflow could respond by taking the task down its failure path.

The report was accurate: the worker had exited after deferring the task. It was also late. Before the scheduler processed it, the trigger had resumed the task and its continuation had reached `QUEUED`. The event and the database state described different moments in the same execution.

What bothered me was that neither side had to be lying. The scheduler had enough information to recognize the ordering, but its existing guard stopped one state too early.

## Two timelines meet at the scheduler

A deferrable task releases its worker while waiting for a trigger. Resuming the task and processing the worker's executor event can progress independently. That permits this ordering:

{% include deferred-event-order.html %}

By the time the older `SUCCESS` arrives, `QUEUED` describes the continuation. Treating that pair as an ordinary mismatch can punish a task that has already made progress.

For an ML workflow waiting on an external job or an artifact, deferral is a useful way to avoid occupying a worker during the wait. The same lifecycle gives the control plane more than one event to reconcile. A success from one phase doesn't tell the scheduler what the resumed phase should do next.

I find it easier to reason about this race with the events in order than with a list of state names. `SUCCESS` and `QUEUED` sound contradictory in isolation. Place the defer exit before the trigger, and the contradiction disappears.

## The continuation marker narrows the exception

Airflow already handled the resumed task while it was `SCHEDULED`. The existing check also required `next_method`, which identifies the continuation, before ignoring the stale executor success. The missing case was a continuation that had advanced to `QUEUED`.

I extended the state check to include both. Written out, the resume-after-defer exception requires:

```python
(
    ti.state in (TaskInstanceState.SCHEDULED, TaskInstanceState.QUEUED)
    and state == TaskInstanceState.SUCCESS
    and ti.next_method is not None
)
```

Each condition does work. The current state must belong to the resumed path. The arriving event must be a success. The task must still carry a continuation marker. A queued task without that marker can represent a real mismatch and should retain the existing handling.

Keeping those conditions together mattered more to me than making the check shorter. This patch recognizes a specific ordering; it doesn't change the scheduler's general treatment of state disagreements.

## Remove the reason for the exception

The regression sets up a queued task with `next_method = "execute_callback"`, then delivers the older success event. The task must remain queued. The scheduler must send no failure callback and record no unexpected metric.

That checks the race, but a guard that ignored every success for every queued task could pass it too. The second half removes `next_method` and delivers the same event again. This time the scheduler must record `scheduler.tasks.killed_externally`.

That is the assertion I would look for first in review. The test changes only the evidence that justified the exception, then asks the scheduler to resume its ordinary behavior. It makes an overly broad fix visible without needing a second, unrelated setup.

The implementation is a small extension to a state check. Its scope is easier to trust because the regression tests both the continuation and the case where the continuation marker is absent.

When I read orchestration code now, I ask which phase an event belongs to before deciding whether its state conflicts with the database. A pipeline can spend much longer waiting for external work than running Python. Correctly handing that work back to the scheduler is part of keeping the pipeline reliable.

My [Apache Airflow PR #68741](https://github.com/apache/airflow/pull/68741) merged on July 2, 2026. [State guard and regression test](https://github.com/apache/airflow/pull/68741/files).
