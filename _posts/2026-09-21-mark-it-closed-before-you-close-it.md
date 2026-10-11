---
layout: post
title: "Mark it closed before you close it"
---

The crash that sent me into aiohttp's connector teardown came from a voice agent, of all places. livekit-agents was intermittently dying with `AttributeError: 'NoneType' object has no attribute 'getaddrinfo'` during shutdown — specifically when an STT websocket dropped, the library scheduled a reconnect, and that reconnect happened to race `session.close()` as the call ended. The STT code was even doing the right thing: it checked `session.closed` before retrying. The check passed. The session then exploded anyway.

That gap between "the session says it's open" and "the session is actually broken" is the whole bug, and it lives in the teardown order of `TCPConnector.close()`:

```python
async def close(self, *, abort_ssl: bool = False) -> None:
    if self._resolver_owner:
        await self._resolver.close()       # (A)
    await super().close(abort_ssl=...)     # (B)
```

Step (A) closes the DNS resolver. When `aiodns` is installed, the resolver is `AsyncResolver`, and closing it nullifies its internal resolver object. Step (B) is where `_closed = True` actually gets set. Between (A) and (B) there's a window where the resolver is dead but every public signal — `session.closed`, the connector's `_closed` flag — still reports healthy.

Now put an in-flight connection in that window. The connection is doing a DNS lookup, and it's suspended inside a trace callback (`on_dns_resolvehost_start` handlers are async, so any `await` in one yields control). While it's suspended, `close()` runs step (A). The connection resumes, reaches for `self._resolver.resolve(...)`, and `AsyncResolver.resolve` calls `getaddrinfo` on the internal object that no longer exists. `AttributeError`, delivered to some poor caller who was promised a `ClientConnectionError`.

Why doesn't this fire constantly? Two reasons. The default `ThreadedResolver` closes without this hazard, so you need `aiodns` installed. And the cached DNS path (`use_dns_cache=True`, the default) tracks its resolve tasks in `_resolve_host_tasks` and gets them cancelled by `_close_immediately`, so the in-flight lookup never resumes into the dead resolver. You need the non-cached path plus `aiodns` plus an unlucky yield point — exactly the combination a production websocket client with tracing enabled tends to have. The same race had been reported before in #11987 and closed without a fix, presumably because nobody could make it deterministic.

The fix has two halves, and both are about making the flags honest before the resources go away:

```python
async def close(self, *, abort_ssl: bool = False) -> None:
    # Use abort_ssl param if explicitly set, otherwise use ssl_shutdown_timeout default
    await super().close(abort_ssl=abort_ssl or self._ssl_shutdown_timeout == 0)
    if self._resolver_owner:
        await self._resolver.close()
```

Reordering alone means `_closed = True` lands before the resolver can disappear, so the in-flight resolve completes normally against a resolver that's still alive — `close()` only tears it down after the base class has finished. But reordering doesn't help a *new* resolve that starts after close, and `connect()` has paths that reach `_resolve_host` without checking the flag first. So the second half adds a guard right before the resolver call:

```python
if self._closed:
    raise ClientConnectionError("Connector is closed")

res = await self._resolver.resolve(host, port, family=self._family)
```

Now the failure mode is the one callers already handle: a `ClientConnectionError` with a message that says what actually happened, instead of an `AttributeError` leaking an internal `None`.

The regression test is the satisfying part, because it turns a production heisenbug into a choreographed dance. A `FakeResolver` signals on a future when its `resolve()` starts, then waits on a second future before returning. The test starts the resolve, waits for that signal, runs `connector.close()` in the gap, then lets the resolve finish. That's precisely the interleaving that crashed livekit-agents, reproduced without any sleeps or luck. The resolver's own `close()` is wired to `assert False` — since the test passes its own resolver, the connector doesn't own it and must never close it — and a final assertion confirms a fresh `_resolve_host` after close raises `ClientConnectionError("Connector is closed")`.

Worth noting what the fix deliberately doesn't do: it doesn't cancel the in-flight resolve. Cancelling would be a behavior change for anyone relying on close-during-resolve completing, and the in-flight operation is fine — the resolver lives until the base close finishes. Only new operations after close get the clean error. Small surface, no surprises.

Who hits this: any long-lived aiohttp client on the `aiodns` resolver with DNS caching off that closes sessions while connections are starting — realtime APIs, websocket-heavy services, anything with reconnect-on-drop logic racing shutdown. It ships in [aio-libs/aiohttp PR 12787](https://github.com/aio-libs/aiohttp/pull/12787). The general shape of the bug shows up everywhere in async teardown: if your "am I closed?" flag flips *after* you destroy the resources, the flag is lying during the only window where it matters.
