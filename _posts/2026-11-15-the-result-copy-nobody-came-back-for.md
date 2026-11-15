---
layout: post
title: "The result copy nobody came back for"
permalink: /notes/the-result-copy-nobody-came-back-for/
categories: [concurrency, task-queues]
excerpt: "A two-task script left stray entries in Celery's Redis result buffer eighty percent of the time. The results had already been delivered; the buffer kept copies anyway."
---

A bug report described a script that could hardly be simpler: delay two tasks, call `.get()` on both, sleep a second, then inspect the Redis result consumer. Most of the time — the reporter said about eighty percent — `_pending_messages` still held one or two entries after both results had come back. The tasks were done. Their values were in hand. Something in the client was keeping extra copies.

That something was a buffer that exists for a completely legitimate reason, serving a race that has nothing to do with the one the script hit. Untangling which race was which is most of the story, and the fix in [celery/celery#10342](https://github.com/celery/celery/pull/10342) ended up being about not calling a correct function from the wrong place.

## Two races, one buffer

Celery's Redis result backend delivers task results over pub/sub. A client waiting on `AsyncResult.get()` subscribes to the task's channel and drains events. But messages can arrive out of order relative to registration: the pub/sub message may land before the result object has been added to `_pending_results`. For that case the consumer keeps `_pending_messages`, a `BufferMap` capped at 8192 entries, and `on_state_change` files the meta there when no waiter is found:

```python
if meta['status'] in states.READY_STATES:
    task_id = meta['task_id']
    results = _waiting_on(self._pending_results, task_id)
    if not results:
        # send to buffer in case we received this result
        # before it was added to _pending_results.
        self._pending_messages.put(task_id, meta)
```

Finding no waiter means "we were early", and early messages get buffered so a later registration can pick them up through `_maybe_resolve_from_buffer`. Reasonable design.

The second race lives in the synchronous poll path. `get()` calls `_wait_for_pending`, which hands the result to `on_wait_for_pending`:

```python
def on_wait_for_pending(self, result, **kwargs):
    for meta in result._iter_meta(**kwargs):
        if meta is not None:
            self.on_state_change(meta, None)
```

For a task that is already finished, `_iter_meta` doesn't just yield the meta. Resolving it runs `_maybe_set_cache`, which fires `on_ready`, which runs the result's fulfilled callback, which calls `backend.remove_pending_result(result)`. By the time the loop body executes, the result has been removed from `_pending_results` as a side effect of producing the very meta we're holding.

So `on_state_change` looks for waiters, finds none — we just removed the only one — and files the meta under "early message". Except this message wasn't early; it was terminal. The buffer's only consumer is a future waiter on the same task id, and after a successful `get()` there will never be one. The entry sits in the `BufferMap` until thousands of unrelated entries eventually push it out.

## One leaked copy per collected result

The reproducer needed only two tasks to hit this most of the time. A long-lived process that collects results all day — an API worker handing out `task.get()`, a dispatcher joining on submissions — leaks up to one buffered copy per collection when the timing lands. The cap keeps it from growing without bound, but every slot holds a full result payload that will never be read, and the buffer never shrinks back on its own. That was the leak in [celery#8166](https://github.com/celery/celery/issues/8166): not a crash, just memory quietly retained by design, reproducible on a plain 5.3 install with ten lines of user code.

## The fix is choosing not to buffer

In the poll path we know more than `on_state_change` does. We know the meta came from resolving this result, just now, so buffering it "for a future waiter" is certainly wrong. The patch narrows the call:

```python
if meta['status'] in states.READY_STATES:
    if getattr(result, 'results', None) is None:
        self._maybe_cancel_ready_task(meta)
    else:
        self.on_state_change(meta, None)
else:
    self.on_state_change(meta, None)
```

For a single `AsyncResult` in a ready state, the only thing left to do is unsubscribe the task's pub/sub channel, which `_maybe_cancel_ready_task` handles through `cancel_for`. No buffer insert, no bucket delivery — the result is already resolved, so there is nothing to deliver.

The `results` attribute check keeps `ResultSet` and `GroupResult` on the full path, and that distinction is load-bearing. A native join polls with `backend.get_many()` and yields ready metas without resolving the individual results as it goes. Their waiters are still registered in `_pending_results`, and the join's bucket delivery happens inside `on_state_change`. Skipping it there would hang joins, so the branch has to tell the two callers apart. Duck-typing on `results` is a little blunt, but it matches how the rest of the result API distinguishes a single result from a set.

The alternative I weighed was fixing `on_state_change` itself — say, checking whether the result had just been resolved before buffering. I don't think that survives contact with the other caller. `on_state_change` also serves out-of-band pub/sub messages, where the buffer is exactly what makes out-of-order delivery safe. The buffering logic is right; it was being invoked from a context where its premise didn't hold. Fixes that amount to "stop calling the correct function from the wrong place" are the kind I trust most, because the diff stays small and the argument is structural rather than another piece of state to keep consistent.

## What the tests pin down

The regression tests cover the three behaviors that have to hold together. A single ready result goes through the poll path: the pub/sub subscription is cancelled and `_pending_messages` stays empty. A non-ready meta still flows through `on_state_change`, so out-of-band buffering is untouched. And a `ResultSet` with a ready meta still takes the full state-change path, because join delivery depends on it.

The third test is the one I'd expect a reviewer to demand. Without it, the branch on `results` reads like an arbitrary special case; with it, the asymmetry between "the poll resolved this result" and "the poll yielded a meta for a result someone is still waiting on" is written down as executable behavior.

## Aftermath

Worth being honest about: this corner of the Redis backend needed more attention afterward. A follow-up, [celery/celery#10366](https://github.com/celery/celery/pull/10366), pops buffered entries after the poll path processes them, belt-and-braces for states where skipping the insert isn't safe. Later, [celery/celery#10671](https://github.com/celery/celery/pull/10671) serialized pub/sub access between the drainer and result cleanup. The leak this first fix closed was real but bounded — the buffer cap meant the failure mode was retained memory, not runaway growth. Those are the leaks that survive for years: the reporter hit it on 5.3.0b2, noted it went back at least to 5.1.2, and the buffer had been quietly collecting copies the whole time.
