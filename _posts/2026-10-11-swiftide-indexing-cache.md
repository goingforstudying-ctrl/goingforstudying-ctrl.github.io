---
layout: post
title: "Caching a document before indexing it can make a failure permanent"
permalink: /notes/swiftide-indexing-cache/
categories: [ai-engineering, retrieval, rust]
excerpt: "Swiftide marked documents cached before embedding and storage finished. Moving the write later also meant tracking failures across chunks and pipeline branches."
---

An indexing job can fail to embed or store a document, then skip that document on every retry. In Swiftide, `filter_cached` used to write the cache entry as soon as a node passed the filter. The work downstream had barely started.

That was the problem behind my [Swiftide fix, #1164](https://github.com/bosun-ai/swiftide/pull/1164), merged on September 16, 2026. I want an indexing cache to mean that processing finished. An entry that only means "we started" turns a temporary downstream failure into missing data on later runs.

## Waiting for the stream to finish

The original sequence was:

1. The cache lookup misses.
2. The filter writes the cache entry and passes the node downstream.
3. Embedding or storage fails.
4. The next run finds the cache entry and skips the document.

The patch registers the cache with the pipeline and records which source IDs passed its filter. During `run()`, nodes reaching the end of the stream become candidates for caching. Cache writes happen after the stream finishes without an unhandled error.

I am willing to repeat some work here. If the stream returns an error, execution exits before the marking phase. Even documents that completed earlier can be processed again on the next run. The cache is not a transaction with the storage backend, so downstream writes still need retry behavior appropriate to that backend.

`NodeCache` gains a required `set_by_id` method for the deferred write. Custom cache implementations have to supply it; there is no default that silently pretends to record completion.

## A document can become many nodes

Chunking changes the unit of work. The cache checks a source document, but later stages may see dozens of derived nodes. Marking each chunk under its own ID would leave the original cache lookup unresolved.

Derived nodes now carry a `parent_id` that preserves the first source ancestor. The Redis, redb, and DuckDB cache integrations use that source identity. Completion candidates are deduplicated, so several successful chunks can lead to one cache write for their document.

A successful chunk also cannot tell us whether its siblings failed. Pipeline stages record failed source IDs before `filter_errors` can discard those errors. The marking phase excludes those sources, even when other chunks reached storage.

One regression makes this visible: the chunker yields a successful child, then an error, and the pipeline uses `filter_errors`. The successful child is stored, but the parent gets no cache write. A clean return from the filtered stream is not enough to call the document complete.

## Merged branches must keep their own cache history

There is another bookkeeping problem when pipelines split and merge. If a node only went through the right branch, marking it in the left branch's cache would let a later run skip work the left branch never did.

The patch records pairs of cache registration and source ID. After a merge, a completed source is marked only in the caches whose filters it actually passed. Failure registries from independently built pipelines are linked too, so merging does not lose a branch's failure history.

The merged tests cover successful completion, downstream failure, already-cached nodes, chunk deduplication, and multiple caches. They also check a chunker failing after its first successful child, cache scope across split branches, and failures carried through a merge of independent pipelines.

**Source:** [merged PR and regression tests](https://github.com/bosun-ai/swiftide/pull/1164/files), [pipeline implementation at the merge commit](https://github.com/bosun-ai/swiftide/blob/ad42fa97caee7e0702711222d28ec9c6f56c84d5/swiftide-indexing/src/pipeline.rs).
