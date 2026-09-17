---
layout: post
title: "The Jinja filter that silenced dataset emission"
---

`threads: "{{ env_var('DBT_THREADS', 4) | as_number }}"` in a profiles.yml is a documented dbt pattern — env-driven connection config with dbt's built-in `as_number` filter. Completely normal. Except that in astronomer-cosmos, the library that turns dbt projects into Airflow DAGs, a profile containing it would silently disable dataset emission for the entire run.

The scenario came from issue #2948, and the reporter had already done the hard part: pinning down exactly which Jinja renderer was involved and why it blew up. I reproduced it and confirmed the mechanism.

In WATCHER mode, cosmos derives a dataset namespace from profiles.yml so it can emit dataset events with stable names; downstream DAGs scheduled on those assets fire when upstream models rebuild. Since #2879, every string field in the profile got rendered through a bare `jinja2.Template`:

```python
template = Template(template_str)
rendered = template.render(env_var=env_var)
```

A bare `Template` knows nothing about dbt's filters. `| as_number` is just an undefined filter, so the render raises `TemplateAssertionError`. The catch-all in `get_dataset_namespace` swallowed it at DEBUG level and returned `None` — and `None` means no dataset emission for anything in the run. Not for that field, for everything. And the field that blew up, `threads`, is one the namespace resolvers never even read. A tuning knob with a filter on it was killing every asset event.

The fix has three parts. First, render through an environment that registers dbt's filters as identity no-ops:

```python
_JINJA_ENV = Environment()
_JINJA_ENV.filters.update(
    {name: lambda x: x for name in ("as_number", "as_bool", "as_text", "as_native")}
)
```

That's not invented semantics — it's what dbt's own text-mode Jinja environment does with these filters (`TEXT_FILTERS` in `dbt_common.clients.jinja`). In text mode `as_number` is identity; the actual number conversion happens later, where dbt needs it. For namespace derivation, the rendered string is all we need.

Second, render fields independently and keep the raw value when one can't render:

```python
def _render_profile_field(field: str, value: str) -> str:
    try:
        return _resolve_env_var(value)
    except TemplateError:
        logger.debug("Could not render Jinja in profiles.yml field '%s'; using the raw value", field, exc_info=True)
        return value
```

One bad field no longer aborts derivation for the whole profile. That scoping matters: the all-or-nothing behavior made a cosmetic field's failure far more expensive than the data actually being derived, since the resolvers only read host, port, user, dbname, and schema.

Third, the catch-all now logs at WARNING instead of DEBUG, because returning `None` there means zero dataset events for the run and nobody would ever see it otherwise.

One behavior change worth flagging: a field that genuinely can't render — say `host: "db-{{ this.is_not_env_var }}.prod.internal"` — now degrades to its raw value in the namespace instead of disabling emission for the whole run. That restores the pre-1.15.1 behavior for that one field, and I updated the existing test to match. The alternative was silently dropping all asset events, which felt strictly worse.

I verified it with the exact profiles.yml from the issue: before, the namespace came back `None`; after, `postgres://localhost:5432` as expected. The dataset tests (twenty-one in `TestGetDatasetNamespace` now) cover the filter cases, and the `_resolve_env_var` tests pass with black and ruff clean.

Impact: anyone on cosmos WATCHER mode whose profiles.yml uses documented dbt filters — env-driven thread counts being the common one. The failure mode is the nasty kind: models keep building, DAGs keep running, and only the event-driven downstream silently starves, with nothing in the logs above DEBUG explaining why. It also hides from CI — the DAG still parses and the run still succeeds; only the events are missing. The fix was small; the blast radius was the whole run.

The full change: https://github.com/astronomer/astronomer-cosmos/pull/2950
