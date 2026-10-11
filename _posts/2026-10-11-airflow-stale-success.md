---
layout: post
title: "A late success sent Airflow down the failure path"
permalink: /notes/airflow-stale-success/
categories: [distributed-systems, state-machines]
excerpt: "The worker's success report was accurate. By the time the scheduler read it, the task had already resumed, and the state guard was one state short."
---

`SUCCESS` is an odd event to blame for a failed task. In this Airflow race, the worker's success report was accurate. It described the worker exiting after deferral. By the time the scheduler read that report, the task had already resumed and was queued to continue.

The scheduler saw a mismatch: a queued task and a success event. Its failure path made sense for other mismatches, but here it could punish a task for having moved on before the event was processed.

## The task had a head start

A deferrable task stops its worker execution while it waits for a trigger. The trigger can later resume the task independently of when the scheduler processes the old executor event. That gives this ordering room to happen:

1. The task defers and its worker exits.
2. The trigger resumes the task.
3. The task reaches `QUEUED` for its continuation.
4. The scheduler processes the older executor `SUCCESS` event from the worker's defer exit.

The old event and the current database state describe different moments in the same task's execution. Comparing their state names alone loses that history.

## The guard stopped at `SCHEDULED`

Airflow already recognized this race when the resumed task was still `SCHEDULED`. The guard looked for `next_method`, the continuation marker, before ignoring the stale success. The missing case was a continuation that had advanced one state further, to `QUEUED`.

I extended the check to accept either state. The other conditions stay specific: the incoming event must be `SUCCESS`, and `next_method` must not be `None`.

This is the part of the patch I wanted to keep small. A queued task without a continuation marker can still represent a real state mismatch. Teaching the scheduler about this ordering shouldn't make it ignore that case.

## The test gets more useful when the marker disappears

The regression starts with a queued task and `next_method = "execute_callback"`, then delivers the old success event. The task must remain queued. No failure callback should be sent, and no unexpected metric should be recorded.

That proves the reported race is handled. Then the test removes `next_method` and delivers the same event again. Now the scheduler must record `scheduler.tasks.killed_externally`.

I like that second half because it asks the fix to stop helping. A guard that ignored every queued-task success could pass the first half. Removing the marker exposes that overly broad fix without needing a different scenario.

The implementation change is a state check. Most of the explanation lives in the ordering above and in the test that removes the reason for the exception.

My [Apache Airflow PR #68741](https://github.com/apache/airflow/pull/68741) merged on July 2, 2026. [State guard and regression test](https://github.com/apache/airflow/pull/68741/files).
