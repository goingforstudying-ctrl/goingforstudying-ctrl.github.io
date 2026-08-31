---
layout: post
title: "The reply queue that never drained"
---

It started with a RabbitMQ vhost whose reply queue kept growing. The client on it wasn't doing anything exotic — no `result.get()` with long timeouts, just a fleet of processes polling `result.state` for a bunch of task IDs, the pattern every monitoring dashboard and status endpoint uses. Queue depth climbed anyway, and client memory climbed with it. Following that thread led me to celery/celery#4830, an issue reported in 2018, which still reproduced cleanly on main. Eight years old.

The RPC result backend is a clever piece of design: instead of a separate result store, results go back over the AMQP broker itself, one reply queue per client. When you poll a task's state, `get_task_meta()` drains that queue with `basic_get`, buffers everything that isn't yours in `_out_of_band`, and then — here's the bug — unconditionally calls `requeue()` on the message it found, even when that message carries a final state. SUCCESS, FAILURE, REVOKED, doesn't matter. Back on the queue it goes.

So picture the steady state. You poll a finished task; its result message is requeued. Your next poll — for *any* task — slurps it again and, since it's not the task being polled, it lands in `_out_of_band`, a plain unbounded dict where nothing ever removes it. The message ping-pongs between the broker queue and client memory until it expires. Every poll of every finished task adds another lap. That's both symptoms from #4830 in one mechanism: the broker queue never drains, and `_out_of_band` never empties.

There's a nastier variant hiding in the same code path. Say a poll buffers a non-final state — STARTED — in `_out_of_band`. The consumer then delivers the final state for that task through the normal path, and the cached state becomes SUCCESS. But the stale STARTED entry survives in `_out_of_band`. A later poll pops it, and the cached state *regresses* to STARTED. Your status endpoint would watch a finished task go backwards.

And while I was in there, two more things turned out to be quietly broken. `AsyncResult.forget()` just raised `NotImplementedError` on this backend — it inherited the base `_forget`, which only raises. And `_after_fork` crashed outright: it called `self._pending_results.clear()` on a namedtuple, which doesn't have a `.clear()`. Both looked like they'd been that way for a very long time, which tells you how rarely anyone exercises those paths.

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

Non-final states keep the old requeue behavior, so polling progress updates works exactly like before. Only terminal states get the new path.

Around that core change: out-of-band messages are now acked once their payload is buffered or cached — previously they were left unacked on the channel indefinitely, which was its own slow leak. A final state arriving through the consumer drops any stale `_out_of_band` entry for that task, killing the state-regression variant. `forget()` actually works now: it clears the out-of-band entry and the pending buffer, and `_forget` is a no-op, because results are queue messages — there's nothing stored server-side to delete. And `_after_fork` clears both pending-result mappings, the out-of-band dict, the pending-message buffer, and the cache, instead of exploding on the namedtuple.

One behavior change is worth being honest about. With the default `result_cache_max=-1` (client-side cache disabled), re-polling a finished task from a *brand new* `AsyncResult` used to re-read the requeued message off the queue. Now it's served from the pending-message buffer — bounded and LRU-evicted, so it can fall out under pressure — or from the cache when caching is enabled. I considered gating the ack on cache-enabled to preserve the old read-back, but the old read-back is precisely the mechanism that leaks. Preserving it would mean shipping the bug with a flag.

The test I'm happiest with is the smoke test. Unit tests with mocked channels can verify acks and requeues, but this bug's signature lives on the broker, so the regression test runs against a real RabbitMQ container with the management API exposed. It publishes three tasks, polls each one to completion, polls each five more times, and then asks the management API for the total ready-message count across the vhost:

```python
def assert_broker_drained():
    # before the fix every poll requeued the final message, so
    # the reply queue never stayed empty here.
    assert broker.get_total_ready_messages() == 0
```

Before the fix that assertion could never hold — every poll put the final result back. After it, the queue drains and stays drained. Asserting on broker state directly is the only version of this test that can't be fooled by a mocking mistake.

Who should care: anyone using `result_backend="rpc://"` with long-lived clients that poll task states — status endpoints, workflow dashboards, synchronously-orchestrating services. The leak scales with poll frequency and finished-task count, so the busiest pollers degrade first, and the unbounded `_out_of_band` dict means the client process grows right alongside the broker queue. If that's your setup and your reply queues have been mysteriously sticky since, well, 2018 — upgrade.
