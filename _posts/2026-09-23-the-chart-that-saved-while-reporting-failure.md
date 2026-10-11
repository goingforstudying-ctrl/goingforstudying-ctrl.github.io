---
layout: post
title: "The chart that saved successfully while reporting failure"
---

The worst outcome a tool call can return to an LLM client isn't an error. It's an error *after* the side effect already happened. Apache Superset's MCP service had exactly that bug: `generate_chart` with `save_chart=true` would create the chart, persist it, and then throw a validation error while assembling the response. The LLM client sees a failure, does what LLM clients do — retries — and now you've got duplicate charts piling up while every response insists nothing worked.

The root cause is a type mismatch that Python's ergonomics make very easy to write. The MCP service exposes tools like `get_dataset_info`, `get_chart_info`, and `generate_chart`, and their responses include a `UserInfo` Pydantic model describing the calling user. `UserInfo` is declared with `from_attributes=True`, so Pydantic maps attributes off the user object directly. One of the fields is `roles: list[str]`. But the user object comes from SQLAlchemy, and `user.roles` is an ORM relationship — it yields `Role` objects, not strings. So the moment any user with an assigned role calls one of these tools, serialization explodes:

```
2 validation errors for UserInfo
roles.0
  Input should be a valid string [type=string_type, input_value=Admin, input_type=Role]
```

Read that input value again: `Admin`. The data is right there, one attribute access away. Pydantic just won't reach into an arbitrary object and pull `.name` out on its own — nor should it.

Every MCP tool call from a user with roles hit this, which in practice means every call from any real account, since even the default setup assigns roles. The failure mode varies by tool but the nasty one is `generate_chart`: the save happens inside the tool, the validation error happens on the way out, and the client can't tell the difference between "chart failed to save" and "chart saved, response failed." Retries compound it.

The fix I put up in [superset PR 40746](https://github.com/apache/superset/pull/40746) is a `mode="before"` field validator that coerces whatever shows up in `roles` into plain strings before Pydantic's own validation runs:

```python
@field_validator("roles", mode="before")
@classmethod
def _extract_role_names(cls, v: Any) -> list[str] | None:
    if v is None:
        return None
    if isinstance(v, str):
        raise ValueError("roles must be a list, not a string")
    result: list[str] = []
    for item in v:
        if isinstance(item, str):
            result.append(escape_llm_context_delimiters(item))
            continue
        try:
            name = item.name
            if isinstance(name, str):
                result.append(escape_llm_context_delimiters(name))
        except (AttributeError, DetachedInstanceError):
            logger.debug("Skipping role with detached instance in UserInfo.roles coercion")
    return result
```

A few decisions in there are worth defending. The bare-string rejection preserves Pydantic's default behavior for `list[str]` — without it, `roles="Admin"` would silently become five roles named "A", "d", "m", "i", "n", which is the kind of bug that ships. Strings pass through untouched so existing callers that already hand in name lists see zero behavior change. And the escaping matters because this model's whole purpose is to be serialized into an LLM's context window — a role name containing context delimiters is untrusted input at that point, and it gets escaped like every other field in the schema.

The detached-instance handling is the part with a story. `serialize_user_object` already had a guard for this, and it was wrong in two ways at once:

```python
try:
    roles = [r.name for r in user_roles if hasattr(r, "name")]
except (AttributeError, DetachedInstanceError):
    roles = None
```

First, `hasattr` on Python 3 only swallows `AttributeError`. Accessing `.name` on a detached ORM instance raises `DetachedInstanceError` — and `hasattr(r, "name")` itself triggers the lazy load, so the guard clause raises the very exception it's guarding against, before the comprehension even starts. Second, even when the exception gets caught by the outer `try`, one detached role nukes the entire list: `roles = None`, and the response loses every role including the perfectly healthy ones. The rewrite moves the `try` inside the loop, checks `isinstance(r.name, str)`, and skips just the offending item with a debug log.

The tests pin down the properties that matter rather than re-running the ORM: a bare string is rejected, an empty list stays `[]` (so callers can distinguish "no roles" from "roles omitted"), `Role`-like mocks come out as their names, a name containing `<|endofmessage|>` survives but escaped, and a detached role alongside a good one yields `["Admin"]` instead of an exception or `None`. The round-trip tests go through `serialize_user_object` end to end since that's the path the tools actually exercise.

Who hits this: anyone driving Superset through an MCP client with a non-toy user account. The blast radius is bigger than the traceback suggests — false negatives train the calling agent to distrust the tool, retry storms multiply the side effects, and the one tool that *did* succeed is the one reporting failure loudest. If you're exposing tools to LLM clients, it's worth auditing every response model for ORM objects leaking across the boundary, because `from_attributes` will faithfully map whatever the relationship returns, and "an object with the right attribute name" is not a string.
