---
layout: post
title: "Two async tool calls, one database session"
---

Two concurrent MCP tool calls can interfere even when each pushes its own Flask app context. [Superset PR #42629](https://github.com/apache/superset/pull/42629) addressed that mismatch: one call could remove the database session that another call was still using, leaving ORM objects detached.

The shared state was in the session registry. The affected Superset checkout used flask-sqlalchemy 2.5.1, and its scoped session keys its registry by greenlet ident. That assumption — one greenlet, one request, one session — held up fine in Flask's sync world. But the MCP server runs tool calls as asyncio tasks, and asyncio tasks on a single event loop all live on the same greenlet. So N concurrent tool calls don't get N sessions. They all resolve to the same `Session`.

The failure plays out like this. Two calls run, each pushing its own app context, both holding ORM instances from the one shared session. The first call to finish pops its app context, the teardown handler calls `db.session.remove()`, and the session dies. Every other in-flight call is now holding detached instances, and accessing an expired or unloaded attribute that needs the session can fail. Attributes already loaded into the object need not fail simply because it is detached.

This isn't just an ugly traceback either. It explains a second report, where `generate_chart` claimed failure for a chart it had actually committed, and shows how a retry can create duplicates: the call looks like it failed, the agent retries, and the chart gets created twice.

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

The regression suite includes an interleaved two-task race: task A grabs a session and waits while task B fully tears down; then A must still resolve the same session and execute a query. That fails on the old behavior and passes with token scoping. There's also a counterfactual test that restores the greenlet scope and pins down the old failure mode for real — both calls resolve to the same `Session` and the first teardown removes it out from under the survivor. Plus nested-call and request-context tests. The final `test_session_scope.py` contains seven tests, covering concurrent isolation, teardown, nesting, and request-context handling. Session isolation does not enlarge the connection pool: enough concurrent calls can still exhaust its configured capacity.

The scope of this patch is deliberately narrow: isolate MCP sessions while retaining the existing fallback for other entry points. A dependency upgrade would need its own compatibility testing; this change does not establish how every Flask-SQLAlchemy version handles asynchronous contexts.

If you run Superset's MCP server and anything agent-shaped calls your tools concurrently, this is one failure mode to check on versions predating the change. The merged fix is in [apache/superset PR 42629](https://github.com/apache/superset/pull/42629), and the test file doubles as the best documentation of the failure mode.

Implementation reference: [merged commit](https://github.com/apache/superset/commit/d0658bacc89daf7edac0006132f3d128deeae66d) (2026-08-13).
