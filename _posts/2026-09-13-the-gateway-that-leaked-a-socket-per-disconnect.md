---
layout: post
title: "The gateway that leaked a socket per disconnect"
---

There's a bug report filed against ogx, the Open GenAI Stack, that starts with a number that should be impossible: thirty-four TCP connections to a single remote inference endpoint, all parked in CLOSE_WAIT, surviving until the next process restart. The reporter's setup was ordinary — Kubernetes, eight uvicorn workers, remote OpenAI-compatible and vLLM backends — and the traffic was just normal request handling. Nothing crashed. The gateway simply accumulated half-dead upstream sockets until someone restarted it.

CLOSE_WAIT is the state a socket sits in when the peer has closed its side and the local process hasn't closed its own yet. On a server, that usually means one thing: something in the process is holding an HTTP response open long after the other side went away. In this case the "other side" wasn't the user's client — it was ogx's own upstream connections to inference providers, left open after the downstream client disconnected mid-stream.

I reproduced it with a mock OpenAI server and a client that does the rudest thing possible: open a streaming chat completion, read the first chunk, drop the connection. After three abandoned requests, `ss -tanp` showed three sockets from ogx to the mock sitting in CLOSE_WAIT. Every disconnect leaked exactly one.

Untangling the cause took two layers, and the first layer wasn't the whole story.

Layer one is async generators that never close what they iterate. A streaming response in ogx passes through a chain of wrappers: the OpenAI mixin rewrites chunk ids and usage, the Anthropic translation converts OpenAI chunks into Anthropic stream events, and the vLLM, Bedrock, and Ollama adapters each extract reasoning content. Every wrapper does `async for chunk in upstream_response` and yields something else. When the consuming StreamingResponse gets cancelled by a client disconnect, the chain unwinds and the wrappers get closed — but closing an async generator only runs its own body's cleanup, and none of those wrappers ever called `aclose()` on the httpx response they were iterating. The upstream socket stayed open on ogx's side. That's the CLOSE_WAIT.

So the first fix was mechanical: a helper that best-effort closes whatever stream a wrapper is iterating, called from every wrapper's `finally`:

```python
async def close_async_stream(stream: Any) -> None:
    close = getattr(stream, "aclose", None)
    if close is None:
        close = getattr(stream, "close", None)
    if close is None:
        return
    with contextlib.suppress(Exception):
        result = close()
        if inspect.isawaitable(result):
            await result
```

That landed in the OpenAI mixin, the Anthropic translation, and a new shared `wrap_reasoning_chunks` that replaced three near-identical copies across the vLLM, Bedrock, and Ollama providers. Each wrapper now closes its source on normal completion, upstream error, or consumer abandon. Local tests passed.

And the leak did not go away. The repro still showed CLOSE_WAIT sockets. That was layer two.

The API layer had its own wrapper, `_preserve_context_for_sse`, sitting between the route and the SSE stream. Its job was to preserve contextvars across the StreamingResponse task boundary — the route runs in one task, the response body streams in another, and ogx's provider configuration lives in contextvars. The way it did that was to run every `__anext__()` of the underlying generator in a freshly created task:

```python
task: asyncio.Task[str] = context.run(asyncio.create_task, event_gen.__anext__())
item = await task
```

One new task per chunk. The cancellation that a client disconnect triggers lands in whichever task is currently awaiting a chunk, and with a wrapper like this, repeated disconnects could interrupt the shielded transport cleanup in the generator chain below. In other words: the layer-one fix was correct, but the per-chunk task wrapper sat on top of it and could cancel the very cleanup that closes the upstream response.

The real fix removes the wrapper entirely. Provider context gets preserved at the source — the lazy library client wraps the body iterator in a context-preserving generator before it ever becomes an httpx stream — so the API routes hand the plain generator chain to StreamingResponse and the normal `sse_stream` cancellation path (catch CancelledError and GeneratorExit, `aclose()` the event generator) does its job in the natural unwind order. The context-preserving generator itself got hardened along the way: cancellation now counts as a reason to restore the caller's context, and when it's closed mid-iteration it closes its source while the provider context is still active.

A couple of loose ends worth noting. Streams that only have `close()` and no `aclose()` still work, because the helper accepts either. And a CodeQL pass over the diff surfaced a related hygiene issue: SSE error events were echoing raw exception messages to clients. The error formatters now pass documented 4xx client errors through and collapse everything else to a generic internal-server-error message, with the real details going to the server log. A differential test against main showed the old behavior leaking internal details in ten of twelve server-error cases.

The repro script ships in the repo now, so this stays testable: three abandoned streams, a short wait, and `ss` must report zero CLOSE_WAIT sockets between ogx and the mock upstream. On main it reported three. The full regression run is 181 tests, including the real inference route's disconnect handling and lazy library-stream closure.

Anyone running ogx in front of streaming inference with clients that abandon requests — cancelled generations, dropped mobile connections, browser tabs closed mid-token — was accumulating these sockets until file descriptors ran out. The incident report saw thirty-four against a single backend; it doesn't take many workers to burn a default fd limit that way.

The fix is merged in [ogx-ai/ogx PR 6506](https://github.com/ogx-ai/ogx/pull/6506). If you maintain anything that proxies streaming HTTP responses through async generator wrappers, the greppable lesson is this: every wrapper must close its source, and nothing above the wrappers may be allowed to cancel their cleanup.
