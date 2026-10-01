---
layout: post
title: "The LLM reply with nothing in it"
---

A few weeks ago I was staring at a crashed agent run in AutoGPT's platform logs. The traceback ended in the most unhelpful way Python knows how:

```
IndexError: list index out of range
```

No provider error, no HTTP failure, no timeout. The LLM call had *succeeded* — and then the code fell over trying to read the answer. The answer, it turned out, was empty. Not empty text. An empty `choices` list.

This is one of those bugs that lives entirely in the gap between what an API contract promises and what production actually sends you.

## The assumption everyone makes

The OpenAI chat completion shape is so familiar that nobody thinks about it anymore: `response.choices[0].message`. Every OpenAI-compatible provider — and there are dozens now, OpenRouter, Groq, v0, AI/ML, Llama API — copies that shape. So AutoGPT's `llm.py`, which normalizes all of those providers into one internal response type, had a little helper for pulling tool calls out:

```python
def extract_openai_tool_calls(response) -> list[ToolContentBlock] | None:
    if response.choices[0].message.tool_calls:
        return [...]
    return None
```

Looks fine. The function even has a sensible "nothing here" path: if the model didn't ask for any tool calls, return `None` and let the caller treat it as a plain text answer.

The problem is one line earlier. `response.choices[0]` assumes the list has at least one element. And here's the thing: providers do return responses with an empty `choices` list. Content filtering is the classic one — some providers answer a flagged prompt with a 200 and no choices at all. Rate limiting and transient backend weirdness behind aggregators like OpenRouter can do it too. The HTTP layer says success, the SDK parses the body fine, and then `choices[0]` detonates.

An `IndexError` in that spot doesn't just fail one LLM call. It escapes the block, kills the agent step, and — depending on where in the graph it happens — can take down a long-running agent execution that had been going for hours. One malformed response, total loss.

## The fix is boring, and that's the point

The guard is three lines, in [the PR](https://github.com/Significant-Gravitas/AutoGPT/pull/12540):

```python
def extract_openai_tool_calls(response) -> list[ToolContentBlock] | None:
    if not response.choices:
        logger.warning("LLM response has empty choices in extract_openai_tool_calls")
        return None
    if response.choices[0].message.tool_calls:
        ...
```

The same guard went into `extract_openai_reasoning()`, which had the identical pattern one function up. The reasoning is simple: this function's contract already includes "return `None` when there's nothing to extract." An empty choices list *is* nothing to extract. Callers already handle `None` — they've been handling it forever for the no-tool-calls case. Returning `None` keeps the crash local and lets the agent continue with a degraded answer instead of no answer.

But I didn't stop at the two extractors, because the extractors aren't the only places that touch `choices[0]`. Each provider branch in `llm_call` builds an `LLMResponse` directly from `response.choices[0].message`. Groq and v0 had no guard at all. OpenRouter and Llama API had guards, but weird ones:

```python
if not response.choices:
    if response:
        raise ValueError(f"OpenRouter error: {response}")
    else:
        raise ValueError("No response from OpenRouter.")
```

We're already inside `if not response.choices`, which means `response` exists — the `else` branch was dead code, and the error message blamed the provider vaguely without saying what was actually wrong. I collapsed those into one honest message:

```python
if not response.choices:
    raise ValueError(f"OpenRouter returned empty choices: {response}")
```

That split — `None` from the extractors, `ValueError` from the call sites — is deliberate. The extractors are pure "pull data out if it's there" helpers; absence is a normal outcome. The call sites, on the other hand, have to construct an `LLMResponse` around a message object. If there's no message, there is no valid response to return, and the only correct move is a descriptive error the retry logic upstream can log and act on. What changed isn't that errors can happen — it's that you now get "OpenRouter returned empty choices" instead of a bare `IndexError` pointing at a line that looks correct.

## Why not retry automatically?

I thought about it. An empty choices list is often transient, and retrying inside the extractor would save agent runs. But the extractor doesn't know the retry policy — how many attempts, what backoff, whether the caller is already inside a retry loop. AutoGPT already has retry machinery at a higher level. Swallowing the signal at the bottom of the stack would rob that machinery of the information it needs. Guard, log, surface — let the layer that owns policy decide.

The edge cases are small but worth naming. `choices = None` shows up in some provider responses too, and `if not response.choices` covers both `[]` and `None`, which the tests verify explicitly. The new test file exercises both extractors against empty lists, `None`, present-but-tool-less choices, and a fully populated tool call, so the normal path can't quietly regress while the guard path is being tested.

If you run anything long-lived against OpenAI-compatible endpoints — agent frameworks, eval harnesses, batch pipelines — this failure mode is waiting for you. It won't happen in your smoke tests, because providers don't send empty choices when you're watching. It happens at hour six of an unattended run, behind a content filter or a hiccuping upstream, and the `IndexError` tells you nothing. The fix took fifteen lines. Finding the assumption took longer.
