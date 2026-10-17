---
layout: post
title: "The teardown that detached everyone"
permalink: /notes/the-teardown-that-detached-everyone/
categories: [concurrency, sqlalchemy]
excerpt: "Concurrent MCP tool calls against Superset were failing with DetachedInstanceError on rows they had already committed. Ten callers, ten app contexts, one SQLAlchemy session."
---

The response said failure; the database said success. Fire a batch of concurrent tool calls at Superset's MCP service and some of them come back with `DetachedInstanceError` — including calls whose work already committed. The chart exists. The API says it doesn't. For a human that's confusing; for an agent client it's worse, because the usual reaction to an error is a retry, and a retry creates a duplicate.

I measured this on stock Superset 6.1.0 with concurrent `generate_chart` calls: at concurrency 10, eight of ten calls errored. At concurrency 40, thirty-five of forty. Every single row was written. The database work succeeds and the responses report failure — the failure rate climbs with concurrency while the success rate of the underlying work stays at 100%.

## Three steps to a shared session

The chain has three links, and each one looks correct in isolation.

First, every MCP tool call pushes its own Flask app context. That's deliberate — the docstring in `mcp_auth_hook` says concurrent calls must not share one `g` namespace, and it works: I instrumented the hook and counted 20 distinct app contexts for 20 concurrent calls.

Second, `db.session` is not scoped to the app context. Superset pins flask-sqlalchemy 2.5.1, whose scoped session defaults to `scopefunc=greenlet.getcurrent`. Async tool calls are asyncio tasks, not greenlets — they all run on the event loop's single greenlet. Ten concurrent calls, ten app contexts, and the probe showed the same session id on every line:

```
[PROBE-ENTER] tool=generate_chart session=133425676349584 appctx=133425179069648
[PROBE-ENTER] tool=generate_chart session=133425676349584 appctx=133425183374416
```

Third, flask-sqlalchemy registers a teardown handler that calls `session.remove()` unconditionally when an app context pops. So the first call to finish removes the session that every other in-flight call is still using. Their ORM instances detach, and the next attribute read — a lazy load of `User.roles` during a permission check, a chart property after commit — raises `DetachedInstanceError`.

Once the first teardown wipes the registry entry, the next database access quietly creates a fresh session, which the next teardown wipes in turn. The probe log showed different session ids appearing in the `remove()` calls as the cascade played out.

## Keying the registry on the call, not the greenlet

The fix in [superset PR #42629](https://github.com/apache/superset/pull/42629) gives the session registry a finer key: a per-call token instead of the greenlet.

```python
_mcp_session_token: ContextVar[Any] = ContextVar(
    "superset_mcp_session_token", default=None
)

def mcp_session_scopefunc() -> Any:
    if (token := _mcp_session_token.get()) is not None:
        return ("mcp_tool_call", id(token))
    return _ident_func()
```

`_get_app_context_manager()` sets a fresh token for the duration of each tool call, and installing the scopefunc points `db.session`'s registry at it. Every call gets its own `Session`, and the app-context teardown removes exactly that call's session. Because a `ContextVar` propagates through `await` boundaries within one task, the token follows the call wherever it suspends and resumes. Outside MCP tool calls the token is unset and the scopefunc falls back to the greenlet ident, so the web, CLI, and Celery paths behave exactly as they did before.

The ordering subtlety that took the most care: the token reset has to happen after the app context pops, not before. Teardown's `db.session.remove()` resolves through the registry, so the token still has to be in place while the context unwinds — reset it early and teardown goes looking under the wrong key. The request-backed path has its own version of this: when middleware already populated `g.user`, the tool call reuses the request context but still gets tagged with a token, and on exit it deregisters only the per-call session, leaving the request's own greenlet-scoped session for the normal request lifecycle to tear down.

Installation is idempotent and wired from every serving entry point — `init_fastmcp_server()`, `run_server()`, and a best-effort lazy install inside `create_mcp_app()` for deployments that serve straight from the factory. The lazy imports exist because `create_mcp_app()` also runs at module import time, where `superset.extensions` can still be mid-initialization; in that case the server entry points install the scopefunc deterministically later.

## Proving the race in both directions

The centerpiece test is an interleaved two-task race choreographed with `asyncio.Event`s: call A enters its context, resolves a session, and waits; call B enters, resolves its own session, and exits — teardown removes B's session right there. A then re-resolves and executes a query. Without the fix, A's session was yanked by B's teardown and the test fails; with it, A's session survives untouched.

The test I'm proudest of is the counterfactual: it temporarily restores the old greenlet scope and pins down what used to happen — both calls really do resolve to the same `Session`, and the first teardown really does break the survivor. Counterfactual tests are underrated. They prove the race was real and not a story the fix tells about itself.

Is the ContextVar-token approach the right long-term shape? I'm not 100% sure — upgrading flask-sqlalchemy would change the default scoping for everything at once, but that moves every surface in the project to fix one service. The scopefunc swap is contained to the MCP service and leaves the rest of Superset on the exact behavior it already had.

Who hits this: anyone serving Superset's MCP endpoint to clients that parallelize — agents especially. At modest concurrency, most responses falsely reported failure while the writes landed anyway, and retries turned one chart into three. The PR merged on August 13, 2026.
