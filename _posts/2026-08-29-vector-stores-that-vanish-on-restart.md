---
layout: post
title: "Vector stores that vanish on restart"
---

Every so often you get a bug report where the repro is three lines long but the fix takes a week of archaeology. This one came from digging into why `file_search` silently returned empty results after a server restart in OGX.

Here's what a user sees: they create a vector store through the client API (`client.vector_stores.create(...)`), upload some files, run queries, everything works. Then the server restarts — a deploy, a crash, whatever — and the same store suddenly returns nothing. No error, no warning, just empty results. The vector database still has the data in it. The store just isn't resolvable anymore.

The root cause turned out to be a split between two sources of truth. In OGX's remote vector-io providers, the actual vectors live in the backend (Milvus, Chroma, or Weaviate), but the store's metadata — identifier, embedding model, dimensions — lives in a kvstore. The provider's `initialize()` reads that metadata back from the kvstore to rebuild its registry. The problem: `register_vector_store()` in the Milvus, Chroma, and Weaviate adapters only ever wrote to the in-memory `self.cache`. They never touched the kvstore.

So a store created at runtime existed in exactly one place: the process memory of whichever instance happened to handle the create call. Restart the process and it's gone. Run more than one instance, which is the normal deployment shape, and the store is only visible to the instance that created it — every other instance's queries fail to resolve the metadata and come back empty. The pgvector, sqlite_vec, and qdrant providers had the kvstore write all along, which is why the bug only showed up on these three backends.

The fix is small but has to be right in all three providers. On register, serialize the `VectorStore` model and write it under the provider's key prefix:

```python
async def register_vector_store(self, vector_store: VectorStore) -> None:
    if self.kvstore is None:
        raise RuntimeError("KVStore not initialized. Call initialize() before registering vector stores.")
    key = f"{VECTOR_DBS_PREFIX}{vector_store.identifier}"
    await self.kvstore.set(key=key, value=vector_store.model_dump_json())
    collection = await maybe_await(
        self.client.get_or_create_collection(...)
    )
```

And the matching delete on unregister. The old unregister also returned early when the store wasn't in the local cache, which meant a store created by another instance could never be cleaned up from this one; the kvstore delete now runs regardless.

One wrinkle worth spelling out: Weaviate's kvstore is optional. Persistence can simply be unconfigured, in which case "registry will not persist across restarts" is documented, expected behavior. So there the write and delete are skipped when no kvstore is set, rather than raising. Milvus and Chroma always have a kvstore by the time register can be called, so they get the same guard the other providers use.

Testing this was the interesting part, because the bug is fundamentally about process lifetimes. I parametrized a new test module over all three providers with a real sqlite kvstore and mocked backend clients, and the key test simulates a restart by constructing a brand-new adapter on the same kvstore and asking it to resolve the store the first adapter registered. On main that test fails — the fresh adapter can't see the store. With the write in place it resolves fine. The register-persists and unregister-removes cases are the other two legs. The whole `tests/unit/providers/vector_io/` suite comes out at 286 passing.

There was actually a prior attempt at this that stalled out without tests, which is probably why the issue sat open for a while. The write itself is four lines; the value is in proving the restart scenario and covering all three backends symmetrically.

Who hits this in production? Anyone running OGX with vector stores created through the API rather than through config: every restart loses the registry, and every multi-instance deployment gets store visibility that depends on which instance handled the create. The failure mode is silent, which is the worst kind — an agent or user querying a store that should exist gets empty results and has no way to know the metadata registry forgot about it.

The merged fix is in [ogx-ai/ogx PR 6371](https://github.com/ogx-ai/ogx/pull/6371). If you maintain a provider with a similar cache-plus-kvstore split, it's worth grepping your register path for whether the kvstore write exists on every backend, not just the one you happen to use.
