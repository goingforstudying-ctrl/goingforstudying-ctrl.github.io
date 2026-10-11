---
layout: post
title: "A cleanup path is still a concurrent caller"
permalink: /notes/celery-pubsub-concurrency/
categories: [concurrency, task-queues]
excerpt: "Celery's result drainer and result cleanup shared a Redis pub/sub object. Correct unsubscribe behavior still needed a concurrency boundary."
---

A result consumer can have a reader, a subscriber, and an unsubscriber touching the same connection. Calling the last one “cleanup” does not give it exclusive ownership.

My [Celery fix, #10671](https://github.com/celery/celery/pull/10671), merged on September 21, 2026, serializes access to the Redis result backend's shared pub/sub object. The failure was a race between normal result polling and paths that subscribe or remove a result.

## Two paths, one socket

The result drainer calls `get_message()` to poll for task updates. Meanwhile, `AsyncResult.__del__` can reach `remove_pending_result`, then `cancel_for`, then `pubsub.unsubscribe()`.

Those paths can overlap. Redis-py pub/sub objects are not safe for concurrent use, and the PR describes a gevent failure reported as `ConcurrentObjectUseError`: the socket was already in use by another greenlet.

The important boundary is the shared object. Cleaning up a result is a valid operation, and reading its updates is a valid operation. Their independent correctness says nothing about whether they can use the same socket at the same time.

## Why the patch uses a reentrant lock

The patch introduces an `RLock` on `ResultConsumer` and protects pub/sub lifecycle operations, subscription changes, polling, and reconnection.

Reentrancy is required by the call graph. While processing a message, the drainer calls `on_state_change`; if the task is ready, that can call `cancel_for`. The reader therefore enters a path that needs the same lock again. A non-reentrant mutex would deadlock on that nested call.

Reconnection also reaches nested consumer operations. Lock selection has to follow those paths, rather than just the two lines visible in the original crash.

## Two details keep the lock boundary honest

First, the sleep used when no pub/sub object exists remains outside the lock. There is no shared pub/sub operation to protect during that idle wait. Holding the lock would delay another caller trying to start consumption.

Second, `on_after_fork` replaces the inherited lock before cleanup. A child process can inherit a lock held by a thread that did not survive the fork. Reusing that lock would introduce a different failure while trying to prevent the original one.

These details come from resource ownership: which object is shared now, and which execution context can still release its lock?

## Serialization has a visible cost

The drainer holds the lock while polling. A concurrent subscribe or unsubscribe has to wait for the poll to return; the PR discusses a drainer poll timeout of up to one second.

That cost is part of the change. The patch introduces a single serialization point for socket access. Giving the drainer sole ownership and sending subscription commands through a queue would be a broader design with different tradeoffs.

## Test the overlap, then the boundary

The merged unit tests use a fake pub/sub object that records overlapping calls. Several worker threads subscribe and unsubscribe while a drainer polls. That directly exercises the condition the lock is meant to prevent.

Separate checks verify that the relevant operations hold the lock, idle sleep does not, and fork cleanup replaces it. Integration tests exercise concurrent result collection and subscription churn against Redis.

The fake is useful for observing ownership violations; the integration coverage addresses socket behavior the fake cannot model. This note describes the coverage in the merged PR, not a claim that every deployment or concurrency configuration was tested.

The general question I take from this fix is simple: every path that touches a shared resource belongs in its concurrency model, including cancellation, finalization, and recovery.

**Source:** [merged PR and tests](https://github.com/celery/celery/pull/10671/files).
