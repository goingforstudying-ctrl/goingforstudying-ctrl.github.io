---
layout: post
title: "The IO error hiding inside an Arc"
---

A transient I/O error can become a permanent task failure when a retry classifier inspects the wrong layer of an error. [Ballista PR #2119](https://github.com/apache/datafusion-ballista/pull/2119) changed one condition so the classifier could recognize I/O errors wrapped by DataFusion, and added regression tests around that distinction.

Ballista has a retry classifier in `ballista/core/src/error.rs` that turns an error into a `FailedTask` and decides whether the scheduler should retry it. The retryable arm looked like this (excerpt with the error-text field omitted):

```rust
BallistaError::DataFusionError(e)
    if matches!(*e, DataFusionError::IoError(_)) =>
{
    FailedTask {
        retryable: true,
        count_to_failures: true,
        failed_reason: Some(FailedReason::IoError(IoError {})),
        // error: ... (omitted)
    }
}
```

Read it carefully: `matches!` inspects the outermost variant of the error. That's fine as long as the `IoError` arrives bare. But DataFusion wraps errors in `DataFusionError::Shared` — an `Arc<DataFusionError>` — when a single error has to be propagated to multiple consumers. That's exactly what happens on the build side of a hash join, where one input stream is shared across all the consumers of the build table. So under AQE, the error that reaches the classifier isn't `IoError(..)`, it's `Shared(Arc(IoError(..)))`. The `matches!` misses, the error falls through to the catch-all (again omitting the error-text field):

```rust
other => FailedTask {
    retryable: false,
    count_to_failures: false,
    failed_reason: Some(FailedReason::ExecutionError(ExecutionError {})),
    // error: ... (omitted)
}
```

and a retryable I/O failure represented by that wrapped variant becomes a permanent job failure. The retry logic exists precisely for this case, and it's precisely the case where it silently did nothing.

The reproduction described in the issue distinguished the wrapper from AQE itself. The Ballista chaos harness from [issue #2026](https://github.com/apache/datafusion-ballista/issues/2026) has a scenario called `retryable_fault_is_retried_and_result_is_correct`, which injects exactly one `DataFusionError::IoError` from a UDF on a join input, with a cluster-wide budget of exactly one fault. That isolates the injected fault; a retry can still fail for an independent reason. With AQE off, the error reached the classifier unwrapped, got marked retryable, the task retried, and the query returned the correct result. With AQE on, the same error arrived inside `Shared`, missed the match, and the job failed. Same fault, same cluster, opposite outcomes — the only variable was whether the error wore a wrapper.

The fix uses a tool DataFusion already provides: `find_root()`. It's a non-recursive walk of the error's `source()` chain that remembers the deepest `DataFusionError` it finds, downcasting through the `Arc` that `Shared` uses along the way. Classifying on the root error instead of the outermost wrapper sees through `Shared` — and through `Context` wrappers, which also lose the type information a shallow match needs:

```rust
BallistaError::DataFusionError(e)
    if matches!(e.find_root(), DataFusionError::IoError(_)) =>
```

The implementation change is small; the unit tests explain the intended classification. Five of them, covering the bare case, the `Shared`-wrapped case, and a `Context`-wrapped-`Shared` case, each asserting `retryable: true`. The other two are the negative cases: a `Plan` error, bare and `Shared`-wrapped, must stay non-retryable. Those matter more than they look, because the lazy fix for this bug is to flip the fallback — "can't see the type, so retry everything." That would classify genuine execution errors as retryable too, wasting retry attempts and cluster capacity; the scheduler still has its own retry limits. Seeing through the wrapper and only the wrapper is the whole point.

The added unit tests cover the classifier directly. They do not, on their own, establish end-to-end recovery in every chaos scenario. The issue behind the PR, [#2028](https://github.com/apache/datafusion-ballista/issues/2028), also named the broader pattern: structured errors lose their type crossing the DataFusion boundary, and retryability gets decided by shallow matches that can't see through the wrapping. There's a sibling issue around `FetchFailed` with the same shape.

The reported trigger involved AQE and a hash join, but the classifier defect was not inherently limited to that combination: a wrapped `IoError` reaching the same path could be misclassified. The fix preserves the distinction between retryable I/O failures and non-retryable plan errors, while seeing through the wrappers that previously obscured it.

Implementation reference: [merged commit](https://github.com/apache/datafusion-ballista/commit/b16270801249a3422e9384ddf4a52bf92e332e87) (2026-07-21).
