---
layout: post
title: "The cache that remembered success that never happened"
---

I ran into this while watching a continuously restarting indexing job against Qdrant: documents were quietly disappearing from the index. Not at random — specifically whenever the embed or store step hiccuped. A rate limit from the embedding provider, a dropped connection, whatever. The document just never came back. Restart the job and it skipped the missing docs as if they had never existed, every single run.

This was in Swiftide, the Rust framework for building RAG indexing pipelines. The pipeline is a stream of nodes: load files, chunk them, embed, store. The `filter_cached` stage sits near the front and answers one question per document: have I already indexed this? Cache hit means drop the node, miss means let it through. The bug was what happened right after the miss:

```rust
node_trace_log!(cache, node, "node not in cache, processing");
cache.set(&node).await;
Ok(Some(node))
```

The cache entry was written the moment the node passed the filter. "In the cache" and "successfully indexed" were two different claims, and the code treated them as one. Anything that failed downstream — embedding, storing — was already marked processed. Next run, the cache answered "done" and the document was skipped before it ever got a second chance. A cache that remembers success that never happened.

The fix sounds obvious in retrospect: mark a node only once it actually reaches the end of the stream. What made it non-trivial here was the type system. Pipeline stages are typed, and the node type changes as documents move through: a string node becomes something else after chunking, something else again after embedding. The cache registered in `filter_cached` is bound to the input node type, so you can't just hand it end-of-stream nodes and call `set`. An earlier attempt at this exact fix moved the marking into a background task fed by a channel and got reverted — too much machinery, extra drain and await semantics to keep right. This take instead keeps the caches registered with the pipeline as type-erased closures and, inside `run()`, marks a node id once it survives to the end of the stream:

```rust
while let Some(node) = self.stream.try_next().await? {
    total_nodes += 1;
    if !self.node_caches.is_empty() {
        let id = node.parent_id.unwrap_or_else(|| node.id());
        if cached_ids.insert(id) {
            for mark_cached in &self.node_caches {
                mark_cached(id).await;
            }
        }
    }
}
```

Nothing to drain, nothing to await.

Chunking added its own wrinkle. One document fans out into fifty chunks, each a new node with its own id. If end-of-stream marking cached chunk ids, the filter at the front — which checked the document id — would never see them, and the cache would stop deduplicating entirely. So nodes now carry a `parent_id`, set in `build_from_other` to point at the first node that entered the pipeline. A document split into fifty chunks is cached once, under the id the filter originally checked, and the redis, redb, and duckdb integrations all prefer that id when building cache keys.

I made the new `set_by_id` a required method on the `NodeCache` trait rather than giving it a default implementation. A default that silently does nothing would have been a footgun for anyone with a custom cache: the pipeline would believe it was marking nodes and never would be. Breaking the trait felt better than a silent lie.

What this doesn't fix: if one chunk out of fifty fails and the pipeline has `filter_errors` enabled, the other forty-nine still mark the document cached. Doing that properly needs per-document chunk accounting, which was out of scope.

The tests cover the failure mode directly: a transformer that errors means nothing gets cached; a successful run caches exactly once; an already-cached node is skipped and never re-marked; three chunks from one parent produce a single cache write under the parent id; two registered caches both get marked.

Who hits this? Anyone running `filter_cached` against a provider that occasionally fails, which is most people embedding against real APIs. The failure is silent and cumulative: the index quietly loses documents, and since the whole point of the cache is making reruns cheap, the rerun that should heal it is exactly the thing that can't.

The full change: https://github.com/bosun-ai/swiftide/pull/1164
