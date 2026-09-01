---
layout: post
title: "Stop hashing your dbt target folder"
---

A few weeks ago I was digging through DAG parse times on a project whose dbt files live on network-backed storage, and I kept coming back to the same hot spot: on every single parse, Cosmos was hashing the entire dbt project folder to compute its version. Not just the model SQL — the whole tree, including the folders dbt itself generates. I wrote up the fix in [astronomer-cosmos PR #2942](https://github.com/astronomer/astronomer-cosmos/pull/2942), and this post is the story behind it.

The trigger was [issue #2857](https://github.com/astronomer/astronomer-cosmos/issues/2857), where someone on Airflow 3.0 with KubernetesExecutor reported that every worker pod re-parsed the full dbt manifest for all 36 of their Cosmos DbtTaskGroups before running anything — even for a task that takes three seconds. Their project had 3,238 dbt nodes and 822 models, and every task ran in a fresh pod with a freshly synced copy of the project.

The mechanism isn't obvious from the symptoms. With `enable_dag_versioning` on — and it's on by default in Airflow 3 — Cosmos walks the whole project directory and hashes it on every DAG parse, so that when the SQL changes the DAG version can change with it. The hash has to be content-based rather than mtime-based: in dag-only deployments the files get re-synced constantly, so modification times are meaningless. That's a defensible design. The problem was the implementation.

Here's what the hash function did before my change, in essence:

```python
for filepath in sorted(filepaths):
    try:
        with open(str(filepath), "rb") as fp:
            buf = fp.read()
            hasher.update(buf)
```

That's the whole thing: an unpruned `os.walk` over everything, then each file read into memory in one shot. And "everything" on a real project includes `target/` (compiled SQL, the manifest, thousands of generated files), `dbt_packages/` (vendored packages you didn't write), `logs/`, and `.git/`. None of those influence what dbt will actually do — but every one of them gets read, in full, on every parse. On local disk that's merely wasteful; on a shared PVC or Azure File Share, where each per-file read is a round trip, it turns every parse into a small IO storm. In my synthetic benchmark — 822 models with about 3,500 generated files under `target/`, `dbt_packages/`, and `logs/` — one hash call went from 1179ms to 204ms on local disk. The gap on network storage should be a lot wider, since that's where per-file reads dominate.

The fix has three parts. The core is pruning the generated directories out of the walk entirely:

```python
for root_dir, dirs, files in os.walk(dir_path):
    if excluded_dirs:
        before = len(dirs)
        dirs[:] = [dirname for dirname in dirs if dirname not in excluded_dirs]
        pruned_dirs += before - len(dirs)
```

Mutating `dirs` in place is the standard os.walk idiom for pruning subtrees, and it means we never even stat the files inside them. The default excluded list is `.git, target, dbt_packages, logs`, and it's configurable through a new `[cosmos] project_hash_excluded_dirs` setting, because projects can rename their target or packages paths in `dbt_project.yml` and a hardcoded list would silently stop pruning for them. Setting the option replaces the default list entirely rather than extending it — a little sharp-edged, but it means the behavior is always exactly what you configured.

Second, files are now read in 1MB chunks instead of one shot. That one is defense in depth: if something big survives the pruning — a misplaced `manifest.json`, say — the hash function won't load it into memory whole just to checksum it.

Third, and this one's a real bug rather than a performance tweak: the hash covered file contents only. Rename a model file without touching its SQL, and you'd get the same hash. But dbt derives node names from file names, so a content-preserving rename genuinely changes the project — and a stale hash meant the partial-parse cache could keep serving results as if nothing had happened. I mixed each file's relative path into the hash:

```python
for filepath in sorted(filepaths):
    hasher.update(os.path.relpath(filepath, dir_path).encode())
```

The trade-off I flagged in the PR: hash values change with this, so on upgrade every project looks "modified" once and its caches refresh once. I thought that was acceptable, and it's worth knowing about if you deploy this on a tight schedule.

The part I'm happiest with isn't in the hash function at all. The issue also mentioned that an environment variable silently overriding the cache dir config made debugging miserable, so I added a parse-time log line that shows the resolved cache dir. Small, but it converts a week of confusion into one grep.

If you run Cosmos on Airflow 3, on network storage, with a nontrivial dbt project, you're almost certainly paying this tax on every parse — it's invisible unless you profile, because it never fails, it just hums along reading files nobody asked it to read. The fix is merged, and the configuration knob means you can tune the pruning to your project rather than the other way around.
