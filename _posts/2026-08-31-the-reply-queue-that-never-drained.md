---
layout: post
title: "The reply queue that never drained"
---

Polling a finished task should not keep its result circulating through the broker indefinitely. [Celery issue #4830](https://github.com/celery/celery/issues/4830), reported in 2018, described long-lived RPC-backend clients accumulating out-of-band results. PR #10459 followed the lifecycle of those messages through state polling, result delivery, and cleanup.

The RPC result backend is a clever piece of design: instead of a separate result store, results go back over the AMQP broker itself, one reply queue per client. When a state lookup reaches `get_task_meta()`, it drains that queue with `basic_get`, buffers everything that isn't yours in `_out_of_band`, and then — here's the bug — unconditionally calls `requeue()` on the message it found, even when that message carries a final state. SUCCESS, FAILURE, REVOKED, doesn't matter. Back on the queue it goes.

A later lookup for a different task can drain that requeued result and retain it in `_out_of_band`. The old implementation already removed entries on some consumption paths, but had no general size bound. Repeated terminal-message requeueing and entries that were no longer visited could therefore retain broker or client state. This depends on the lookup path: the same `AsyncResult` can return a cached final state without calling the backend again.

There's a nastier variant hiding in the same code path. Say a poll buffers a non-final state — STARTED — in `_out_of_band`. The consumer then delivers the final state for that task through the normal path, and the cached state becomes SUCCESS. But the stale STARTED entry survives in `_out_of_band`. A later poll pops it, and the cached state *regresses* to STARTED. Your status endpoint would watch a finished task go backwards.

The patch also addresses two cleanup paths. `AsyncResult.forget()` just raised `NotImplementedError` on this backend — it inherited the base `_forget`, which only raises. And `_after_fork` crashed outright: it called `self._pending_results.clear()` on a namedtuple, which doesn't have a `.clear()`. Those paths needed separate lifecycle coverage; their age does not tell us how frequently users encountered them.

The fix, in [celery/celery#10459](https://github.com/celery/celery/pull/10459), is built around one idea: a final state is terminal, so treat it as consumed instead of recirculating it. When `get_task_meta()` picks up a message in a ready state, the meta is handed to the result consumer first — so a waiter already blocked in `get()` still resolves — and then the message is acked, not requeued:

```python
meta = self._set_cache_by_message(task_id, latest)
if meta['status'] in states.READY_STATES:
    # final state: resolve any pending waiter from the cache
    # and ack, requeueing would keep the message circulating
    # between the queue and _out_of_band forever.
    self.result_consumer.on_out_of_band_result(latest)
    latest.ack()
else:
    latest.requeue()
```

The latest message for the requested task is still requeued if it is non-final. Out-of-band messages have a separate change: they are acknowledged after buffering, including non-final messages.

Around that core change: out-of-band messages are now acked once their payload is buffered or cached — previously they were left unacked on the channel indefinitely, which was its own slow leak. A final state arriving through the consumer drops any stale `_out_of_band` entry for that task, killing the state-regression variant. `forget()` actually works now: it clears the out-of-band entry and the pending buffer, and `_forget` is a no-op, because this method performs local bookkeeping rather than deleting a row in a shared result store. It does not retract arbitrary result messages already queued at the broker. And `_after_fork` clears both pending-result mappings, the out-of-band dict, the pending-message buffer, and the cache, instead of exploding on the namedtuple.

One behavior change is worth being honest about. With the default `result_cache_max=-1` (client-side cache disabled), re-polling a finished task from a *brand new* `AsyncResult` used to re-read the requeued message off the queue. Now it's served from the pending-message buffer — bounded and LRU-evicted, so it can fall out under pressure — or from the cache when caching is enabled. After an acknowledgement, this is not a promise of durable repeated reads: a newly created result object may no longer find the terminal state after local buffers or caches evict it. Applications that require shared, durable result history should evaluate the backend contract accordingly.

The test I'm happiest with is the smoke test. Unit tests with mocked channels can verify acks and requeues, but this bug's signature lives on the broker, so the regression test runs against a real RabbitMQ container with the management API exposed. It publishes three tasks, polls each one to completion, polls each five more times, and then asks the management API for the total ready-message count across the vhost:

```python
def assert_broker_drained():
    # before the fix every poll requeued the final message, so
    # the reply queue never stayed empty here.
    assert broker.get_total_ready_messages() == 0
```

The assertion checks that ready messages drain in the dedicated broker test environment. It complements the unit tests, but does not by itself measure unacknowledged messages, prove bounded client memory, or cover every polling sequence.

This matters to long-lived clients using `result_backend="rpc://"` and repeatedly polling task state. The patch changes terminal-message acknowledgement and local cleanup; it does not make the RPC backend a durable database or eliminate every possible accumulation of unconsumed results. Check the merged change and its read-back trade-off before choosing an upgrade for a particular polling workload.

Implementation reference: [merged commit](https://github.com/celery/celery/commit/1b40d93679ad9ba00541c6a076c34db266f7fbc4) (2026-08-08).
