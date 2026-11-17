---
layout: post
title: "A failed rollback could take down every job behind it"
permalink: /notes/ballista-rollback-failure-hang/
categories: [distributed-systems, schedulers]
excerpt: "Ballista's executor-loss path used `?` on a stage rollback. When the rollback itself failed, the job hung, and so did every job after it in the cache."
---

An executor dies. The scheduler walks its active jobs, rolls back the stages that touched the dead machine, and life goes on. That's the recovery loop Ballista runs on every executor loss, and on the surface it looks straightforward.

The line that caught my attention was one character long:

```rust
let reset = graph.reset_stages_on_lost_executor(executor_id)?;
```

That `?` is the whole bug. When a rollback fails, the error propagates out of `executor_lost` entirely. The job that was being rolled back is left half-reset, with tasks still `Running` against a machine that no longer exists. Every job after it in the cache iteration never gets its tasks reset at all. And `on_executor_lost`, the caller, just logs the error. From the outside, the cluster looks healthy while the jobs stop making progress.

I found this while reading the executor-loss path for a related report: TPC-H queries hanging indefinitely after Kubernetes OOM-killed some executors. The schedulers' logs for those runs were never captured, so the original cause stayed unconfirmed. But reading the code with that hang shape in mind made this path visible.

## Rollback is a rewrite, and rewrites can fail

A stage rollback in Ballista isn't bookkeeping. When an executor is lost, the scheduler has to mark its completed shuffle outputs as failed, then roll any running stages back to an unresolved state so they can be re-planned against the remaining executors. That second step can reject the rewrite. The graph tests already treat that as a real case — there's an existing test that builds a plan whose nodes refuse child rewrites and asserts the error propagates.

So the scheduler's recovery path has a failure mode it wasn't handling. Not a hypothetical one: a plan shape the codebase already acknowledges, hit at exactly the wrong moment.

The consequences stack in a specific order. First, the failing job ends up in a state the rest of the system doesn't know how to drive forward. `reset_stages_internal` has already marked some of its tasks failed, but no failure event is posted, so the job isn't recorded as failed either. Its remaining tasks sit in `Running` forever. Second, the `?` short-circuits the loop. Every other active job sharing that dead executor never gets its own rollback attempt, even though those rollbacks would have succeeded. One bad plan rewrite holds the whole cache hostage.

## Fail the one job, recover the rest

The fix is to treat a failed rollback the way `executor_lost` already treats the other "this job can't survive the loss" cases. A pipelined job can't survive losing an executor because its tasks stream to each other — there's nothing to roll back to. A job whose `DataFrame::cache()` data lived on the lost executor can't survive because its graph can't re-run another job's output. Both of those already funnel through a shared "fail this job with a clear reason" path in the same function.

A rollback failure is the same kind of outcome. The graph is half-reset; it can never make progress again. The only thing left to do is name the failure and keep going.

```rust
match graph.reset_stages_on_lost_executor(executor_id) {
    Ok(reset) => {
        if !reset.0.is_empty() {
            outcome.tasks_to_cancel.extend(reset.1);
        }
        continue;
    }
    Err(e) => Some(format!(
        "Job {job_id} failed to roll back after the loss of \
         executor {executor_id}: {e}"
    )),
}
```

The `match` is doing two things at once. The `Ok` arm is the original behavior, unchanged. The `Err` arm produces the same "cannot survive" reason the pipelined and lost-cache branches produce, which flows into the existing job-failure path. That path posts the failure event, releases the job's resources, and lets the loop move on to the next job in the cache.

The shape of the change matters more than the size. I'm not adding a new recovery mechanism or changing the semantics of rollback. I'm routing a third failure mode into machinery that was already there for two others. That makes it easy to review: if the existing "cannot survive" path is correct, this one is too.

## Test the loop, not just the single job

The single-job regression test builds a two-stage aggregation graph, completes the first stage on a mock executor, pops a task from the second stage so it's running there, then rewrites the second stage's plan into something that refuses rewrites. Losing the executor now triggers the rollback failure. The assertion is that the job appears in the outcome's `failed_jobs` list with "failed to roll back" in the reason — not that it's left running.

That test alone would have caught the original bug. But the more interesting regression is the second one, because it covers the part of the bug that made it dangerous. The cache loop doesn't stop at the first job; the bug was that it *did* stop, silently. So the test puts two jobs on the same dead executor: one whose rollback will fail, one whose won't. It asserts the doomed job is failed and the survivor is not, and that the survivor's running stage actually rolled back to unresolved.

Building that graph state needed a small test-only accessor on `StaticExecutionGraph`. The production code never constructs a stage whose rewrite is doomed from the start — that's the point — so the tests needed a way to reach in and break a plan on purpose. `stages_mut` is `#[cfg(test)]`, returns the underlying map, and exists precisely so the regression can build a state the scheduling paths can't reach on their own.

## What this looks like in production

The hang shape in the original report was a job that stopped progressing after its executors OOM-killed and restarted. The runner kept polling; nothing happened; eventually someone cancelled the sweep. Whether the rollback-failure path is exactly what fired there, I can't say — the scheduler logs weren't captured. But the failure mode this patch removes is the same shape: silent, indefinite, and invisible to anything watching job state from the outside.

If you run Ballista against spot instances, autoscaled node pools, or anything with a non-trivial executor-churn rate, this is the path that decides whether a lost machine is a blip or a stuck query. The default response to "this job can't be recovered" should be a failure event, not a hang.

My [Ballista PR #2860](https://github.com/apache/datafusion-ballista/pull/2860) merged on November 15, 2026. [Rollback fix and regression tests](https://github.com/apache/datafusion-ballista/pull/2860/files).
