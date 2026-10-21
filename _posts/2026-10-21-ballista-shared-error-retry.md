---
layout: post
title: "The wrapper that made a transient error fatal"
permalink: /notes/ballista-shared-error-retry/
categories: [distributed-systems, rust]
excerpt: "Ballista's retry classifier matched only the outermost error variant. One Shared wrapper around an IO error turned a designed-for retry into a permanent job failure."
---

I was running Ballista queries with joins against flaky object storage, watching a transient IO error do something it had no business doing: kill the whole job. A read hiccup on the build side of a hash join is the textbook case for a retried task. Instead the scheduler marked it permanent and the query failed.

Same storage, same flakiness — and with the adaptive query execution path off, the same kind of error retried fine. That asymmetry was the clue. The difference wasn't the error. It was the packaging.

## The classifier only looked at the outermost variant

Ballista decides whether a failed task is worth retrying in one place, the conversion from `BallistaError` to `FailedTask` in `ballista/core/src/error.rs`. The IO arm was a shallow match:

```rust
BallistaError::DataFusionError(e)
    if matches!(*e, DataFusionError::IoError(_)) =>
```

That asks one question: is the outermost variant an `IoError`? It works for errors that arrive bare. But a hash join's build side is computed once and shared across consumers, so when it fails, every consumer needs to observe the same failure. DataFusion wraps that in `DataFusionError::Shared` — an `Arc` around the real error. Now the outermost variant is `Shared`, the `matches!` never fires, and execution falls through to the catch-all arm: `retryable: false`.

One wrapper, and a retry the system was designed to do becomes a job failure. The AQE-off runs worked because on that path the error arrives unwrapped, which is what pointed me at the wrapping rather than the IO layer.

## The fix is a function DataFusion already had

DataFusion's error type already ships `find_root()`, which unwraps `Shared` and `Context` layers to reach the underlying error. Classifying on the root instead of the wrapper is one line:

```rust
-                if matches!(*e, DataFusionError::IoError(_)) =>
+                if matches!(e.find_root(), DataFusionError::IoError(_)) =>
```

I like fixes where the diff is mostly tests, and this is one. The [PR](https://github.com/apache/datafusion-ballista/pull/2119) adds five unit tests around that line. Three pin down what must be retryable: a bare `IoError` (the regression net for the old path), a `Shared`-wrapped `IoError` (the bug itself), and a `Context`-wrapped `Shared` `IoError`, because real errors from the query layer tend to carry context on top of the share. Two more are guard rails: a `Plan` error stays non-retryable, and a `Shared`-wrapped `Plan` error stays non-retryable too.

Those guard rails are the part I'd want as a reviewer. Once you start unwrapping, you've changed the semantics of every arm in the match, not just the one you were fixing. "Look deeper" has to mean "classify the real error," not "find something retryable anywhere in the chain." The tests make that explicit: a shared planning error is still a permanent failure, because it is one.

## Why this shape of failure matters

The wrapped case isn't exotic — it's arguably the most important IO failure in a distributed query engine. A transient read error on a join's build side doesn't just fail one partition's work; it fails the shared structure every probe-side consumer is waiting on. That's precisely the failure you most want the scheduler to retry, and precisely the one the shallow match was guaranteed to miss. Errors that affect one consumer arrive bare and were classified fine. Errors that affect everyone arrive wrapped and were fatal.

There's a general shape here worth remembering: any classifier that pattern-matches on the outermost variant of an error enum is silently assuming that errors arrive unwrapped. Every `Arc`-shared error, every context wrapper, every "with source" layer is a place where that assumption quietly stops holding. If the classifier decides something expensive — like whether to redo a large chunk of compute — it has to classify the root.

What I didn't do: a related issue (#2026) describes a cluster chaos harness for exercising these paths end to end, and I didn't get that running locally. The unit tests cover the classifier paths directly, and the change is a pure read of the error tree — nothing changes beyond the classification itself — so I was comfortable with that scope. `cargo test -p ballista-core --lib error::` passes all five new tests, and clippy is clean.

Who feels this: anyone running DataFusion-backed distributed queries against object storage, where transient IO is routine and retry is the whole recovery strategy. The retry policy existed and was correct. A one-level-deep match made it unreachable for exactly the failures that needed it most.

My [Ballista PR #2119](https://github.com/apache/datafusion-ballista/pull/2119) merged on July 21, 2026. [Implementation and tests](https://github.com/apache/datafusion-ballista/pull/2119/files).
