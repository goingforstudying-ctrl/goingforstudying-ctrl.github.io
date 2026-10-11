---
layout: post
title: "The flow run that waited for a task that never started"
---

A while back I was watching a pipeline stuck on an ECS work pool. The flow run sat in PENDING. No logs, no container, no exit code — nothing to debug, because nothing ever ran. It stayed that way for hours.

Here's what actually happened on AWS's side. The work pool was backed by a capacity provider that couldn't get an instance — in our case a GPU shortage, but an ASG at its instance ceiling produces the same thing. ECS's RunTask accepts the task anyway, because a capacity provider queues rather than rejects. The task sits in PROVISIONING for about thirty minutes while ECS retries placement, and then ECS gives up and stops it.

The event that comes out the other end looks like this:

```json
{
  "detail": {
    "lastStatus": "STOPPED",
    "stopCode": "TaskFailedToStart",
    "stoppedReason": "TaskFailedToStart: RESOURCE:GPU",
    "containers": []
  }
}
```

Look at the containers array. It's empty — no container ever started, so there are no containers to report.

Prefect's ECS observer consumes these task state change events and is supposed to reconcile them into flow run states. The handler for STOPPED events, `mark_runs_as_crashed`, decided like this (simplified):

```python
if any(containers_with_non_zero_exit_codes):
    # propose Crashed
```

`containers_with_non_zero_exit_codes` is built from the containers array. Empty array in, empty list out, and `any([])` is `False`. So the crash proposal was skipped. The handler did emit a diagnostic log through `diagnose_ecs_task` — infra-level detail about why the placement failed — but diagnostics don't move state machines. And nothing else in the system would ever transition that run. PENDING, forever.

That's the whole bug: one vacuously-false `any()` over an empty list, caused by an event shape nobody had considered — a STOPPED task that was never a running task at all.

The fix in [prefect#22417](https://github.com/PrefectHQ/prefect/pull/22417) (which closes #22410) adds the missing branch:

```python
task_failed_to_start = (
    not containers
    and event.get("detail", {}).get("stopCode") == "TaskFailedToStart"
)
should_crash = (
    bool(any(containers_with_non_zero_exit_codes)) or task_failed_to_start
)
```

And when it's the failed-to-start case, the Crashed message carries the `stoppedReason` straight from the event:

```python
crash_message = (
    f"ECS task failed to start: {stop_reason}. "
    f"The capacity provider could not place the task."
)
```

That last part matters more than it looks. When a run dies this way, the first question from whoever's on call is "why", and the answer — `RESOURCE:GPU` — was sitting right there in the event. A crash state that just says "crashed" would send people digging through EventBridge. Now the reason shows up on the run itself.

Why crash it at all, though? You could argue for leaving the run alone and letting some retry mechanism reschedule it. I considered that, but the observer's job is to report what happened to the infrastructure, not to make policy. The task is STOPPED; it's not coming back. Crashed is the truthful state, and Crashed is what the rest of Prefect — automations, retry policies, alerting — already knows how to react to. A run hanging in PENDING is the one state nothing reacts to, because PENDING means "about to run".

The edge cases are where most of the care went. Empty containers with a *different* stop code — say `ServiceSchedulingStrategy` — should not crash the run, and doesn't: the condition requires the exact `TaskFailedToStart` code. A run already in a final state (Completed, Failed) shouldn't be touched, and isn't — the handler checks before proposing. And if the flow run ID from the event tags doesn't resolve in the API, the handler just walks away. All three are pinned by tests in the PR, plus one that asserts the crash message includes the stopped reason.

Who hits this? Anyone running Prefect on ECS with capacity providers under real scarcity. GPU-backed pools are the obvious case — if you've ever queued behind GPU availability on AWS, you've produced exactly this event shape. But a CPU pool with an ASG at its max size does it too, and spot capacity drying up looks identical. The nasty part is that the blast radius is silent: every unplaceable task spawns one more zombie run, and you only find out when someone asks why the dashboard shows a pile of runs "about to start" since Tuesday. Each one burned the full ~30 minute PROVISIONING timeout first, so by the time you notice, the backlog is real.

The takeaway I keep coming back to: `any()` and `all()` over empty collections are tiny state machines with default answers, and the defaults are easy to inherit by accident. `any([])` being `False` is mathematically tidy and operationally wrong here. If your reconciliation logic branches on aggregate properties of a list, it's worth asking what the empty list *means* in your domain — because "no containers exited non-zero" and "no containers ever existed" are very different events wearing the same shape.
