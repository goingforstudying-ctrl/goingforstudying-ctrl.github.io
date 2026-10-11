---
layout: post
title: "The socket race started in a destructor"
permalink: /notes/celery-pubsub-concurrency/
categories: [concurrency, task-queues]
excerpt: "I followed a Redis socket race out of Celery's polling loop and into result cleanup. The fix needed a lock that could survive callbacks and a fork."
---

The task could finish, and collecting its result could still lose a fight over the Redis socket. One caller was Celery's drainer, waiting for an update. The other was an `AsyncResult` being destroyed.

Under gevent, overlapping access to the shared pub/sub object could raise `ConcurrentObjectUseError`. Following the second caller took me out of the polling loop and into `AsyncResult.__del__`, through result removal, and finally to `unsubscribe()`.

I had been reading cleanup as code that ran after the interesting work. Here it was another active participant in the protocol, issuing I/O while the drainer was still using the connection. That changed where I put the lock, and which kind of lock the consumer needed.

## Cleanup is a socket user

The drainer calls `get_message()` to collect task updates. Result destruction can reach `remove_pending_result`, then `cancel_for`, and eventually `pubsub.unsubscribe()`. Redis-py pub/sub objects don't support concurrent use, so protecting only the polling call leaves the other caller free to enter the same object.

The patch gives `ResultConsumer` a shared `RLock` around pub/sub access, including subscription changes, polling, reconnection, and closing the object. The subscription set is updated under that lock too. The ownership rule needs to cover the consumer's view of the subscriptions as well as the socket calls.

{% include pubsub-ownership.html %}

I find the destructor path useful to keep visible in a diagram. A reviewer looking only for public methods that explicitly subscribe or poll can miss a caller whose entry point is object lifetime.

## The callback comes back through the same lock

While holding the lock, the drainer can process a message through `on_state_change`. If the task is ready, that callback can call `cancel_for`, which needs to unsubscribe. The consumer reaches the lock again before the outer call has released it.

A plain mutex would make the consumer wait on itself. The reentrant lock lets that nested call proceed under the same ownership. Reconnection also reaches nested consumer operations, so choosing `RLock` requires following the callbacks, not just counting concurrent callers.

That was the most revealing part of the review for me. The declaration fits on one line; the reason for it sits several calls away. Adding synchronization without tracing those calls would trade a socket race for a deadlock.

Two less visible boundaries matter too. When no pub/sub object exists, `drain_events` sleeps outside the lock. Otherwise, a caller trying to start consumption would have to wait through an idle sleep. After a fork, `on_after_fork` creates a fresh lock before cleanup: the inherited lock may have been held by a thread that doesn't exist in the child.

## Test ownership before testing the whole queue

The unit test uses a fake pub/sub object that records overlapping calls. A drainer polls while other threads subscribe and unsubscribe; the fake makes concurrent entry observable. That gives the regression a precise failure condition without relying on a real socket race to happen at the right moment.

Other unit checks cover lock ownership on the relevant paths, sleeping outside the lock when idle, and replacing the inherited lock after a fork. The PR also adds Redis integration tests for concurrent result collection and subscription churn. Those exercise the connection behavior the fake can't reproduce.

I want both layers. The fake helps explain what broke when a test fails. The integration test checks that the ownership rule still makes sense against Redis, including callers entering through the normal result API.

## Serialization has a latency cost

Polling holds the lock while waiting for a message. A new subscription or cancellation must wait for that poll to return. The PR discusses a drainer poll timeout of up to one second; that timeout describes the poll, not an end-to-end subscription latency guarantee.

For a queue feeding embedding jobs or offline model evaluations, I would measure result collection and subscription latency alongside worker execution time. Even after a fast worker finishes, the caller can still be waiting behind a poll in the result consumer.

A design in which the drainer owns the socket and accepts subscription commands through a queue could move that boundary. This patch keeps the existing consumer structure and serializes its callers. It fixes ownership at a smaller scope, with a waiting cost that a deployment can measure.

My [Celery PR #10671](https://github.com/celery/celery/pull/10671) merged on September 21, 2026. [Implementation and tests](https://github.com/celery/celery/pull/10671/files).
