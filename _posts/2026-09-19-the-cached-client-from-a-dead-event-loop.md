---
layout: post
title: "The cached client from a dead event loop"
---

The crash showed up in the worst possible place: the very first inference request after a clean server startup. `RuntimeError: Event loop is closed`. Startup had succeeded, health checks passed, models listed — and then the first real request blew up.

I was setting up a VertexAI provider on ogx, and after enough staring the sequence turned out to be a genuinely nasty lifecycle bug. Here's the machinery. `StackApp.__init__` needs to run async initialization from a synchronous constructor, so it spins up a temporary event loop — `asyncio.run(stack.initialize())` inside a ThreadPoolExecutor. During that init, `refresh_registry_once()` asks every provider for its model list. The VertexAI adapter's answer triggers lazy client creation in `_get_client()`, which builds a `google.genai.Client`.

The catch is in the genai library itself: the Client eagerly creates an internal `httpx.AsyncClient` (there's an upstream issue for it, googleapis/python-genai#1518). An httpx async client binds itself to whatever event loop is current at construction time. In this case, that's the temporary startup loop.

Then startup finishes. `asyncio.run()` closes the temporary loop and throws it away. Uvicorn starts on a brand new loop. And the adapter still has that genai Client cached in `self._default_client`, its connection pool holding TLS connections whose sockets belong to a loop that no longer exists.

First request arrives. The pool tries to touch those connections — somewhere down the stack something calls `loop.call_soon()` on the closed loop — and Python raises `RuntimeError: Event loop is closed`.

The annoying part is that this exact failure class already had a solution in the same codebase. SQLAlchemy engines have the same problem — engines built on the temp loop hold pool connections bound to it — and the server already calls `reset_sqlstore_engines()` right after the temporary loop finishes. There was just no equivalent for the provider's cached API client.

So the fix in [ogx#6072](https://github.com/ogx-ai/ogx/pull/6072) (for issue #6057) does the same thing in two layers. First, a `_reset_client()` on the VertexAI adapter:

```python
def _reset_client(self) -> None:
    self._default_client = None
    self._http_options = None
    self._http_options_initialized = False
```

...wired into `StackApp.__init__` immediately after `reset_sqlstore_engines()`, iterating the provider impls and calling `_reset_client` wherever one exists. Note what it doesn't do: it doesn't try to `await client.close()`. You can't — closing would need to schedule callbacks on the loop that owns the connections, and that loop is already dead. Dropping the reference and letting the garbage collector deal with the corpse is the only option. The next `_get_client()` call builds a fresh client, this time on uvicorn's live request-handling loop.

The second layer is defense in depth, inside `_get_client()` itself:

```python
if self._default_client is not None:
    if self._http_options is not None:
        _client = getattr(self._http_options, "httpx_async_client", None)
        if _client is not None and _client.is_closed:
            self._default_client = None
```

If the cached client's transport is closed — which is the observable symptom of "my loop died" — log it and recreate instead of returning the zombie. The probe is wrapped in a `try/except RuntimeError` too, since poking at a client bound to a closed loop can raise instead of answering cleanly. This layer exists for the case where some other code path creates a client on a dying loop and the reset hook never runs.

I had some hesitation about the `is_closed` check — it reaches into httpx's internal state, which has been stable across recent versions but isn't exactly a contractual API. The alternative was relying solely on the reset hook, which works today but is exactly the kind of invariant that silently breaks the next time someone adds a new client-creation path. Belt and suspenders won. If httpx ever rearranges its internals, the `getattr(..., None)` fails safe: no exception, just a missed optimization that falls back to the hook.

What this doesn't fix: any other provider that eagerly binds an HTTP client during init would need the same `_reset_client()` treatment — the server loop already calls it generically via `getattr`, so adding the method to another adapter is all it takes. And none of this helps if the genai client gets shared across loops by code outside the server lifecycle entirely.

Who hits this: anyone serving the ogx stack with VertexAI configured, which is to say anyone doing Gemini inference through it. The failure mode was total — not a degraded connection or a retryable error, but a hard crash on the first request after every single startup, with a stack trace pointing at asyncio internals rather than anything you actually wrote. Those are the worst bugs to chase, because the traceback blames the event loop while the actual mistake happened three lifecycle phases earlier.

The general lesson: in async Python, a cached client is secretly a cached event loop reference. Any time an object holds connections across a loop boundary — and "the constructor ran a temp loop" is a loop boundary — someone has to own the invalidation. If your codebase already resets one kind of connection-holding object after startup, that's not a one-off pattern. That's a checklist.
