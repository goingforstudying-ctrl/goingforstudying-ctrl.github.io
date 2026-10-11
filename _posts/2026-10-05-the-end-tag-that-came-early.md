---
layout: post
title: "The end tag that came early"
---

I archived a page the other day, opened the saved file to check it, and right there in the middle of the rendered page was a big chunk of minified JavaScript printed as visible text. Not in a source viewer, not syntax highlighted — just raw JS sitting in the page body where the content was supposed to be.

The nasty part: I'd seen this exact symptom before, in the same tool, and it had already been fixed once.

The tool is [monolith](https://github.com/Y2Z/monolith), a Rust CLI that saves a web page as a single self-contained HTML file. It walks the DOM, downloads every external asset, and inlines it: CSS becomes `<style>` blocks, images become data URLs, and external scripts get their contents copied into the `<script>` element that referenced them.

That last step is where the trap lives. To an HTML parser, the contents of a `<script>` element are raw text. There's no entity layer, no escaping — the tokenizer scans for what looks like `</script>` and the first match terminates the element, full stop. So if the JavaScript you're inlining contains the string `"</script>"` — and plenty of real code does, think templating helpers or `el.innerHTML = "<script>...</script>"` — the saved file ends the script early and the remainder of your JS spills out and gets parsed as page content. Hence the text dump.

The classic defense is to rewrite `</script>` as `<\/script>` before inlining. Inside a JS string literal `\/` is just `/`, the escape is a no-op, so the code behaves identically, but the HTML tokenizer never sees an end tag. monolith already had that fix, from the earlier round of this bug:

```rust
tendril.push_slice(
    &String::from_utf8_lossy(&data)
        .replace("</script>", "<\\/script>"),
);
```

One problem: `.replace("</script>", ...)` matches the exact lowercase string, and the HTML tokenizer is a lot more liberal than that. Per the WHATWG spec's [script data end tag name state](https://html.spec.whatwg.org/#script-data-end-tag-name-state), the tag name matches ASCII case-insensitively, and it counts as an end tag as long as the next character is whitespace, a solidus, or `>`. All of these end your script element:

```
</SCRIPT>
</ScRiPt>
</script >
</script\t>
</script/>
```

A bundle with `"</SCRIPT>"` sitting in a string literal sails straight through the old escape, breaks out of the wrapper element, and everything after it gets parsed as page content. My repro against master was embarrassingly small — one HTML file, one JS file containing `s.innerHTML="<script></SCRIPT>";` — and the archived output had the tail of the script rendered as text. Same story for the whitespace and solidus variants.

So the fix in [PR #498](https://github.com/Y2Z/monolith/pull/498) swaps the single-literal replace for a small scanner that asks the same question the tokenizer asks:

```rust
pub fn escape_script_end_tag(code: &str) -> String {
    let bytes: &[u8] = code.as_bytes();
    let mut result: String = String::with_capacity(code.len());
    let mut copied: usize = 0;
    let mut i: usize = 0;

    while i + 8 <= bytes.len() {
        if bytes[i] == b'<'
            && bytes[i + 1] == b'/'
            && bytes[i + 2..i + 8].eq_ignore_ascii_case(b"script")
            && (i + 8 == bytes.len()
                || matches!(
                    bytes[i + 8],
                    b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' | b'>'
                ))
        {
            result.push_str(&code[copied..=i]);
            result.push('\\');
            copied = i + 1;
            i += 2;
        } else {
            i += 1;
        }
    }

    result.push_str(&code[copied..]);
    result
}
```

A few details are worth pointing at.

The delimiter set is the spec's, not an approximation. Tab, line feed, form feed, and space are the whitespace the tokenizer accepts after a tag name; `/` and `>` are the two other legal transitions out of the end-tag-name state. The `\r` looks redundant until you remember the HTML input stream normalizes carriage returns to line feeds before tokenization ever runs, so `</script\r>` in a file still ends the script in the browser. Skip it and the escape has a hole exactly one byte wide.

The needle is compared case-insensitively but only over pure ASCII (`eq_ignore_ascii_case(b"script")`), and the result is built from slices cut at `i`, which always points at `<` — a one-byte character — so the `&str` slicing can never split a UTF-8 sequence. There's a unit test with a multibyte character glued to the front of the tag to pin that down.

`</scripts>` is deliberately left alone. The character after the tag name is `s`, which is not a delimiter, so the tokenizer treats the whole thing as text and keeps scanning. Escaping it anyway would change the string's bytes for no reason — every false positive in an escape like this is a tiny corruption you chose to introduce. Same philosophy at end of input: `"a</script"` with nothing after the tag name is technically not an end tag, but the scanner escapes it anyway. One wasted backslash in a malformed edge case beats a hole.

Why a scanner instead of growing the replace list or reaching for a regex? The replace list is open-ended — you'd be enumerating case combinations times delimiter characters, and you'd still get surprised. A regex can express it, but then you're pulling a regex engine into a hot text path to model three tokenizer states, and the honest translation of the spec is about twenty lines of byte comparisons either way. I'd rather read the twenty lines.

Testing was the part I cared about most, because the previous fix died from an undertested assumption about how HTML actually parses. The PR adds unit tests for the scanner itself — case variants, tab/space/newline after the tag name, solidus, tag at end of input, multibyte prefix, plus negative guards for `</scripts>`, a truncated `</scr`, and a lone `<` — and an end-to-end CLI test that runs the real binary over a fixture page whose script file contains every variant, asserting each one comes out escaped while `</scripts>` passes through untouched. Full suite green, 296 passed. I also ran the built binary against a local server with the original repro payloads and watched the archived page come out clean.

One corner I'm still not fully certain about: the double-escaped state. If an inline script contains `<!--<script>...</script>-->`, the tokenizer enters a weird nested mode, and the scanner handles the `</script` that would exit it but doesn't specially track a literal `<!--` or `<script` inside the payload. I think it's covered; I flagged it in the PR instead of claiming otherwise.

If you archive pages with monolith — or honestly, if you do any kind of server-side embedding of third-party JS into HTML, which describes a lot of CMS and ad pipelines — this class of bug ships silently. The page saves fine, the file looks plausible at a glance, and nobody notices until someone opens the archive and finds JavaScript where the content should be. The first fix taught me the symptom. This one taught me to read the tokenizer section of the spec before trusting a string replace.
