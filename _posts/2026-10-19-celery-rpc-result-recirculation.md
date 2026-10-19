---
layout: post
title: "Every state poll put the finished result back on the queue"
permalink: /notes/celery-rpc-result-recirculation/
categories: [task-queues, correctness]
excerpt: "Celery's RPC result backend requeued final result messages on every state poll, so finished results ping-ponged between RabbitMQ and an unbounded client-side dict. A 2018 bug, fixed by acking instead of requeueing."
---

One of our RabbitMQ vhosts had a reply queue that kept growing. The client sitting on it mostly did one thing: poll `result.state` for a bunch of tasks. That combination led me to [celery issue #4830](https://github.com/celery/celery/issues/4830) — reported back in 2018, and still reproducing on main.

Here's what was happening. The RPC result backend stores task results as messages on a per-client reply queue. When you ask for a task's state, `get_task_meta()` slurps that queue with `basic_get`, finds the latest message for your task, and then — this is the bug — unconditionally calls `requeue()` on it. Even when the message carries a final state: SUCCESS, FAILURE, REVOKED.

So every state poll on a finished task puts the result message back on the broker. The next poll — for *any* task on that client — slurps it again, and this time it lands in `_out_of_band`, a plain dict on the client where nothing ever removes it. The message ping-pongs between the broker queue and that dict until it expires. The broker keeps holding it, and the client's memory keeps growing. That's exactly what the #4830 reporter described: `_out_of_band` never emptying.

There's a stale-data variant too. If a poll buffers a non-final state — say STARTED — in `_out_of_band`, and the consumer then delivers the final state for that task, the stale entry survives. A later poll pops it and regresses the cached state back to STARTED. The task finished; your monitor says it's still running.

While I was in there I also found that `AsyncResult.forget()` just raised `NotImplementedError` on this backend — it inherited a base `_forget` that only raises — and `_after_fork` called `self._pending_results.clear()` on a namedtuple, which can't work. Both had been that way for a long time.

## Ack the final states

The whole fix lives in `celery/backends/rpc.py`, and the core of it is small:

```python
if latest:
    meta = self._set_cache_by_message(task_id, latest)
    if meta['status'] in states.READY_STATES:
        # final state: resolve any pending waiter from the cache
        # and ack, requeueing would keep the message circulating
        # between the queue and _out_of_band forever.
        self.result_consumer.on_out_of_band_result(latest)
        latest.ack()
    else:
        latest.requeue()
    return meta
```

Final states get acked instead of requeued. The meta is handed to the result consumer first, so a waiter already blocked in `get()` still resolves, and a `get()` that starts *after* the poll resolves from the pending-message buffer instead of hanging on a message that will never come. Non-final states keep the old requeue behavior, so polling progress updates works exactly like before.

The rest of the patch is the same theme applied to the other corners. Out-of-band messages are now acked once their payload is buffered or cached — before, they sat unacked on the channel indefinitely. A final state arriving on the consumer drops any stale `_out_of_band` entry for that task. `forget()` clears `_out_of_band`, and `_forget` is a no-op now, because results are queue messages — there's nothing stored server-side to delete. `_after_fork` clears both pending-result mappings plus `_out_of_band` instead of crashing on the namedtuple.

One behavior change is worth calling out. With the default `result_cache_max=-1` (client-side cache disabled), re-polling a finished task from a *new* `AsyncResult` used to re-read the requeued message off the queue. Now it's served from the pending-message buffer, which is bounded and LRU-evicted, or from the cache when that's enabled. I think that's the right trade — the old behavior is precisely the leak — and it's all in [the PR](https://github.com/celery/celery/pull/10459) if you want to argue about it.

## How do you test "the queue doesn't grow"?

You need a real broker; a mock channel can't tell you what's actually sitting on a vhost. The smoke test I added runs RabbitMQ in a container with the management API exposed, sends tasks through a real worker, polls their states over and over, then asks the management API for `messages_ready` across the vhost and retries until the count drains to zero. Before the fix, every poll leaves the final result back on the queue, so the count never converges. After, it does.

The test setup had one wrinkle worth remembering: configuring `result_backend` through the pytest-celery `celery_setup_config` dict only configures the client side. The worker container reads `conf.changes`, so the worker app needs direct attribute assignment (`app.conf.result_backend = "rpc://"`) or the worker silently runs with the default backend and your test passes against the wrong thing.

Who hits this in production: anybody on the `rpc://` backend whose clients poll state — monitoring loops, CI gates, web frontends checking task progress. The leak is proportional to polls against finished tasks, which means it scales with how attentive your monitoring is. Backwards from what you want, and it had been sitting there since 2018.
