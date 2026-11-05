---
layout: post
title: "The sockets the disconnects left behind"
permalink: /notes/the-sockets-the-disconnects-left-behind/
categories: [python, asyncio, streaming]
excerpt: "Every abandoned streaming request to the ogx inference server leaked an upstream HTTP socket in CLOSE_WAIT. Closing the provider wrappers wasn't enough — the real culprit was a per-chunk asyncio task that could interrupt shielded socket cleanup."
---

The first hint was the socket count. An ogx server that had been proxying streaming chat completions for a while accumulated TCP connections in `CLOSE_WAIT`, and the count tracked suspiciously well with how busy the streaming routes had been. `CLOSE_WAIT` means the remote end closed and your side never got around to calling close — the kernel is holding the socket until your process releases it. Clients disconnect from streams all the time: browsers close, mobile clients lose signal, callers hit their own timeouts. That's normal traffic, and it was costing one upstream socket per disconnect.

I wrote a small reproducer to be sure: fire a handful of requests at a streaming route backed by a mock upstream, abandon each one after the first chunk, wait a few seconds, then ask `ss` how many sockets to the mock are sitting in `CLOSE_WAIT`. On main the answer matched the number of abandoned requests exactly. Three abandoned streams, three leaked sockets. Deterministic leaks are the best kind — this one was going to be fixable.

## The obvious fix, and why it wasn't enough

The ogx providers (vLLM, Ollama, Bedrock, the OpenAI-compatible mixin) don't hand you a raw HTTP stream. They wrap the upstream response in layers of async generators — extracting reasoning content, translating formats, normalizing chunk shapes. None of those wrappers closed anything. When the downstream client vanished, the wrapper generator got garbage collected eventually, but nothing ever called `close()` on the underlying SDK stream, and closing is precisely what releases the httpx response back to its connection pool.

So the first pass added a best-effort close helper that tolerates the two naming conventions in the wild (`aclose` on most async generators, `close` on the OpenAI SDK's streams), and ran it from a `finally` in every wrapper:

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

That genuinely fixed the provider side — the wrappers now close their source on normal completion, on upstream error, and on consumer abandonment. But the leak against the real server route was still there. The reproducer kept reporting leaked sockets, which meant a second bug was sitting between the route and the provider.

## A task per chunk, right through the cancellation shield

The route layer had its own wrapper, `_preserve_context_for_sse`. Its job was legitimate: Starlette's `StreamingResponse` iterates the body in a different task, so request-scoped contextvars get lost, and this wrapper captured the context and replayed it. The problem was how it did that — it ran every single chunk's `__anext__()` inside a freshly created `asyncio.Task`:

```python
task: asyncio.Task[str] = context.run(asyncio.create_task, event_gen.__anext__())
item = await task
```

Here's why that matters. When a client disconnects, Starlette cancels the body iteration. The underlying httpx transport closes its socket inside an `anyio.CancelScope(shield=True)` — a deliberate "let me finish, this is cleanup" region. AnyIO can protect that shield because it tracks the cancellation state of the tasks it manages. A raw `asyncio.Task` created behind AnyIO's back isn't in that bookkeeping. A second cancellation arriving while the shielded close was in flight could land inside the transport's cleanup and interrupt it — the exact sequence the shield exists to prevent. The socket close got abandoned mid-flight, and `CLOSE_WAIT` is what that looks like from outside.

This explained why closing the wrappers wasn't sufficient: the cleanup itself was being raced.

## Removing the wrapper instead of repairing it

The fix, in [PR #6506](https://github.com/ogx-ai/ogx/pull/6506), deletes the per-chunk task wrapper entirely and moves context preservation down to where the stream is born. Matthew Farrellee's companion change (from #6528, which this branch incorporates) wraps the lazy library client's body iterator in the existing `preserve_contexts_async_generator` helper, so the provider context travels with the stream itself instead of being re-established per chunk at the route. The route now hands `sse_stream(...)` straight to `StreamingResponse`, and no stray tasks get created anywhere in the pipeline.

The generator helpers also learned to be honest about abandonment. `sse_stream` previously only closed its inner generator on `CancelledError`; it now treats `GeneratorExit` the same way, because `aclose()` on the outer generator is how a polite consumer (or a shutting-down server) says "stop". And `preserve_contexts_async_generator` now restores the caller's context on `BaseException` — cancellation included, since `CancelledError` doesn't inherit from `Exception` on modern Python — and closes its source generator while the provider context is still active if the wrapper itself gets closed. Iterator-only response bodies without `aclose` still work; everything is best-effort.

One more thing fell out of the review: the SSE error formatters serialized exception messages straight into the stream. A differential check against main showed internal details leaking in ten of twelve server-error cases. Now 4xx errors keep their documented client-facing messages, while unknown and 5xx errors go out as a generic "unexpected error" line, with the full exception staying in the server logs where it belongs.

## Counting sockets again

Same reproducer, same mock upstream, same seven-second wait:

| Build | CLOSE_WAIT after 3 abandoned streams |
| --- | ---: |
| main | 3 |
| wrappers-only fix | 3 |
| full fix | 0 |

The wrappers-only row is the one I keep thinking about. Each individual change looked correct in isolation, and the leak survived it — because the second bug lived in a different layer, in code whose job description (context propagation) had nothing to do with sockets. The regression tests now exercise the real inference route's disconnect path and assert that the upstream generator's cleanup actually completes, shielded cancellation and all. 181 tests pass on the final head.

The broader lesson I took from this one: in an async pipeline, every layer that wraps a stream owns that stream's lifecycle. "The consumer abandoned it" is not a terminal state you can ignore — it's a state you have to handle explicitly, because someone further down is holding a file descriptor that only your close call will release.
