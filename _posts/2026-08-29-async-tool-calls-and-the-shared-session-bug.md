---
layout: post
title: "Two async tool calls, one database session"
---

One of the reports in Superset's MCP concurrency backlog was maddening on its face: fire two async tool calls at the server at the same time and one of them comes back with `DetachedInstanceError`, even though every tool call pushes its own app context. The code looked correct. The context management looked correct. The error said otherwise.

The culprit was in a place nobody was looking: the session registry. Superset runs flask-sqlalchemy 2.5.1, and its scoped session keys its registry by greenlet ident. That assumption — one greenlet, one request, one session — held up fine in Flask's sync world. But the MCP server runs tool calls as asyncio tasks, and asyncio tasks on a single event loop all live on the same greenlet. So N concurrent tool calls don't get N sessions. They all resolve to the same `Session`.

The failure plays out like this. Two calls run, each pushing its own app context, both holding ORM instances from the one shared session. The first call to finish pops its app context, the teardown handler calls `db.session.remove()`, and the session dies. Every other in-flight call is now holding detached instances, and the next attribute read blows up.

This isn't just an ugly traceback either. It explains a second report, where `generate_chart` claimed failure for a chart it had actually committed, and it's the reason retrying agents end up creating duplicates: the call looks like it failed, the agent retries, and the chart gets created twice.

The fix is a new `session_scope` module that changes the registry key. Instead of the greenlet ident, each tool call sets a fresh ContextVar token, and the scopefunc resolves the session from that token:

```python
_mcp_session_token: ContextVar[Any] = ContextVar(
    "superset_mcp_session_token", default=None
)

def mcp_session_scopefunc() -> Any:
    if (token := _mcp_session_token.get()) is not None:
        return ("mcp_tool_call", id(token))
    return _ident_func()
```

`install_mcp_session_scoping()` swaps that scopefunc onto `db.session`'s registry. Each call's context manager sets a token on entry, and the token is reset only after the app context has been popped — so the teardown's `db.session.remove()` still resolves to exactly that call's session. Outside MCP tool calls the token is unset and the scopefunc falls back to the greenlet ident, so web, CLI, and Celery paths behave exactly as before. There's also a request-backed path where middleware has already populated `g.user` on the request's context: there we reuse the request context but still tag the call with its own token, and the request's own session is left to the request lifecycle.

The subtle part is teardown ordering. Reset the token before popping the app context and the teardown handler's `remove()` resolves through the fallback path and kills the wrong session. Pop first, reset second.

For tests I wrote an interleaved two-task race: task A grabs a session and waits while task B fully tears down; then A must still resolve the same session and execute a query. That fails on the old behavior and passes with token scoping. There's also a counterfactual test that restores the greenlet scope and pins down the old failure mode for real — both calls resolve to the same `Session` and the first teardown removes it out from under the survivor. Plus nested-call and request-context tests. Five new tests in total, and the neighboring suites — roughly 1900 tests across the MCP service and chart tool tests — stayed green.

Am I certain the ContextVar-token approach is the long-term answer versus just upgrading flask-sqlalchemy? Not entirely. A newer flask-sqlalchemy might handle async scoping differently, but this change is contained to the MCP service and doesn't move anything else. The wiring goes through both the server entry point and the app factory, so every serving mode gets it.

If you run Superset's MCP server and anything agent-shaped calls your tools concurrently, this bug was live for you. The merged fix is in [apache/superset PR 42629](https://github.com/apache/superset/pull/42629), and the test file doubles as the best documentation of the failure mode.
