---
layout: post
title: "The pub/sub poll that never let go"
---

I have a soft spot for bugs that only show up after a few million operations. This one had been sitting in Celery's tracker as issue #8166, with a title that reads like a two-word diagnosis: "Redis backend._pending_messages not release". The symptom in the wild is boring on purpose. A worker process using the Redis result backend grows its memory, slowly, steadily, and nothing in the logs points at anything. Restarts mask it, which is exactly how leaks survive for years.

The trail starts in ResultConsumer, the piece of Celery's Redis backend that subscribes to pub/sub channels so a caller blocked on a result gets woken the moment the worker publishes it. Because a message can arrive before the consumer has finished subscribing, the consumer keeps a BufferMap called _pending_messages. If a result message shows up before the consumer has registered interest in that task, the message is stashed there and replayed once tracking catches up. It's a race-handling buffer, and its entries are supposed to be transient by construction.

The leak lived in on_wait_for_pending. When you wait on a task that has already finished, _iter_meta resolves the result synchronously and removes it from _pending_results, the set of tasks the consumer is tracking. The old code then fed every meta it got back into the full on_state_change. That method checks whether the result is still tracked in _pending_results; for a task that was just resolved away, the lookup misses, so the meta gets classified as an early-arriving message and appended to _pending_messages.

And nothing ever reads that entry back out.

One poll of an already-ready task, one dictionary quietly parked in the buffer. Multiply that by every finished task a long-running worker waits on, and a structure that exists to hold messages for milliseconds turns into a permanent archive of task metadata. The fix is small:

```python
if meta['status'] in states.READY_STATES:
    if getattr(result, 'results', None) is None:
        self._maybe_cancel_ready_task(meta)
    else:
        self.on_state_change(meta, None)
else:
    self.on_state_change(meta, None)
```

For a bare AsyncResult in a ready state, the only real work left is cancelling the pub/sub subscription for that task, which is what _maybe_cancel_ready_task does. The full state-change path stays for two cases: metas that aren't ready yet, and ResultSet or GroupResult objects. Those have a results attribute, and their _iter_meta yields ready metas straight from backend.get_many() without resolving individual AsyncResults, so the bucket-delivery logic inside on_state_change is still doing real work there and must not be skipped.

The regression tests I added keep a real BufferMap under the consumer and drive all three paths through fakes: a single ready result must leave the buffer empty and the subscription cancelled; a non-ready meta must still flow through on_state_change; a ResultSet carrying ready meta must keep the full path too. The assertions are blunt — pending_messages.total == 0 after the call — which is the only kind of assertion that ever catches a leak like this.

This bug class is why return-value tests will never find it: every intermediate state looks correct, and only the accounting of where data ends up is wrong. The fix merged as https://github.com/celery/celery/pull/10342, and a follow-up, https://github.com/celery/celery/pull/10366, later drained the entries that had already leaked into the buffer before this landed, because a fix that stops the bleeding doesn't empty what's already pooled.

If you operate Celery against Redis with long-lived processes that wait on a lot of results, this one is worth checking your version for. There's no error to catch; the first thing that tells you about it is the OOM killer.
