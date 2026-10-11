---
layout: post
title: "The retry skipped the document that failed"
permalink: /notes/swiftide-indexing-cache/
categories: [ai-engineering, retrieval, rust]
excerpt: "An embedding failure should leave a document available for retry. Swiftide's cache had already decided it was done."
---

The second run was supposed to recover the missing document. Instead, it skipped it.

An embedding or storage failure should leave work for a retry. In Swiftide, `filter_cached` could write the cache entry before either stage had finished. The next run saw that entry and treated the document as handled. A temporary downstream failure had become a persistent reason to leave the document out of the index.

My first sketch was embarrassingly short: move the cache write to the end. Then I tried to define what "the end" meant for a document that became several chunks, lost an error to `filter_errors`, and passed through a merged pipeline. Most of the work in this patch lives in that definition.

## The cache was claiming success too early

The original sequence was a cache miss, an immediate cache write, then downstream processing. If embedding or storage failed, the cache still remembered the early write. A retry faithfully skipped the source that needed another attempt.

For a retrieval pipeline, that failure is uncomfortable because the index can remain usable. Other documents are searchable, and a model can still produce an answer. The missing source shows up later as missing evidence. When debugging that kind of gap, I'd check whether the source reached the index before spending time on the embedding model or prompt.

The patch makes the filter record which sources need work. Cache writes happen in `run()`, after the stream finishes without an unhandled error. Nodes reaching the end provide completion candidates; the final decision also checks failures and which cache filters each source actually passed.

## Chunking changes the unit of completion

A cache lookup starts with a source document. A chunker can turn it into several derived nodes. The storage backend sees those children, so the pipeline needs to carry the original source identity all the way through.

Derived nodes now preserve the first source ancestor in `parent_id`. Redis, redb, and DuckDB cache integrations use that identity, and completion candidates are deduplicated. Several successful children can lead to one cache write for their source.

One successful child still doesn't prove the source finished. This is the regression I find most useful:

{% include indexing-completion.html %}

The chunker yields a child successfully, then returns an error. With `filter_errors`, the pipeline can store that child and return successfully. If completion relied only on the returned status and the stored child, the parent would be cached even though its fan-out failed partway through.

The patch records failed source IDs before the error can disappear from the stream. That history survives `filter_errors`, and the final marking phase excludes the source. The successful child stays stored; the source stays eligible for retry.

I like this test because it makes two plausible success signals insufficient on purpose. A stored node and an `Ok` result are both real. Neither one says that every part of the source completed.

## A merged pipeline needs branch history

There is another way to overstate completion. Suppose a source passes through the right branch's cache filter, then the branches merge. Marking it in the left branch's cache would claim work that branch never performed. A later change to the split predicate could then skip the source on the left.

The completion bookkeeping therefore uses pairs of cache registration and source ID. A completed source only updates a cache whose filter it actually passed. Independently built pipelines also link their failure and cache-pass registries when they merge, so the final decision can see both sides' history.

The rule is easier to review when I write out its conditions:

| Evidence at the end of `run()` | What it permits |
| :--- | :--- |
| The stream ended without an unhandled error | Enter the cache-marking phase |
| A source has a descendant that reached the end | Consider that source for completion |
| No failure was recorded for that source | Keep it eligible for marking |
| The source passed this cache's filter | Mark it in this cache |

The distinction between a source ID and a `(cache, source)` pair was the part I had to be most careful with. Deduplicating sources solves repeated writes after chunking. It doesn't establish which branch did the work.

## Retrying can repeat successful writes

An unhandled stream error exits `run()` before cache marking. A source that completed earlier in the same run can therefore be processed again next time. Storage and cache updates aren't one transaction, so downstream writes still need appropriate retry behavior, such as idempotent persistence where the application requires it.

I'm willing to accept that repeated work here. It has a path to recovery. A premature cache entry can keep the unfinished source out of every later run unless someone invalidates it. For an indexing job, that is a much harder failure to notice from the query side.

The final cache writes use bounded concurrency rather than a serial round trip for every source. The trait also gains a required `NodeCache.set_by_id` method, so custom cache implementations need to support the deferred write. This is an API cost worth making visible when adopting the change.

The merged regressions cover ordinary success and failure, parent deduplication after chunking, partial chunk failure, and branch-specific completion. What I want to see in an indexing review now is the source's retry path: if any stage loses part of this document, what state makes the next run pick it up again?

My [Swiftide PR #1164](https://github.com/bosun-ai/swiftide/pull/1164) merged on September 16, 2026. [Changes and regression tests](https://github.com/bosun-ai/swiftide/pull/1164/files) · [Pipeline at the merge commit](https://github.com/bosun-ai/swiftide/blob/ad42fa97caee7e0702711222d28ec9c6f56c84d5/swiftide-indexing/src/pipeline.rs).
