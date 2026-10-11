---
layout: post
title: "The retry skipped the document that failed"
permalink: /notes/swiftide-indexing-cache/
categories: [ai-engineering, retrieval, rust]
excerpt: "An embedding failure should leave a document available for retry. Swiftide's cache had already decided it was done."
---

An embedding request fails. You run the indexing job again, expecting it to pick up the missing document. Instead, the cache says the document has already been handled, and the pipeline skips it.

That was possible in Swiftide because `filter_cached` wrote the cache entry as soon as a node passed the filter. Embedding and storage were still ahead of it. A temporary failure could leave behind a durable instruction to skip the work.

"Move the cache write later" sounds like a small fix. I thought so too. The word *later* got less comfortable once I followed a document through chunking and error filtering.

## The cache got there first

The ordering made the failure repeatable:

1. The cache lookup misses.
2. The filter writes the cache entry and passes the node downstream.
3. Embedding or storage fails.
4. The next run finds the cache entry and skips the document.

The patch makes passing the filter a record of work to do. It registers the cache with the pipeline and remembers which source IDs passed that cache's filter. During `run()`, nodes that reach the end become completion candidates. The pipeline writes cache entries after the stream finishes without an unhandled error.

That fixes the straightforward case. The more interesting case is a pipeline that returns successfully after something inside it failed.

## One stored chunk doesn't finish the document

The cache sees a source document. A chunker may turn it into many derived nodes, and storage sees those children. If the children lose their source identity, there's no reliable way to mark the original document complete.

Derived nodes now carry a `parent_id` that preserves the first source ancestor. The Redis, redb, and DuckDB cache integrations use that identity, and completion candidates are deduplicated. Several stored chunks can produce one cache write for their source.

Then comes `filter_errors`. It's useful when you want a job to continue despite individual failures, but it also removes errors from the stream. A clean finish can therefore hide a failed chunk. If one sibling reaches storage, marking the whole document cached would make the missing sibling hard to recover on a retry.

The pipeline records failed source IDs before those errors can be filtered away. The final marking phase excludes those sources.

My favorite regression in this patch is deliberately awkward: the chunker yields one successful child, then an error, and the pipeline uses `filter_errors`. The child gets stored. The parent stays uncached. It checks the case where a successful return would otherwise be misleading.

## A merge has to remember which branch did the work

Suppose a document passes through the right branch's cache filter, then the branches merge. Writing that document into the left branch's cache would claim the left branch had processed it too. On a future run, that claim could suppress work the branch had never done.

The patch keeps pairs of cache registration and source ID, so completion only updates caches whose filters that source actually passed. It also links the failure registries of independently built pipelines when they merge. A branch's failed document stays failed after the merge.

This is where the fix grew beyond moving a write. Completion needs a source identity and a history of where that source went.

## The repeat work I'm willing to accept

An unhandled stream error exits `run()` before cache marking. Even documents that completed earlier can be processed again next time. The cache and the storage backend aren't one transaction, so downstream writes still need suitable retry behavior.

That cost is visible and recoverable. A cache entry for unfinished work can quietly keep the document out of the index. I want the cache to make the stronger claim, even when a failed run leaves more work for the next one.

The change also adds a required `NodeCache.set_by_id` method. Custom cache implementations need to implement the deferred write. The merged regressions cover the ordinary success and failure paths, plus the partial chunk failure and branch-specific completion cases above.

My [Swiftide PR #1164](https://github.com/bosun-ai/swiftide/pull/1164) merged on September 16, 2026. [Changes and regression tests](https://github.com/bosun-ai/swiftide/pull/1164/files) · [Pipeline at the merge commit](https://github.com/bosun-ai/swiftide/blob/ad42fa97caee7e0702711222d28ec9c6f56c84d5/swiftide-indexing/src/pipeline.rs).
