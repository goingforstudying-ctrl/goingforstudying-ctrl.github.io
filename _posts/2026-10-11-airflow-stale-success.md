---
layout: post
title: "A delayed success event can fail a healthy task"
permalink: /notes/airflow-stale-success/
categories: [distributed-systems, state-machines]
excerpt: "An Airflow task had already resumed after deferral when the scheduler received an older executor success event. The missing case was QUEUED."
---

A message saying “success” can still cause the wrong state transition if it describes an earlier phase of the task.

My [Apache Airflow fix, #68741](https://github.com/apache/airflow/pull/68741), merged on July 2, 2026, covers that case for a deferred task that has already returned to `QUEUED`.

## The two timelines

A deferrable task can stop its worker execution while waiting for a trigger. The trigger later resumes the task, and the scheduler processes executor events separately.

The failing ordering was:

1. The task defers and its worker exits.
2. The trigger resumes the task.
3. The task reaches `QUEUED` for its continuation.
4. The scheduler processes the older executor `SUCCESS` event from the worker's defer exit.

The current task state and the event refer to different points in the lifecycle. Treating the event as a fresh statement about the queued continuation produces a state mismatch and can fail the task.

## The existing guard was nearly right

Airflow already recognized a variant where the task had returned to `SCHEDULED`. That guard used the continuation marker, `next_method`, to identify the resume-after-deferral case.

The missing state was `QUEUED`. Depending on scheduler timing, the resumed task could already have moved past `SCHEDULED` before the delayed executor event was processed.

The patch extends the existing guard to accept either `SCHEDULED` or `QUEUED`, while retaining two conditions: the incoming event is `SUCCESS`, and `next_method` is set.

Those conditions matter. Ignoring every success event for every queued task would hide unrelated state mismatches. The fix needs to recognize the continuation case without broadening the exception beyond it.

## The negative case makes the test useful

The added regression sets up a queued task with `next_method = "execute_callback"`, then delivers the stale success event. It checks that the task remains queued, no failure callback is sent, and no unexpected metric is recorded.

The test then removes `next_method` and delivers the same event again. This time, it checks that the ordinary state-mismatch handling still records `scheduler.tasks.killed_externally`.

That second half is essential. A test that only asserted “the task did not fail” could also pass for a patch that suppressed too many events. The negative case constrains the exception to the intended lifecycle state.

## A small patch can encode a larger distinction

The implementation change is a small expansion of a state check. The reasoning is about event meaning: is this event about the execution that just ended, or the continuation that has already been scheduled?

An event's status alone cannot answer that. The scheduler needs the current state and the continuation marker to interpret it correctly.

For state-machine bugs, I find it useful to write down both timelines before changing the condition. Then I look for a test that covers the intended exception and another that proves the normal guard still works.

**Source:** [merged PR, state guard, and regression test](https://github.com/apache/airflow/pull/68741/files).
