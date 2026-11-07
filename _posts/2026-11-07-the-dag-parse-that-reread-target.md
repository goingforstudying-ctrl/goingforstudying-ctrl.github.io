---
layout: post
title: "The DAG parse that reread the target directory"
permalink: /notes/the-dag-parse-that-reread-target/
categories: [airflow, performance]
excerpt: "Airflow 3 turns DAG versioning on by default, and feeding it meant hashing the whole dbt project on every parse — target/, dbt_packages/, logs/, .git/ and all."
---

The task itself ran for three seconds. Getting to those three seconds took much longer, because the worker pod re-parsed the entire dbt manifest first — for all thirty-six Cosmos task groups in the DAG.

That was the deployment in astronomer-cosmos#2857: Airflow 3 on KubernetesExecutor, a fresh pod per task, a dbt project with 3,238 nodes and 822 models, and a Cosmos cache directory on a shared PVC. Suspicion in the thread fell on the project-folder hash, and the hash walk turned out to be the culprit.

Airflow 3 turns `enable_dag_versioning` on by default, and Cosmos feeds it by hashing the dbt project folder's contents. The hashing ran on every DAG parse. So every worker pod, before running any task, walked the project tree and read every file in it — including `target/`, `dbt_packages/`, `logs/`, and `.git/`. On network-backed storage that's thousands of generated files re-read per parse, none of which a human authored.

## An unpruned walk

The old `_create_folder_version_hash` was honest and thorough in exactly the wrong way:

```python
for root_dir, dirs, files in os.walk(dir_path):
    paths = [os.path.join(root_dir, filepath) for filepath in files]
    filepaths.extend(paths)

for filepath in sorted(filepaths):
    with open(str(filepath), "rb") as fp:
        hasher.update(fp.read())
```

Two problems. The walk never pruned anything — `os.walk` hands you `dirs` specifically so you can edit it in place, and nobody did. And each file was read whole into memory, which is fine until a fifty-megabyte `manifest.json` survives everything else.

The generated folders are the expensive part. `target/` holds compiled SQL and run artifacts, `dbt_packages/` holds vendored packages, `logs/` grows without bound, `.git/` is the entire repository history. None of them change what the user wrote, which is all the hash is trying to capture.

## Pruning by name

The fix prunes directory names out of the walk wherever they appear in the tree:

```python
for root_dir, dirs, files in os.walk(dir_path):
    if excluded_dirs:
        dirs[:] = [dirname for dirname in dirs if dirname not in excluded_dirs]
```

The default set is `.git`, `target`, `dbt_packages`, `logs`, and it's configurable through a new `[cosmos] project_hash_excluded_dirs` setting for projects that rename their target or packages paths in dbt_project.yml. Files that survive the pruning are now read in one-megabyte chunks, so a misplaced artifact doesn't get loaded into memory whole.

One trade-off worth being explicit about: pruning is by directory *name*, not path. If you authored a directory called `logs` full of hand-written SQL, the walk skips it too. That's what the config setting is for — but the default favors the common case, where `target/` and friends dwarf the authored tree and change on every run anyway. Hashing them doesn't just waste I/O; it makes the hash noisy, because generated files churn without any meaningful change to the project.

## The rename the hash couldn't see

While I was in there I checked what the hash actually commits to, and found a second bug: it covered only file *contents*. Rename `models/orders.sql` to `models/orders_v2.sql` without touching a byte of SQL and the hash comes out identical.

But dbt derives node names from file names. A content-preserving rename changes every reference to that model — the project has meaningfully changed, and the partial-parse cache keyed on this hash should invalidate. The fix mixes each file's relative path into the hash before its contents:

```python
hasher.update(os.path.relpath(filepath, dir_path).encode())
```

That change alters every existing hash value, so it's a one-time cache invalidation on upgrade. The existing tests pinned exact md5 values per platform; they now pin the new ones, with a note that recent macOS releases produce the Linux value.

## What I didn't do

I considered hashing only file metadata — size and mtime — instead of contents, which would skip most of the reads entirely. The codebase already has a comment explaining why that doesn't work here: DAG-only deployments sync files constantly, so mtimes churn without content changes and the hash would invalidate on every sync. Content hashing is the right call; it just needs to read less.

The issue also mentioned that an env var silently overriding the config-block cache dir was hard to see, so the converter now logs the resolved cache dir at parse time. Small thing, but silent overrides are how you end up hashing the wrong folder on a network mount and not knowing it.

If you run Cosmos on Airflow 3 with KubernetesExecutor and a large project — especially off a PVC, Azure File Share, or anything else where a file read isn't free — every DAG parse was paying for thousands of generated files it never used. My [astronomer-cosmos PR #2942](https://github.com/astronomer/astronomer-cosmos/pull/2942) merged on August 4, 2026. [Implementation and tests](https://github.com/astronomer/astronomer-cosmos/pull/2942/files).
