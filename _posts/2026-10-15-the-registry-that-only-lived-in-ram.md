---
layout: post
title: "The registry that only lived in RAM"
permalink: /notes/the-registry-that-only-lived-in-ram/
categories: [persistence, python]
excerpt: "ogx's Milvus, Chroma, and Weaviate providers registered vector stores into an in-memory dict and read them back from the kvstore. Anything created at runtime vanished on restart — and in a multi-instance setup, it was never visible anywhere else to begin with."
---

A `file_search` call against ogx came back empty after a server restart, and it did it silently — no error page, no failed health check, just a search tool that found nothing in a vector store that definitely existed an hour ago. That sent me into the vector IO provider code, where I found a split-brain registry: the Milvus, Chroma, and Weaviate providers wrote vector store metadata to one place on registration and read it back from a different place on startup.

The two places are `self.cache`, a plain in-memory dict, and `self.kvstore`, the configured persistence layer (sqlite, postgres, whatever the deployment uses). Every provider has both. The registry contract is that the kvstore is the source of truth and the cache is a read-through optimization: `initialize()` rebuilds the cache from the kvstore on boot, and `_get_and_cache_vector_store_index()` falls back to the kvstore on a cache miss.

## Write here, read there

The Milvus, Chroma, and Weaviate providers broke that contract in `register_vector_store`. They created the backing collection, put the metadata into `self.cache`, and stopped there — the kvstore write never happened:

```python
async def register_vector_store(self, vector_store: VectorStore) -> None:
    collection = await maybe_await(
        self.client.get_or_create_collection(...)
    )
    self.cache[vector_store.identifier] = VectorStoreWithIndex(...)
    # nothing written to self.kvstore
```

The damage is precise. Stores listed in the distribution config are re-registered on startup, so they survive restarts — the bug is invisible for anything statically configured. But a store created at runtime through the API, `client.vector_stores.create(...)`, lives only in the handling process's RAM. Restart the server and `initialize()` reads the kvstore, finds nothing, and the store is gone: `file_search` hits `_get_and_cache_vector_store_index`, misses the cache, misses the kvstore, and raises `VectorStoreNotFoundError`, which the tool layer swallows into an empty result set. In a horizontally scaled deployment it's worse in a different way — no restart needed. The store is only visible to whichever instance happened to serve the create call, so any request routed to a sibling fails immediately.

The annoying part is that the other providers already did this right. pgvector, sqlite_vec, and qdrant all write the metadata to the kvstore under a `VECTOR_DBS_PREFIX` key on register and delete it on unregister. Milvus, Chroma, and Weaviate were simply missing the same two calls. An earlier attempt at this fix had stalled without tests, so I picked it up with the goal of matching the existing pattern exactly rather than inventing a new one.

## The fix is two calls per provider

Registration now writes the serialized store to the kvstore before touching the backend:

```python
async def register_vector_store(self, vector_store: VectorStore) -> None:
    if self.kvstore is None:
        raise RuntimeError(
            "KVStore not initialized. Call initialize() before registering vector stores."
        )
    key = f"{VECTOR_DBS_PREFIX}{vector_store.identifier}"
    await self.kvstore.set(key=key, value=vector_store.model_dump_json())

    collection = await maybe_await(...)
    self.cache[vector_store.identifier] = VectorStoreWithIndex(...)
```

Unregistration gets the symmetric delete, and it deliberately runs even when the store isn't in the local cache — that's the multi-instance case, where the store was registered on a different process. The old code returned early on a cache miss, which would have leaked the kvstore entry forever.

Weaviate needed one deviation. Its kvstore is legitimately optional — a deployment can run Weaviate with no persistence configured at all, in which case the documented behavior is "registry will not persist across restarts." Raising `RuntimeError` there would break configurations that were working as advertised. So Weaviate guards both the write and the delete with `if self.kvstore is not None:` and keeps its opt-in persistence semantics. Milvus and Chroma always have a kvstore by the time register can be called, so they get the same fail-fast guard the other providers use.

## Testing the restart, not just the write

The tests are parametrized over all three providers and use a real sqlite kvstore with mocked backend clients — no Milvus, Chroma, or Weaviate server required. Three assertions per provider: registration lands the metadata in the kvstore, unregistration removes it, and — the one that actually captures the bug — a *fresh adapter instance* built on the same kvstore can resolve the store. That last test is a simulated restart: new process, empty cache, same disk. It fails on main and passes with the fix, which is the property I care about. The mocked-clients approach does mean the tests don't prove the Chroma collection actually got created, but that's the backend client's contract, not the registry's — what changed here is where the metadata lives.

One test-infrastructure note: the providers import their backend SDKs at module load, so the test file stubs `pymilvus`, `chromadb`, and `weaviate` in `sys.modules` before importing the adapters, following a pattern already used elsewhere in the suite. It keeps the unit tests fast and dependency-free, at the cost of some ugly boilerplate at the top of the file.

Who hits this in production: any ogx deployment that creates vector stores through the API rather than listing them in config — which is exactly how the Responses API's `file_search` flow is meant to be used — and any deployment running more than one instance behind a load balancer, where the store was a single-process secret even while everything was healthy.

My [ogx PR #6371](https://github.com/ogx-ai/ogx/pull/6371) merged on August 20, 2026. [Implementation and tests](https://github.com/ogx-ai/ogx/pull/6371/files).
