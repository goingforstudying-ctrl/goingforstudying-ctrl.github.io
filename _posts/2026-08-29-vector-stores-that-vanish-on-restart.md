---
layout: post
title: "Vector stores that vanish on restart"
---

A vector database can keep every embedding while the API server forgets how to find the store. That was the restart failure addressed by [OGX PR #6371](https://github.com/ogx-ai/ogx/pull/6371).

A user can create a vector store through the client API (`client.vector_stores.create(...)`), upload files, and run queries successfully, then lose access through the API after the server restarts. The vector database can still hold the embeddings; the missing piece is the adapter's registry metadata.

The root cause turned out to be a split between two sources of truth. In OGX's remote vector-io providers, the actual vectors live in the backend (Milvus, Chroma, or Weaviate), but the store's metadata — identifier, embedding model, dimensions — lives in a kvstore. The provider's `initialize()` reads that metadata back from the kvstore to rebuild its registry. The problem: `register_vector_store()` in the Milvus, Chroma, and Weaviate adapters only ever wrote to the in-memory `self.cache`. They never touched the kvstore.

A store registered at runtime therefore had no durable metadata entry for a fresh adapter to reload. The pgvector, sqlite_vec, and qdrant providers already had a kvstore write, which helped identify the missing operations in these three adapters. Persistence fixes restart recovery; it does not, by itself, synchronize the caches of several already-running server instances.

The fix is small but has to be right in all three providers. On register, serialize the `VectorStore` model and write it under the provider's key prefix. This Chroma excerpt omits the collection arguments:

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

Unregister now removes the kvstore entry even when the store is absent from the local cache. That is a metadata-cleanup fix: in Chroma and Weaviate, deletion of the backend collection still depends on the local cache path. It does not guarantee complete physical deletion across instances, and cross-instance recovery requires access to the same persistent kvstore.

One wrinkle worth spelling out: Weaviate's kvstore is optional. Persistence can simply be unconfigured, in which case "registry will not persist across restarts" is documented, expected behavior. So there the write and delete are skipped when no kvstore is set, rather than raising. Milvus and Chroma always have a kvstore by the time register can be called, so they get the same guard the other providers use.

The regression tests cross an adapter lifetime boundary. A new test module runs three cases for each of the three providers, using a real sqlite kvstore and mocked backend clients. One case constructs a fresh adapter on the same kvstore and checks that it resolves the store registered by the first adapter. The other two check persistence after registration and removal after unregistering.

The useful regression is the adapter lifetime boundary: checking the original adapter would only prove that its in-memory cache works. Constructing a second adapter distinguishes a durable registration from a cache-only registration.

This matters when applications create vector stores through the API and rely on a configured kvstore to restore their registry after a restart. The backend data can remain intact while the adapter cannot resolve the store. Depending on the request path, that can surface as a missing store or empty search results; neither means the vector database deleted the embeddings.

The merged fix is in [ogx-ai/ogx PR 6371](https://github.com/ogx-ai/ogx/pull/6371). If you maintain a provider with a similar cache-plus-kvstore split, it's worth grepping your register path for whether the kvstore write exists on every backend, not just the one you happen to use.

Implementation reference: [merged commit](https://github.com/ogx-ai/ogx/commit/ba58eb12b57f85e570b237291278c14174e682b7) (2026-08-20).
