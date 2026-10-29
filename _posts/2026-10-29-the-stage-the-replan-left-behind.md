---
layout: post
title: "The stage the replan left behind"
permalink: /notes/the-stage-the-replan-left-behind/
categories: [rust, distributed-systems, scheduler]
excerpt: "Ballista's AQE replan could cancel a stage on paper while it kept running in the graph. The job never finished, and one wedged job took unrelated jobs' task updates down with it."
---

There's a special kind of dread in finding a log statement that confesses the bug. Ballista's adaptive query execution had this one sitting in the stage-progress path:

```rust
if !stages_to_cancel.is_empty() {
    warn!(
        "there are stages to be cancelled but its not implemented. stages to cancel: {:?}",
        stages_to_cancel
    );
}
```

"Not implemented" is doing a lot of work in that sentence. The issue on [ballista#2150](https://github.com/apache/datafusion-ballista/issues/2150) laid out what it costs: a replan finalizes one side of an inner join, discovers the other side is empty, and correctly concludes that a concurrently running sibling stage is now redundant. The planner drops that stage from its cache. The execution graph, meanwhile, keeps it in `Running` with tasks in flight. Two divergent opinions about whether the stage exists — and the graph's opinion is the one that decides when a job finishes.

## A job that can never succeed

The wedge closes when the orphaned stage's tasks do what tasks do: finish and report success. `update_stage_progress` calls into the planner's `finalise_stage`, which no longer finds the stage in its cache and returns `Can't find active cache resolve`. The error propagates out of `update_task_status` *before* the stage transitions, so the stage sits there `Running` forever — every task successful, zero available, permanently un-succeeded.

That one stage is enough to sink the job, because the completion check is universal: `is_successful()` requires every stage in the graph's map to be `Successful`. A cancelled stage left in the map in any other state makes the whole conjunction false forever. The job neither finishes nor fails. It just holds its scheduler slots.

The second consequence was worse, because it crossed job boundaries. `TaskManager::update_task_statuses` groups an incoming batch by job and then used `?` inside that loop. One bad job — say, our orphaned-stage job — aborts the entire batch. The scheduler logs `Failed to update N task statuses for Executor X` and discards the rest, including perfectly valid updates for other jobs that happened to share an executor with the cursed one. A single poisoned job could starve its neighbors of task progress indefinitely.

## Retirement, not cancellation

My fix in [ballista#2192](https://github.com/apache/datafusion-ballista/pull/2192) has three parts, and the first is a refusal to pretend in-flight tasks can be un-run. `retire_cancelled_stage` moves a cancelled stage out of the `stages` map entirely and records its id in a separate `retired_stages` set:

```rust
fn retire_cancelled_stage(&mut self, stage_id: usize) {
    match self.stages.remove(&stage_id) {
        Some(ExecutionStage::Running(running)) => {
            let inflight = running.running_tasks().len();
            self.retired_stages.insert(stage_id);
            // ... tasks may still finish; their statuses are ignored below
        }
        // Resolved/UnResolved retire the same way; Successful/Failed stay
        // in the map to preserve their outputs and history.
        ...
    }
}
```

Getting the stage out of the map is what unblocks `is_successful()` — the job no longer waits on work that can't contribute. Terminal stages stay put, because their outputs and failure history are part of the job's record. And when a late status arrives from a retired stage's task — which it will, because already-dispatched tasks keep running — the graph now recognizes the id in `retired_stages`, logs it, and discards the status instead of erroring. Stale work from a cancelled attempt is expected traffic, not an invariant violation.

Part two is small and mechanical: the per-job loop in `update_task_statuses` now matches on the result instead of propagating with `?`. A failure for one job gets logged and the batch continues with the next job. One wedged job can no longer eat its neighbors' updates.

## The refund that outlived its graph

Part three is where it got subtle, and it's the part I'm glad the regression test forced me to get right. Ballista's push scheduler reserves an executor's vcores when a task is bound, and refunds them when the task reports a terminal status. The old refund path recomputed the amount by reading the task's vcore count *out of the job's execution graph*. That works until the graph is gone — and stage retirement plus job eviction make "the graph is gone" a routine event. A completion arriving after eviction found nothing to read and refunded zero. Those vcores leaked out of the executor's budget forever, which is a slow-motion capacity bug: the scheduler thinks the executor is busier than it is, forever.

So the refund no longer consults the graph at all. There's now a reservation ledger, `outstanding_task_reservations`, keyed by `(executor_id, task key, stage attempt)` and written at bind time, before the launch task is spawned — early enough that an `ExecutorLost` event can discard every reservation from the batch. Terminal reports consume entries exactly once. Launch rejections consume from the same ledger, so a rejection racing a completion can't refund twice, and multi-vcore tasks refund at their full bound weight instead of one vcore per task. When an executor is lost its entries are simply dropped — its capacity is gone, so there's nothing left to refund to.

The stage-attempt component of the key matters more than it looks: a stage rollback can reuse task ids, and the executor id in the key stops a stale report from one executor releasing another's reservation. These are the kinds of collisions you only see after the naive version has already corrupted someone's budget.

The lifecycle regression test builds the join from the issue, drives the replan, retires the redundant stage, and then asserts the retired task's reservation still exists until its completion consumes it. Against the earlier implementation that assertion failed with `None` instead of `Some(1)` — exactly the leak, caught in miniature. A second test drives a batch spanning a healthy job and a broken one and checks the healthy job's updates survive. `cargo test -p ballista-scheduler --lib state::` passes 266 strong, clippy is clean.

## What's deliberately left open

The fix does not send executor-side cancellation RPCs to tasks whose stage was retired. They run to completion and their statuses are discarded. That's a trade, not an oversight: killing tasks mid-flight is a much bigger protocol change, and the scheduler-side accounting is now correct either way. Reservation metadata follows the active-job-graph lifetime, so refund handling after an entire graph is evicted keeps its prior behavior.

Who feels this in production? Any Ballista cluster running AQE with joins that can go empty on one side — which is to say, real workloads with filtered scans. Before the fix, those jobs could hang forever holding slots, and the batch-abort bug meant the damage wasn't even contained to the unlucky job. After it, a redundant stage is just an early finish. The merged PR is [apache/datafusion-ballista#2192](https://github.com/apache/datafusion-ballista/pull/2192). The warn log that confessed everything is gone, replaced by a debug line that finally has something true to say.
