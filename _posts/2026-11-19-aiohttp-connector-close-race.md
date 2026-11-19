---
layout: post
title: "The resolver that closed first"
permalink: /notes/aiohttp-connector-close-race/
categories: [concurrency, python]
excerpt: "aiohttp's TCPConnector tore down its DNS resolver before marking itself closed, so an in-flight resolve resumed into a None and crashed with AttributeError instead of a clean connection error."
---

A voice agent I was reading about crashed during shutdown with an exception that shouldn't exist: `AttributeError: 'NoneType' object has no attribute 'getaddrinfo'`. Not a connection error, not a timeout — a None where a DNS resolver used to be. The crash came out of aiohttp's `TCPConnector`, and the trail from that AttributeError to the actual bug is a lesson in how much ordering matters in async teardown.

The report came from [livekit-agents](https://github.com/aio-libs/aiohttp/issues/12497): an STT node schedules a `session.ws_connect()` retry when its websocket drops, and if that retry fires right as the call ends, it collides with `session.close()`. The STT code does the responsible thing and checks `session.closed` before reconnecting. The check passed. The reconnect crashed anyway, because `closed` was still `False` while the resolver was already gone.

## Two steps in the wrong order

Here's the old `TCPConnector.close()`:

```python
async def close(self, *, abort_ssl: bool = False) -> None:
    if self._resolver_owner:
        await self._resolver.close()       # (A)
    await super().close(abort_ssl=...)     # (B)
```

Step (A) closes the resolver. With `aiodns` installed, aiohttp uses `AsyncResolver`, and closing it nullifies its internal `_resolver` reference — the actual `aiodns.DNSResolver` object. Step (B) is the base class close, which is where `_closed = True` finally gets set.

So there's a window between (A) and (B) where the resolver is dead but the connector still answers `closed == False`. Now put an in-flight connection in that window. A request that's suspended in a `on_dns_resolvehost_start` trace callback — which is exactly where the repro parks it with an `await asyncio.sleep(0)` — resumes after (A), checks nothing, and calls `self._resolver.resolve(...)`. If the resolver object it holds is the `AsyncResolver`, the call chains into `self._resolver.getaddrinfo(...)` on a None. AttributeError.

The detail that made this narrow: it only happens on the non-cached DNS path. With `use_dns_cache=True` (the default), in-flight resolves are tracked in `_resolve_host_tasks` and explicitly cancelled by `_close_immediately`. With `use_dns_cache=False`, nothing tracks the resolve, so nothing cancels it, and it walks straight into the torn-down resolver. The livekit code had disabled the cache, which is why they saw it and most people don't.

## The fix is ordering plus a guard

The [fix](https://github.com/aio-libs/aiohttp/pull/12787) does two things. First, flip the order — mark the connector closed before touching the resolver:

```python
async def close(self, *, abort_ssl: bool = False) -> None:
    await super().close(abort_ssl=abort_ssl or self._ssl_shutdown_timeout == 0)
    if self._resolver_owner:
        await self._resolver.close()
```

`super().close()` sets `_closed = True` and starts shutting down connections, so by the time the resolver goes away, the connector already reports itself closed. Second, make `_resolve_host()` respect that flag:

```python
if self._closed:
    raise ClientConnectionError("Connector is closed")

res = await self._resolver.resolve(host, port, family=self._family)
```

Now the same race — a resolve resuming mid-teardown — gets a `ClientConnectionError` with a message that says what happened, which is the exception aiohttp callers already know how to catch and retry against. The guard matters even with the reorder, because `close()` on the base class awaits real work; an in-flight resolve can still be holding a resolver reference across that await. Defense in depth, but each layer earns its place: the reorder closes the window for `session.closed` checks lying, the guard makes the residual window fail clean.

## Testing a race without racing

The regression test doesn't hope the scheduler interleaves things badly — it forces the interleaving with two futures:

```python
class FakeResolver(AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_INET):
        resolve_started.set_result(None)
        await close_started          # park mid-resolve
        return [{...}]

    async def close(self) -> None:
        assert False
```

The fake resolver announces it started, then blocks until the closer says go. One task runs `_resolve_host`, another waits for `resolve_started`, fires `close_started`, and calls `connector.close()`. The ordering is deterministic: resolve is in-flight, close runs to completion, resolve resumes. Then a second `_resolve_host` after close asserts it raises `ClientConnectionError`.

Note the `assert False` in the fake's `close()`: the connector was created with an explicit resolver, so `_resolver_owner` is False and close must never touch it. The test pins that ownership rule down at the same time.

## The takeaway

Teardown order is a contract. `closed` is the flag callers use to decide whether to start new work, so anything that makes the object unusable has to happen after the flag flips, or the flag is lying. The old order was individually sensible — release the resolver, then close everything else — but it made the observable state (`closed == False`) diverge from the real state (resolver gone) for exactly long enough to crash a caller doing everything right.

This was also a duplicate that almost got away: the same race was reported in aiohttp#11987 and closed without a fix for lack of a reproduction. The deterministic repro was what made the difference this time. If you hit a heisenbug in teardown, the highest-value thing you can attach to the report isn't a stack trace — it's the interleaving.

My [aiohttp PR #12787](https://github.com/aio-libs/aiohttp/pull/12787) merged on June 2, 2026. [Implementation and test](https://github.com/aio-libs/aiohttp/pull/12787/files).
