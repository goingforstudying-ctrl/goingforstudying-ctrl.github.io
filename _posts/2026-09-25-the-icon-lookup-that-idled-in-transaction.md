---
layout: post
title: "The icon lookup that idled in transaction for minutes"
---

Postgres has a particular way of ruining your day quietly: a connection that checked out from the pool, ran one tiny SELECT, and then just sits there — `idle in transaction` — holding locks and a pool slot while the application does everything except talk to the database. I found one of these in Dify, the LLM app platform, where the offending query was a lookup of an emoji icon.

The setup that triggers it is nested workflows. Dify lets you publish a workflow as a Workflow Tool, then call that tool from a Tool node inside another workflow. When the Tool node starts, the runtime wants to show the tool's icon, so `ToolManager.generate_workflow_tool_icon_url()` runs a query against `tool_workflow_providers`. Then the nested workflow actually executes — and if that nested workflow contains an HTTP Request node hitting an unreachable URL with retries and a long read timeout, "executes" means minutes of waiting.

The bug report came with the receipts: `pg_stat_activity` showing connections `idle in transaction` for minutes at a time, last query against `tool_workflow_providers`, transaction age climbing until `idle_in_transaction_session_timeout` finally killed them. On a busy self-hosted instance that's pool exhaustion, blocked autovacuum on the tables those transactions touched, and the slow creep of "why is Postgres out of connections when nobody is querying it."

The root cause is a transaction-lifetime mismatch, and it's the kind that ORMs make easy to write. The icon lookup used the request-scoped Flask-SQLAlchemy session:

```python
workflow_provider = db.session.scalar(
    select(WorkflowToolProvider)
    .where(WorkflowToolProvider.tenant_id == tenant_id,
           WorkflowToolProvider.id == provider_id)
    .limit(1)
)
```

`db.session` is scoped to the request (or app context). SQLAlchemy begins a transaction on the first query and doesn't end it until the session is committed, rolled back, or closed — none of which happens until request teardown. So the transaction opened by this one-row read stays open for the entire nested workflow execution, because the session that opened it outlives the work it was opened for. The read itself takes a millisecond; the transaction lives for minutes.

The fix in [Dify PR 36903](https://github.com/langgenius/dify/pull/36903) is not to make the outer scope shorter — it's to stop borrowing the long-lived session for a short-lived read:

```python
with Session(db.engine, expire_on_commit=False) as session:
    workflow_provider = session.scalar(
        select(WorkflowToolProvider)
        .where(WorkflowToolProvider.tenant_id == tenant_id,
               WorkflowToolProvider.id == provider_id)
        .limit(1)
    )
    if workflow_provider is None:
        raise ToolProviderNotFoundError(f"workflow provider {provider_id} not found")
    icon = emoji_icon_adapter.validate_json(workflow_provider.icon)
    return icon
```

A dedicated `Session` bound straight to the engine, used as a context manager. The `with` block ends, the session closes, the connection goes back to the pool with no transaction dangling. The read's lifetime now matches the read's scope, which is the whole point.

Two details worth noting. First, `expire_on_commit=False` keeps the loaded attributes usable after the session closes instead of risking a lazy-load on a dead session — defensive, since everything is consumed inside the block anyway, but cheap insurance. Second, the fallback behavior is unchanged: any exception still returns the default dark emoji icon, so a transient DB hiccup degrades the icon, not the tool run. I applied the same change to `generate_api_tool_icon_url()`, which had the identical pattern.

The part that made this a one-line-concept fix rather than a design discussion: the MCP tool icon path in the same file already used the short-lived-session pattern. This wasn't inventing a new convention, it was extending an existing one to the two call sites that had missed it. That's usually the right shape for a fix like this — find the place in the codebase that already does it correctly, and align the others rather than introducing a third way.

The tests patch the `Session` constructor and `db`, then assert the important contract: the session is built from `db.engine` with `expire_on_commit=False`, both icon paths go through it, and the missing-provider case still falls back to the default icon. No real Postgres needed, because the behavior that matters is *which* session is used and that it's closed, not the query result.

Who hits this: anyone self-hosting Dify on Postgres who publishes workflows as tools and nests them, especially with flaky external HTTP calls inside the nested run. It's silent until the pool runs dry. The general lesson is one I keep re-learning: in SQLAlchemy, the session *is* the transaction boundary, so borrowing a request-scoped session for a read inside long-running work means the long-running work inherits your transaction. If the read is one millisecond, give it a session that lives one millisecond.
