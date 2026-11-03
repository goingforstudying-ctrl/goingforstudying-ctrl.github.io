---
layout: post
title: "The cache key that forgot the credentials"
permalink: /notes/ballista-session-runtime-cache/
categories: [caching, distributed-systems]
excerpt: "A client refreshed its expiring S3 token mid-session, and the executors that had already cached the session never found out. The cache key was the session id, and nothing else."
---

The client did the right thing. Before its temporary S3 token expired, it issued another `SET s3.session_token ...` on the same session and kept querying. The scheduler picked up the new token immediately. So did some executors. The ones that had already run a task for that session never did — they kept building S3 stores from whatever credentials the session's first task had carried, and their next reads went out with the expired token.

I ran into this while reading a neighboring piece of Apache Ballista's S3 support. Ballista is a distributed SQL engine: a scheduler plans queries, executors run the tasks. For S3-backed tables the client attaches credentials to the session with `SET s3.*` statements, and those flow to executors as task properties. Two pieces of the executor interact badly here.

The first is the object-store registry. When the executor builds a runtime environment with S3 support, it clones the session's `S3Options` into a `CustomObjectStoreRegistry`. Every store the registry hands out is baked from that clone.

The second is a session cache. Building a runtime is expensive — object-store clients, a Parquet footer cache — so the executor keeps a per-session base runtime in an LRU and derives each task's runtime from it. The cache was keyed by session id alone:

```rust
if let Some(base) = cache.lock().get(session_id) {
    base.clone()
} else {
    let base = (self.base_producer)(config)?;
    cache.lock().put(session_id.to_string(), base.clone());
    base
}
```

The executor does build a fresh `SessionConfig` for every task, applying the task's properties on top. But on a cache hit that config only feeds the per-task layer; the base — the part holding the S3 options — is whatever the session's first task produced. Every `s3.*` key is affected: access key, secret, session token, region, endpoint.

The part I found genuinely nasty is the asymmetry. The scheduler creates a fresh context per submission, so planning always sees the new values. And the bug varies by executor: one that hasn't seen the session yet, or has evicted it from the sixteen-entry LRU, builds a fresh base and picks up the new credentials. The same session can plan against one set of credentials and execute with another, and the outcome depends on which executor a task lands on. Refreshing temporary credentials mid-session — the one case where calling `SET s3.session_token` again actually matters — is exactly the case that breaks.

## The fix is a better cache key

The cache key is now the session id paired with a fingerprint of the session config's extension entries:

```rust
let key = (session_id.to_string(), config_fingerprint(config));
```

The fingerprint function walks the config's extensions — the part of the config that `SET` can legitimately change mid-session — and hashes them:

```rust
for (prefix, extension) in config.options().extensions.iter() {
    if prefix == BallistaConfig::PREFIX {
        continue;
    }
    prefix.hash(&mut hasher);
    let mut entries = extension.entries();
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    for entry in entries {
        entry.key.hash(&mut hasher);
        entry.value.hash(&mut hasher);
    }
}
```

Extension iteration is ordered by prefix, and each extension's entries get sorted by key before hashing. That ordering guarantee is what makes the cache still a cache: two separately built configs with equal extension entries produce the same fingerprint and keep sharing one base. A `SET` that changes any extension entry misses and builds a fresh base. Reverting the `SET` produces the original fingerprint again, and since the original base is still sitting in the LRU, the session goes right back to it.

## What I left out, on purpose

Two things are deliberately not in the fingerprint.

The `ballista` extension is skipped. None of the shipped producers read it, and the client re-sends `ballista.job.name` with every job. Keying on it would give a session that sets a job name a fresh fingerprint per query — each one building a new base, dropping the footer cache and cross-query reuse, and taking another LRU slot. The fingerprint would defeat the cache.

Built-in `datafusion.*` options are skipped too. The base env's shared state — the registry, the disk manager, the footer cache — isn't derived from them, and I didn't want to hash a couple hundred options on every task. That's a documented caveat now: a custom `RuntimeProducer` that reads built-in options at build time keeps the values seen by the session's first task until the entry ages out. It matches every shipped producer today.

I also didn't take the issue's other suggested direction: stop capturing `S3Options` in the registry and resolve them per `get_store` call instead. That pushes a config lookup into the read hot path of every object-store access. Rekeying the cache is a much smaller change and leaves the read path alone.

One more detail I kept: on a miss, the base is built without holding the lock, so a slow build doesn't stall other sessions. Two tasks racing the same miss both build, the last writer wins, and the extra env is dropped. Idempotent and cheap.

## The trade-off I accepted

Entries from a session's earlier fingerprints are kept until the LRU evicts them. A session that rotates credentials several times leaves stale bases around — each holding an object-store client and a footer cache — and those can push other sessions' warm entries out. The bound is on total entries, so it isn't a leak, but the capacity flag now bounds (session, fingerprint) pairs rather than sessions, and its help text says so. Sixteen entries doesn't necessarily mean sixteen sessions anymore.

## Proving the key works

The issue came with a reproducer, and I turned it into the regression test: run a task in a session with `KEY_ONE`, change the access key, run another task in the same session, and assert the second task's store was built with `KEY_TWO`. Before the fix that assertion fails — the second store still contains `KEY_ONE`.

The rest of the suite pins down the sharing semantics. Equal options from two separately built configs share one base, checked with `Arc::ptr_eq`. Reverting the key hits the original base. Two different sessions with identical options get separate bases. Changing only `ballista.job.name` does not rekey, which guards the exclusion that keeps per-query job names from defeating the cache. And the fingerprint itself is deterministic: same entries, same hash; different entries, different hash.

The case that bites in production is short-lived credentials — STS tokens, anything that expires while a session is still alive. Before this fix, a refresh had no effect on executors that had already cached the session, and the resulting auth failures could look flaky because a retry landing on a different executor might pick up the new values. Now the cache notices.

My [Ballista PR #2562](https://github.com/apache/datafusion-ballista/pull/2562) merged on November 2, 2026. [Implementation and tests](https://github.com/apache/datafusion-ballista/pull/2562/files).
