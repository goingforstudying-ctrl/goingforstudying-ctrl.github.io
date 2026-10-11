---
layout: post
title: "The leak that outlived its first fix"
---

There's a special kind of bug that comes back after you've fixed it once. Not because the first fix was wrong about the mechanism — it usually isn't — but because it was wrong about what else the broken code was doing for a living.

Celery's Redis result backend had a memory leak, tracked as issue #8166, that worked like this. When you wait on a task result, the result consumer subscribes to a Redis pub/sub channel and processes state-change messages. Results that arrive before anyone is waiting on them get buffered in a `BufferMap` called `_pending_messages`, so a late waiter can still pick them up. Meanwhile `_pending_results` tracks which results are actively being waited on.

The leak: `on_wait_for_pending` polls a result that's already in a READY state — say the task finished between the client asking and the subscription actually being set up. Polling calls `on_state_change` with that meta. But the result has already been resolved and removed from `_pending_results`, so `on_state_change` shrugs and buffers the meta into `_pending_messages` instead, on the theory that some future waiter might need it. No future waiter ever comes. The subscription gets cancelled, the task is complete, and the buffered entry just sits there. Every poll of an already-ready result leaves one more orphan in the map. In a long-running worker processing lots of short tasks, the map grows forever.

## Fix one, and why it came back

The first fix I landed was [PR #10342](https://github.com/celery/celery/pull/10342): skip `on_state_change` entirely when polling a single `AsyncResult` that's already READY. No call, no buffering, no leak. Clean, minimal, and wrong.

It got reverted. `on_state_change` isn't just a buffering function — it's the backend's state-change pipeline. It fires callbacks, updates caches, delivers to result buckets. Skipping it for READY results plugged the leak by amputating all of that for a whole class of results, and the integration tests that exercised those code paths started hanging. The leak was a symptom; the first fix treated the pipeline as the disease.

This is the revert teaching its lesson: when a fix gets bounced, the revert reason is a map of everything the code was secretly responsible for.

## Fix two

The second pass, [PR #10366](https://github.com/celery/celery/pull/10366), takes the opposite approach. Let `on_state_change` run exactly as it always has — callbacks, caches, buckets, buffering, everything. Then, once the dust settles, clean up the entry it leaked:

```python
def on_wait_for_pending(self, result, **kwargs):
    for meta in result._iter_meta(**kwargs):
        if meta is not None:
            self.on_state_change(meta, None)
            # After on_state_change processes a READY meta, clean up any
            # leaked entry in _pending_messages. on_state_change may have
            # buffered this READY meta there (if the result was already
            # resolved from _pending_results). Since the subscription is now
            # canceled and the task is complete, this entry will never be
            # consumed and would leak memory.
            if meta['status'] in (states.SUCCESS, states.FAILURE):
                pending_messages = self.backend._pending_messages
                task_id = meta['task_id']
                try:
                    buf = pending_messages.pop(task_id)
                except KeyError:
                    pass
                else:
                    pending_messages.total -= len(buf)
```

The behavior change is surgically narrow: nothing about how state is processed changes, only what happens to the buffer afterwards for results that are done. The `try/except KeyError` isn't decorative — the map is shared state, and another thread can legitimately drain the entry between the status check and the pop. Losing that race is fine; the entry is gone either way, which is all we wanted.

One edge case is deliberately left alone: REVOKED. A revoked task's meta may still be needed by other waiters — the revoke-by-headers flow has integration tests that depend on exactly that buffering. So cleanup only applies to SUCCESS and FAILURE, the states where "complete and subscription cancelled" unambiguously means nobody is coming back for the entry. When in doubt, keep the entry; a leaked REVOKED meta is a bounded problem, a prematurely dropped one is a correctness bug.

The tests mirror the failure modes directly: a leaked SUCCESS entry gets cleaned, a leaked FAILURE entry gets cleaned, a REVOKED entry survives, a missing entry makes cleanup a no-op, and a `pop` that raises `KeyError` mid-race gets swallowed. Each test pins one of the ways this cleanup could itself become a bug.

## What I took from it

The obvious lesson is that skipping a function and cleaning up after a function are not interchangeable, even when they produce the same observable state. The first fix assumed `on_state_change`'s side effects were optional for READY results; the integration suite disagreed. The second fix treats the function's contract as load-bearing and attacks only the actual defect — the orphaned buffer entry.

The less obvious lesson is about reverts. A revert isn't just a failed patch, it's free information about the hidden coupling in the system. The gap between "fix one" and "fix two" here was entirely made of things the revert taught: callbacks fire through that path, caches update through that path, and any fix that wants to live has to keep all of it working. If a fix of yours gets reverted, read the failure like a spec. It usually is one.
