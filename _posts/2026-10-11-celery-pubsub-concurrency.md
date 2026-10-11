---
layout: post
title: "The socket race started in a destructor"
permalink: /notes/celery-pubsub-concurrency/
categories: [concurrency, task-queues]
excerpt: "I followed a Redis socket race out of Celery's polling loop and into result cleanup. The fix needed a lock that could survive callbacks and a fork."
---

The polling loop was the obvious place to look for a Redis socket race. The caller that made this one interesting was an object being destroyed.

Celery could be waiting for task updates when `AsyncResult.__del__` tried to unsubscribe from the same pub/sub object. Under gevent, that overlap could produce `ConcurrentObjectUseError`: another greenlet was already using the socket.

I had to stop treating cleanup as an epilogue. It was doing live I/O against an object the drainer still owned.

## An unsubscribe still touches the socket

The two paths meet here:

- The drainer polls for task updates with `get_message()`.
- Result destruction reaches `remove_pending_result`, then `cancel_for`, then `pubsub.unsubscribe()`.

Each operation makes sense on its own. Redis-py pub/sub objects don't support concurrent access, though, and an unsubscribe doesn't become safe merely because it came from cleanup.

The patch gives `ResultConsumer` an `RLock` around pub/sub access, including subscription changes, polling, and reconnection. Covering only the reader would leave the competing caller untouched.

## A plain lock would introduce a deadlock

Following the reader one call deeper explains the choice of lock. While processing a message, the drainer calls `on_state_change`. A ready task can lead from there to `cancel_for`, which needs to unsubscribe.

The consumer is already holding the lock when it reaches that callback. It needs to acquire the same lock again. A plain mutex would block the consumer on its own lock; a reentrant lock allows the nested call. Reconnection also reaches nested consumer operations.

I find this part easy to miss when reviewing a small diff. The lock declaration takes one line. Choosing it requires reading through the callback.

There are two other places where lock placement matters. If no pub/sub object exists, `drain_events` sleeps outside the lock so a caller can start consumption during that wait. After a fork, `on_after_fork` creates a fresh lock before cleanup. The inherited one may have been held by a thread that no longer exists in the child.

## Making the race visible without waiting for it

The unit tests use a fake pub/sub object that records overlapping calls. A drainer polls while several threads subscribe and unsubscribe. If callers enter the object together, the fake makes that ownership violation observable.

Other checks cover lock ownership on the relevant paths, the idle sleep, and replacement of the inherited lock after a fork. The PR also includes Redis integration tests with concurrent result collection and subscription churn, exercising the socket behavior behind the fake.

## The wait moves somewhere else

Serializing access has a cost: polling holds the lock. A subscription change has to wait for the current poll to return. The PR discusses a drainer poll timeout of up to one second, so this can be noticeable.

Having the drainer own the socket and accept subscription commands through a queue would be a larger redesign. This patch keeps the existing consumer structure and makes callers take turns. When reviewing its cost, I'd look at subscription latency as well as whether the socket error disappeared.

My [Celery PR #10671](https://github.com/celery/celery/pull/10671) merged on September 21, 2026. [Implementation and tests](https://github.com/celery/celery/pull/10671/files).
