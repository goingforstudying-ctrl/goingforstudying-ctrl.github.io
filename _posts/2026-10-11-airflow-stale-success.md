---
layout: post
title: "A delayed success event can fail a healthy task"
permalink: /notes/airflow-stale-success/
categories: [distributed-systems, state-machines]
excerpt: "An Airflow task had already resumed after deferral when the scheduler received an older executor success event. The missing case was QUEUED."
---

An Airflow task had resumed after deferral and was waiting in `QUEUED`. Then the scheduler received an older executor `SUCCESS` event and could send the task down the failure path.

Put yourself in the scheduler's position: the database says this task is queued, while the executor says it succeeded. Both observations can be right. The event described the worker that had exited during deferral; the task state described its continuation. My [Apache Airflow fix, #68741](https://github.com/apache/airflow/pull/68741), merged on July 2, 2026, teaches the existing state guard to recognize that ordering.

## The event arrived after the task moved on

A deferrable task stops its worker execution while waiting for a trigger. The trigger later resumes the task; the scheduler processes executor events separately.

The failing sequence was:

1. The task defers and its worker exits.
2. The trigger resumes the task.
3. The task reaches `QUEUED` for its continuation.
4. The scheduler processes the older executor `SUCCESS` event from the worker's defer exit.

Airflow already handled the case where the continuation was in `SCHEDULED`. It checked `next_method`, the continuation marker, before ignoring the stale success event. By the time this event arrived, the task could already have moved to `QUEUED`.

The patch extends that state check to accept either `SCHEDULED` or `QUEUED`. It still requires an incoming `SUCCESS` and a `next_method` that is not `None`. A queued task without that continuation marker must still go through ordinary state-mismatch handling.

## One regression, with the exception turned off

The new test puts a task in `QUEUED` with `next_method = "execute_callback"` and delivers the stale success event. It checks that the task remains queued, no failure callback is sent, and no unexpected metric is recorded.

Then it removes `next_method` and delivers the same event again. This time, the scheduler must record `scheduler.tasks.killed_externally`.

I like the second half of this test more than a second successful example. It changes the condition that justifies the exception. A patch that ignored too many success events could pass the first half and fail the second.

**Source:** [merged PR, state guard, and regression test](https://github.com/apache/airflow/pull/68741/files).
