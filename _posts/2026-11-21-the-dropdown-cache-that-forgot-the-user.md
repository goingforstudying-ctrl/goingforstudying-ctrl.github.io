---
layout: post
title: "The dropdown cache that forgot who was asking"
permalink: /notes/superset-per-user-column-values/
categories: [caching, superset]
excerpt: "Superset's filter dropdowns were serving one user's values to every other user with the same row-level security. The chart cache had solved this years ago; the column-values cache just never got the memo."
---

A filter dropdown is the least suspicious place to leak data. It is just a list of distinct values for a column — countries, departments, product names. But in Apache Superset, that dropdown is backed by a cache, and I found that the cache key did not include anything about who was asking.

The scenario needs a specific but common setup: a shared cache backend like Redis, and a database connection with user impersonation, where the upstream engine (Trino, Hive, Postgres with per-user connections, take your pick) filters rows differently depending on which Superset user is connected. User A opens a native filter on a dashboard and sees the values A is allowed to see. User B opens the same filter on the same column. B gets A's values, served straight from the cache, because both users produce the exact same key. Whoever warms the entry first decides what everyone else sees.

That is a correctness bug dressed as a privacy one. Even if both users share row-level security rules, impersonation means the rows underneath differ per user, so the distinct values can too.

## The chart cache already knew the answer

The annoying part is that Superset had solved this problem once already. Chart data — the actual query results behind visualizations — routes its cache key through a helper called `add_impersonation_cache_key_if_needed`, which mixes a per-user component into the key material whenever per-user caching applies:

```python
if (
    (feature_flag_manager.is_feature_enabled("CACHE_IMPERSONATION")
     and database.impersonate_user)
    or feature_flag_manager.is_feature_enabled("CACHE_QUERY_BY_USER")
    or extra.get("per_user_caching", False)
):
    if key := database.db_engine_spec.get_impersonation_key(...):
        cache_dict["impersonation_key"] = key
```

Three independent switches can turn this on: the `CACHE_IMPERSONATION` flag paired with per-database impersonation, the global `CACHE_QUERY_BY_USER` flag, or a `per_user_caching` entry in the database's connection extras. Any of them means the engine may answer differently per user, so the cache has to partition per user.

The column-values path — the one feeding the native-filter dropdowns and the Explore filter popover — built its key from the query, the datasource UID, the RLS cache key, and `changed_on`, and simply never called the helper. The docstring even documented the gap: entries were partitioned by effective RLS, "not by user." That was fine in a world where RLS is the only thing distinguishing what two users see. Impersonation breaks that assumption, because RLS never enters into it.

## The fix is mostly a phone call to an existing helper

The patch in `superset/datasource/api.py` is small. For the two datasource types that have a database — `SqlaTable` and SQL Lab `Query` objects — the key builder now calls the same helper the chart path uses:

```python
elif isinstance(datasource, (SqlaTable, Query)) and datasource.database:
    # An engine that filters rows per user returns different values per
    # user, so the entry must be partitioned per user when per-user
    # caching is enabled (#45898).
    add_impersonation_cache_key_if_needed(datasource.database, material)
```

Semantic views needed a different branch. They have no `database` object at all, so the helper has nothing to work with. There, the fix partitions by the server-authenticated principal instead, but only when `CACHE_QUERY_BY_USER` is on, and deliberately skips guests:

```python
if feature_flag_manager.is_feature_enabled("CACHE_QUERY_BY_USER"):
    context = current_host_execution_context()
    if not context.is_guest:
        material["semantic_user"] = context.principal_id
```

Guests share one entry on purpose. A guest principal cannot distinguish one guest token from another, and the connection mode guests run under uses a single upstream account anyway — keying them would multiply cache entries without separating anything real. I flagged this in the PR description as the part I was least certain about; it mirrors the reasoning on the chart-cache side, and the maintainers were fine with it.

One drive-by fix fell out of the tests. `get_impersonation_key` used to read `user.username` directly. That works until `g.user` is Flask-Login's `AnonymousUserMixin`, which has no `username` attribute — so an anonymous request hitting the values endpoint with per-user caching on would have raised `AttributeError` instead of sharing the connection account's entry. It now reads `getattr(user, "username", None)`, and anonymous users fall back to the shared entry, which is the correct behavior for an identity the engine cannot tell apart anyway.

## Key bytes stay put when the feature is off

The constraint I cared about most was: change nothing for existing deployments. If per-user caching is off everywhere, the key material must be byte-identical to what it was before. Superset already had a legacy-bytes test pinning the exact key format, and I added a case proving that two users with the same RLS still share one key under default flags.

This matters for two reasons. A silent key-format change would cold-miss every warm entry in a shared cache on deploy day, which on a busy instance is a real latency event. And a key that always partitioned per user would quietly multiply cache cardinality for operators who never asked for it — same Redis memory, spread across N times as many entries, holding identical values.

The rest of the test suite covers the actual behavior end to end: with `CACHE_QUERY_BY_USER` on and the engine patched to answer per user, Alice warms her entry, gets a cache hit on the second call, and Bob still gets a miss and his own values. The `per_user_caching` database extra partitions without any feature flag. Semantic views split by principal, share for guests, and share when the flag is off. 178 tests across the three touched files pass.

## Who actually hits this

You need three things to line up: a shared cache backend, an impersonated or otherwise per-user connection, and two users with the same effective RLS but different visible rows. That sounds narrow until you remember that "same RLS, different rows" is precisely what user impersonation is for — large multi-tenant Superset deployments fronting Trino or Hive with impersonation enabled are the canonical case. The same key also backs the MCP dashboard-filter validation path, so the leak was not limited to humans clicking dropdowns.

If your deployment has none of those switches on, this changed nothing for you, by design. If it does, your filter dropdowns are now keyed the way your charts already were.

My [Superset PR #45972](https://github.com/apache/superset/pull/45972) merged on November 20, 2026. [Implementation and tests](https://github.com/apache/superset/pull/45972/files).
