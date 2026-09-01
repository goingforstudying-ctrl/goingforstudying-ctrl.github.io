---
layout: post
title: "The IO error hiding inside an Arc"
---

Sometimes the most expensive bug in a system is the one that only shows up when the failure it was designed to absorb stops getting absorbed. That's what I hit in Apache DataFusion Ballista while running queries with hash joins against flaky object storage: a transient IO failure on the join's build side killed the entire job instead of being retried. The fix was a one-line change in [datafusion-ballista PR #2119](https://github.com/apache/datafusion-ballista/pull/2119) — one line, because the diagnosis is where all the work was.

Ballista has a retry classifier in `ballista/core/src/error.rs` that turns an error into a `FailedTask` and decides whether the scheduler should retry it. The retryable arm looked like this:

```rust
BallistaError::DataFusionError(e)
    if matches!(*e, DataFusionError::IoError(_)) =>
{
    FailedTask {
        retryable: true,
        count_to_failures: true,
        failed_reason: Some(FailedReason::IoError(IoError {})),
    }
}
```

Read it carefully: `matches!` inspects the outermost variant of the error. That's fine as long as the `IoError` arrives bare. But DataFusion wraps errors in `DataFusionError::Shared` — an `Arc<DataFusionError>` — when a single error has to be propagated to multiple consumers. That's exactly what happens on the build side of a hash join, where one input stream is shared across all the consumers of the build table. So under AQE, the error that reaches the classifier isn't `IoError(..)`, it's `Shared(Arc(IoError(..)))`. The `matches!` misses, the error falls through to the catch-all:

```rust
other => FailedTask {
    retryable: false,
    count_to_failures: false,
    failed_reason: Some(FailedReason::ExecutionError(ExecutionError {})),
}
```

and a transient S3 timeout becomes a permanent job failure. The retry logic exists precisely for this case, and it's precisely the case where it silently did nothing.

The reproduction story is what convinced me the wrapping was the culprit rather than something about AQE itself. The Ballista chaos harness from issue #2026 has a scenario called `retryable_fault_is_retried_and_result_is_correct`, which injects exactly one `DataFusionError::IoError` from a UDF on a join input, with a cluster-wide budget of exactly one fault. So the retry is guaranteed to succeed if it happens at all. With AQE off, the error reached the classifier unwrapped, got marked retryable, the task retried, and the query returned the correct result. With AQE on, the same error arrived inside `Shared`, missed the match, and the job failed. Same fault, same cluster, opposite outcomes — the only variable was whether the error wore a wrapper.

The fix uses a tool DataFusion already provides: `find_root()`. It's a non-recursive walk of the error's `source()` chain that remembers the deepest `DataFusionError` it finds, downcasting through the `Arc` that `Shared` uses along the way. Classifying on the root error instead of the outermost wrapper sees through `Shared` — and through `Context` wrappers, which also lose the type information a shallow match needs:

```rust
BallistaError::DataFusionError(e)
    if matches!(e.find_root(), DataFusionError::IoError(_)) =>
```

The change itself is trivial; the unit tests are where I spent the effort. Five of them, covering the bare case, the `Shared`-wrapped case, and a `Context`-wrapped-`Shared` case, each asserting `retryable: true`. The other two are the negative cases: a `Plan` error, bare and `Shared`-wrapped, must stay non-retryable. Those matter more than they look, because the lazy fix for this bug is to flip the fallback — "can't see the type, so retry everything." That would take transient IO failures and retry them forever alongside genuine execution errors, burning cluster capacity on tasks that will never succeed. Seeing through the wrapper and only the wrapper is the whole point.

I couldn't run the full chaos harness locally, but the classifier paths are covered directly by the unit tests, and `cargo clippy` was clean. The issue behind the PR, [#2028](https://github.com/apache/datafusion-ballista/issues/2028), also named the broader pattern: structured errors lose their type crossing the DataFusion boundary, and retryability gets decided by shallow matches that can't see through the wrapping. There's a sibling issue around `FetchFailed` with the same shape.

If you run Ballista with AQE enabled and joins against anything network-attached, this is the bug you'd meet as a mysterious "why didn't it just retry" postmortem finding. The failure is rare by design — object storage has to fail, and it has to fail on the build side of a join, and AQE has to be on. But when all three line up, the cluster's entire reason for retrying is silently defeated, and the fix that lands in your logs is indistinguishable from the error you were supposed to survive.
