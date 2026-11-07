---
layout: post
title: "The threads field that muted every dataset"
permalink: /notes/the-threads-field-that-muted-every-dataset/
categories: [airflow, dbt]
excerpt: "A dbt filter on a field the resolver never read turned off every asset event in the run. The renderer didn't know the filter, and the failure was logged where nobody looks."
---

The DAG run was green. Every task succeeded, every model built, and not a single dataset event came out of it.

That was the report in astronomer-cosmos#2948: after upgrading Cosmos from 1.15.0 to 1.15.1, a WATCHER-mode `DbtDag` on Airflow 3 completed cleanly but emitted zero assets — for every model. Downstream DAGs scheduled on those assets simply never fired. Nothing in the task logs explained why, because the one log line that knew the answer was written at DEBUG.

The trigger turned out to be a line of YAML that dbt itself documents:

```yaml
threads: "{{ env_var('DBT_THREADS', 4) | as_number }}"
```

`as_number` and `as_bool` are dbt's own documented filters for profiles.yml. dbt parses this profile without complaint. Cosmos 1.15.1 did not.

## The renderer that only knew one function

Cosmos derives the dataset namespace from profiles.yml, which means it reads the file directly and renders the Jinja itself. The regression came from #2879, which switched that rendering to a bare `jinja2.Template` with exactly one function registered: `env_var`. The moment a field used `as_number`, `Template` raised `TemplateAssertionError: No filter named 'as_number'`.

Two design choices turned that small error into a silent outage. First, the whole target profile was rendered in one dict comprehension:

```python
target = {key: _resolve_env_var(value) if isinstance(value, str) else value
          for key, value in target.items()}
```

One unrenderable field aborted the entire profile — including `host`, `port`, and `type`, which had rendered fine. Second, `get_dataset_namespace` wrapped everything in a catch-all that logged at DEBUG and returned `None`, and `None` disables dataset emission for the run.

The detail that makes this sting: the namespace resolvers never read `threads`. A filter on a field they don't care about killed every asset event. This is the failure mode I keep an eye out for in glue code — an error in data you don't use, aborting a computation over data you do.

## Render each field on its own

The fix had three parts, and the first was to make the renderer speak dbt's dialect. dbt's own text-mode Jinja environment registers `as_number`, `as_bool`, `as_text`, and `as_native` as identity functions (`TEXT_FILTERS` in `dbt_common.clients.jinja`) — in text mode the value stays a string and the adapter converts it later. So I did the same thing, scoped to profiles.yml:

```python
_PROFILES_JINJA_ENV = Environment()
_PROFILES_JINJA_ENV.filters.update(
    {name: lambda x: x for name in ("as_number", "as_bool", "as_text", "as_native")}
)
```

Scoping matters. The plain renderer used for dbt_project.yml values deliberately still rejects these filters — there's a test asserting `TemplateAssertionError` — so the new leniency can't leak into a context where dbt itself would be stricter.

Second, rendering moved from one comprehension to per-field calls. Each field gets its own try/except: if a field's template can't render at all — an unknown filter, an undefined name — that field keeps its raw value and the rest of the profile renders normally. One bad field can no longer abort the profile.

## Fail loud at the boundary

Per-field fallback creates a new risk: a raw value containing literal `{{ ... }}` could now flow into the namespace string. So the final namespace became the single place that validates. If the resolved namespace still contains `{{` or `{%`, or the host component came out empty (`postgres://:5432` from a missing `host`), `get_dataset_namespace` logs a warning and returns `None`.

And the catch-all itself moved from DEBUG to WARNING:

```python
except (AttributeError, KeyError, TypeError, OSError, yaml.YAMLError, TemplateError) as error:
    logger.warning(
        "Unable to extract profile info for dataset namespace derivation (%s); "
        "dataset emission will be skipped.",
        error, exc_info=True,
    )
    return None
```

Returning `None` from this function means zero datasets for the entire run. That's a WARNING by any honest definition. The original bug survived precisely because the only witness was a DEBUG line in a deployment where nobody runs DEBUG.

## The edges I left in

There's one real behavior change: a field that genuinely can't render, like `host: "db-{{ this.is_not_env_var }}.prod.internal"`, now falls back to its raw value instead of disabling emission — and if that raw value reaches the namespace, the validation above rejects it. Emission is still skipped, but the log says which namespace and why.

I also added tests for the fields that must *not* matter: a `role_arn` with an empty default on a Glue profile where `account_id` is set, an empty `method` on Spark when `port` is explicit. Those fields are never read by their resolvers, so an empty render shouldn't cost you the namespace. Before this fix, the all-or-nothing comprehension made no such distinction.

The regression test for the reported case builds a profile with `as_number` on `threads` and `connect_timeout`, `as_bool` on `use_ssl`, and asserts the namespace still resolves to `postgres://dbhost:5433`. That's the whole bug in one assertion: fields the resolver doesn't read shouldn't decide whether you get datasets at all.

If you run WATCHER mode with asset-scheduled downstream DAGs — MWAA, Airflow 3, the setup from the issue — this was the difference between a working schedule and a silently empty one. My [astronomer-cosmos PR #2950](https://github.com/astronomer/astronomer-cosmos/pull/2950) merged on September 8, 2026. [Implementation and tests](https://github.com/astronomer/astronomer-cosmos/pull/2950/files).
