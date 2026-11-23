---
layout: post
title: "The string literal that broke out of its script tag"
permalink: /notes/the-end-tag-the-escape-missed/
categories: [rust, parsing]
excerpt: "monolith inlined my JavaScript and escaped the closing script tag. The HTML tokenizer accepts several other spellings, and my bundle used one."
---

I archived a page the other day and opened the saved file to find a chunk of minified JavaScript rendered as plain text. Same symptom someone had reported in [issue #497](https://github.com/Y2Z/monolith/issues/497), so I dug in instead of filing a duplicate.

[monolith](https://github.com/Y2Z/monolith) is a Rust CLI that saves a page as one self-contained HTML file: it downloads the assets and inlines them. Inlining JavaScript into a `<script>` element has a well-known trap — a `</script>` byte sequence inside the code terminates the element early — so there's an escape pass. The escape, added in an earlier commit for this exact class of bug, was one call:

```rust
.replace("</script>", "<\\/script>")
```

Exact bytes, exact case, exact `>`. The problem is that this isn't what an HTML parser looks for. In the WHATWG tokenizer's [script data end tag name state](https://html.spec.whatwg.org/#script-data-end-tag-name-state), the tag name matches ASCII case-insensitively, and it only has to be followed by tab, line feed, form feed, carriage return, space, `/`, or `>` to count as an end tag. Which means `</SCRIPT>`, `</script >`, `</script/>`, and uglier friends all terminate the element — and none of them match the replace. A minified bundle holding any of those variants in a string literal breaks out of the wrapper. Everything after it gets parsed as page content, and the saved file quietly loses the code and gains a text node.

I reproduced it against master with a two-line page and a one-line script — `s.innerHTML="<script></SCRIPT>"` — and watched the uppercase variant sail through verbatim into the output.

## Escape what the tokenizer accepts, nothing else

The fix swaps the literal replace for a small byte scanner, `escape_script_end_tag` in js.rs, that mirrors the tokenizer's rule:

```rust
while i + 8 <= bytes.len() {
    if bytes[i] == b'<'
        && bytes[i + 1] == b'/'
        && bytes[i + 2..i + 8].eq_ignore_ascii_case(b"script")
        && (i + 8 == bytes.len()
            || matches!(bytes[i + 8],
                b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' | b'>'))
    {
        result.push_str(&code[copied..=i]);
        result.push('\\');
        copied = i + 1;
        i += 2;
    } else {
        i += 1;
    }
}
```

Same escape as before — `<\/...`, which JavaScript treats as an escaped solidus inside a string literal, so the code's meaning doesn't change — but now applied to every spelling the tokenizer would close the element on.

The decisions that make this right are mostly negative ones. `</scripts>` and `</scriptx>` are not end tags, because the tokenizer requires the delimiter immediately after the name, so the scanner leaves them alone. Escaping them would alter the string's bytes for zero parser benefit, and an archiver has no business rewriting bytes the browser wouldn't have touched. Open tags, lone `<`, and truncated `</scr` stay untouched for the same reason. Slicing stays safe on multibyte input because copy boundaries only ever land on ASCII match positions — there's a test with a multibyte character sitting right before the tag to pin that.

One case is deliberately over-eager: a name at end of input, like `a</script`. The tokenizer wouldn't actually complete that into an end tag at EOF, but the scanner escapes it anyway. The escape is byte-neutral inside a JavaScript string, so the over-approximation costs nothing and keeps the rule simple.

## Proving it end to end

The scanner gets eleven unit tests: case variants, each whitespace delimiter, the solidus form, multiple end tags in one string, the EOF case, and the negative guards for longer tag names and lone angle brackets. On top of that, a CLI test archives a fixture page whose script holds all five variants and asserts the output escapes the four real end tags while leaving `</scripts>` alone. `cargo test --release` came back 296 passed, 0 failed, and I ran the built binary against a local HTTP server serving the repro payloads — the archived page comes out clean.

The edge I'm least sure about is the double-escaped script state: `<!--<script>...</script>-->` inside an inline script. The tokenizer tracks extra states for that construct, and a literal `</script` inside it does exit back toward script data — which the scanner catches — but I didn't add explicit handling for `<!--` or `<script` openers in the payload. I flagged it on the PR rather than pretending it was settled. If it turns out to matter, the follow-up has the same shape as this fix: match the tokenizer's state machine, escape what it accepts.

## Why an archiver can't afford one literal

monolith's whole promise is fidelity, and this failure mode is the worst kind for a tool like it: the command exits 0, the file looks plausible at a glance, and the corruption only shows up when you open the page and half the interactivity is missing. Modern bundles are exactly where these variants live — templates and `innerHTML` snippets embedded as string literals, minified, with casing and whitespace that nothing in JavaScript constrains. An escape one literal wide was never going to hold.

My [monolith PR #498](https://github.com/Y2Z/monolith/pull/498) merged on October 4, 2026. [Implementation and tests](https://github.com/Y2Z/monolith/pull/498/files).
