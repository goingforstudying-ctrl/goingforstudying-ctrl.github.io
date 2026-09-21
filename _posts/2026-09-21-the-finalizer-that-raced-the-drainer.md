---
layout: post
title: "The finalizer that raced the result drainer"
---

Python's garbage collector doesn't care what your other threads are doing. When an object's refcount hits zero, `__del__` runs right there, on whatever thread happened to drop the last reference. I got bitten by this on Celery's Redis result backend, and the crash is a good reminder that "the GC will get to it eventually" is not a threading strategy.

The setup: when you call `AsyncResult.get()` in Celery with the Redis backend, the client subscribes to a per-task pubsub channel and a background drainer thread sits in `get_message()` waiting for the result to arrive. When you're done with the result object — or when it just falls out of scope — `AsyncResult.__del__` fires, walks into `remove_pending_result()`, then `cancel_for()`, and calls `pubsub.unsubscribe()` on the shared pubsub object. The same pubsub object the drainer thread is currently blocked inside.

redis-py's pubsub is explicitly not safe for concurrent use. With plain threads you get protocol desync — two threads interleaving reads and writes on one socket, each parsing bytes meant for the other. With gevent it's louder: `ConcurrentObjectUseError: This socket is already used by another greenlet` (an `AssertionError` on older redis-py versions). Either way your result consumer is dead and the traceback points at code that looks perfectly innocent.

The annoying part is that this race was supposed to be fixed already. Issue #4670 covered the same crash, and the fixes in #4666 and #6416 added the unsubscribe-on-forget behavior — which is correct, you do want to unsubscribe when a result is forgotten — but never serialized that unsubscribe against the reader. So the race didn't get fixed, it just moved to a different call site and kept crashing on 5.5.x.

The fix is a lock, but the details are where it gets interesting:

```python
self._pubsub_lock = threading.RLock()
```

Every touch of the shared pubsub now takes it: `start()`, `stop()`, `subscribe`, `unsubscribe`, the `get_message` poll in `drain_events`, the reconnect path, and the fork cleanup. An `RLock`, not a plain `Lock`, because the drainer re-enters. When a ready meta comes in, `on_state_change` calls `cancel_for` from inside the poll — that's already holding the lock — and the reconnect error handler re-enters too. A plain lock would self-deadlock the drainer the first time a result arrived.

Two spots needed judgment calls. First, the idle sleep: when no pubsub exists yet, `drain_events` just sleeps for the timeout. That sleep has to stay *outside* the lock, or every `apply_async` from another thread stalls behind a one-second nap for no reason. The lock guards the pubsub object, not the timeout. Second, fork safety. A prefork worker child inherits the lock in whatever state the parent left it — possibly held by a thread that didn't survive the fork, which would deadlock the child on its first pubsub touch. So `on_after_fork` swaps in a fresh lock before closing the inherited pubsub:

```python
def on_after_fork(self):
    # the lock may have been held by a thread that did not survive
    # the fork, so the child starts with a fresh one.
    self._pubsub_lock = threading.RLock()
    try:
        self.backend.client.connection_pool.reset()
        with self._pubsub_lock:
            if self._pubsub is not None:
                self._pubsub.close()
```

There's a real trade-off here and it's worth being honest about it: while the drainer is mid-poll — up to its one-second timeout — a subscribe or unsubscribe from another thread has to wait. That's strictly better than crashing, and in the pure fire-and-forget producer case the drainer isn't running at all, so there's zero contention. The alternative design is giving the drainer exclusive ownership of the pubsub and routing every operation through a command queue. That's a much bigger redesign of a very hot code path, and it buys you lower worst-case subscribe latency at the cost of a lot more machinery. For a crash fix, the lock is the right size.

Proving a race fix is its own problem, since the whole point is that the failure is timing-dependent. The main regression test cheats the timing away: a fake pubsub records every call with a flag for whether the lock is held, four threads hammer subscribe/unsubscribe while a drainer thread polls, and at the end the test asserts no two calls overlapped and every one held the lock. On main it fails immediately — the recording shows `['subscribe', 'subscribe', 'get_message', 'unsubscribe', ...]` with interleaved, unlocked access. With the fix the recording is clean. There are also deterministic unit tests that each pubsub operation takes the lock, that the idle sleep doesn't, and that `on_after_fork` actually replaces the lock — the properties that matter, pinned down without needing to win a race.

On top of that, two integration tests drive a real Redis server: twelve concurrent `AsyncResult.get()` calls from twelve threads on the shared consumer, and a churn test that subscribes and unsubscribes from several threads while a drainer polls the real socket. Those exercise the socket-level interleaving a fake can't reproduce.

Who hits this: anyone using the Redis result backend with `AsyncResult.get()` from multiple threads, or under gevent/eventlet where socket ownership is enforced. The trigger isn't exotic — short-lived result objects getting garbage collected while results are streaming in is normal operation for a busy client. It's a crash-your-consumer bug, so it's loud when it hits, and there's no workaround from user code because both sides of the race live inside the backend.

The fix is in [celery/celery PR 10671](https://github.com/celery/celery/pull/10671). The lesson generalizes: adding a cleanup call in a finalizer is only half the fix. If a background thread holds the same resource, you've just signed up to debug the race you moved, not the one you fixed.
