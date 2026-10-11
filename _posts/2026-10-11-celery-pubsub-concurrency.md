---
layout: post
title: "A cleanup path is still a concurrent caller"
permalink: /notes/celery-pubsub-concurrency/
categories: [concurrency, task-queues]
excerpt: "Celery's result drainer and result cleanup shared a Redis pub/sub object. Correct unsubscribe behavior still needed a concurrency boundary."
---

Celery's result drainer could be reading a Redis socket when result cleanup tried to unsubscribe on the same pub/sub object. Under gevent, the failure appeared as `ConcurrentObjectUseError`: another greenlet was already using the socket.

My [Celery fix, #10671](https://github.com/celery/celery/pull/10671), merged on September 21, 2026, serializes those accesses. Follow the socket race far enough and you end up in a destructor. That is a less obvious place to look than the polling loop.

## How cleanup reaches the socket

The drainer calls `get_message()` to poll for task updates. Separately, `AsyncResult.__del__` can reach `remove_pending_result`, then `cancel_for`, then `pubsub.unsubscribe()`.

A destructor sounds like the end of a result's life. For the shared socket, it is another caller. Redis-py pub/sub objects are not safe for concurrent use, so a valid unsubscribe can still race with a valid read.

The patch gives `ResultConsumer` an `RLock` and uses it around the pub/sub lifecycle, subscription changes, polling, and reconnection.

## Why the lock has to be reentrant

While processing a message, the drainer calls `on_state_change`. If the task is ready, that path can call `cancel_for`. The consumer therefore needs to acquire the same lock again while handling a message under it. A plain mutex would deadlock on that nested call. Reconnection also reaches nested consumer operations.

I would be wary of treating this as a mechanical "add a lock" patch. The call graph determines which lock works, and the fork and idle paths determine where to hold it.

When no pub/sub object exists, `drain_events` sleeps outside the lock. There is no socket operation to protect during that wait; holding the lock would delay a caller trying to start consumption.

After a fork, `on_after_fork` creates a fresh lock before cleanup. The inherited lock may have been held by a thread that no longer exists in the child process.

## What serialization costs, and what the tests check

Polling happens under the lock. A caller trying to subscribe or unsubscribe must wait for that poll to return. The PR discusses a drainer poll timeout of up to one second, which makes this a real tradeoff. A design where the drainer owns the socket and receives subscription commands through a queue would require a broader change.

The merged unit tests use a fake pub/sub object that records overlapping calls. Several threads subscribe and unsubscribe while a drainer polls. Other checks verify lock ownership around the relevant operations, sleep outside the lock, and replacement of the inherited lock after a fork.

The PR also includes Redis integration tests for concurrent result collection and subscription churn. The fake makes an ownership violation observable; Redis exercises the socket behavior behind it.

**Source:** [merged PR and tests](https://github.com/celery/celery/pull/10671/files).
