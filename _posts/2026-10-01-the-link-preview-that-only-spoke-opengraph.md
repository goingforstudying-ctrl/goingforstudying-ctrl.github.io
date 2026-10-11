---
layout: post
title: "The link preview that only spoke OpenGraph"
---

There's a special category of bug where the user report sounds like gaslighting. "The link preview has no description," they say, "but the description is right there in the HTML." You open the page, view source, and they're right — it's *right there*, in a `<meta>` tag, exactly where descriptions live. That was [issue #5980](https://github.com/usememos/memos/issues/5980) in memos: paste certain links into a memo and the preview card renders a title, maybe an image, and a big blank where the description should be.

The pages in question weren't doing anything exotic. They were using `<meta name="description" content="...">` — the original, boring, HTML-standard way to describe a page, older than most frontend frameworks. And memos couldn't see it, because memos only spoke OpenGraph.

## One attribute name, silently enforced

Memos fetches link preview metadata in a small Go package, `internal/httpgetter`. It streams the HTML through `x/net/html`'s tokenizer and, for every `<meta>` token, asks a helper to pull out specific properties. The helper looked like this:

```go
func extractMetaProperty(token html.Token, prop string) (content string, ok bool) {
    for _, attr := range token.Attr {
        if attr.Key == "property" && attr.Val == prop {
            ok = true
        }
        if attr.Key == "content" {
            content = attr.Val
        }
    }
    return
}
```

Read that first condition carefully. It requires the attribute *key* to be `property`. OpenGraph tags look like `<meta property="og:description" content="...">`, so those match. But the standard HTML description tag is `<meta name="description" content="...">` — the key is `name`, not `property`. The loop walks right past it. No error, no fallback, no log line. The description just never exists as far as the parser is concerned, and the preview card ships with an empty string.

That's the whole bug: one string comparison encoding an assumption that every website on the internet uses OpenGraph. Which, to be fair, is an assumption a lot of the modern web lets you get away with — until you link to a blog from 2009, a minimal personal site, a documentation page, or any generator that only emits the standard tag. The long tail of the web is big, and a lot of it never got the OpenGraph memo.

## The fix, and why it needed a second change

Widening the matcher is the obvious part, from [the PR](https://github.com/usememos/memos/pull/6000):

```go
if (attr.Key == "property" || attr.Key == "name") && strings.EqualFold(attr.Val, prop) {
```

Two things happening here. The key can now be `property` *or* `name`, so both tag styles are visible. And the value comparison is case-insensitive, because HTML authors are not known for consistent casing — `<meta name="Description">` is out there, and the tokenizer doesn't normalize attribute values for you. One of the new regression tests feeds in exactly that capitalized variant to prove it.

But there's a subtlety that made the fix more than one line. Once `extractMetaProperty(token, "description")` can match `name="description"`, you've created a precedence question: what happens when a page has *both* `og:description` and the standard tag? OpenGraph is the richer, more deliberate metadata — when a site bothers to write OG tags, that's the description it wants previews to show. So the generic match should only fill the field when OpenGraph didn't. That meant reordering the extraction so `og:description` is read first and the fallback is conditional:

```go
ogDescription, ok := extractMetaProperty(token, "og:description")
if ok {
    htmlMeta.Description = ogDescription
}

description, ok := extractMetaProperty(token, "description")
if ok && htmlMeta.Description == "" {
    htmlMeta.Description = description
}
```

Without the `htmlMeta.Description == ""` check, whichever tag appeared later in the document would win, and you'd get fun nondeterminism where the preview text depends on the order an author happened to list their meta tags. With it, OG wins when present and the standard tag rescues everything else.

The regression test is the other half of the PR: a page with *only* `<meta name="description">` and no OpenGraph at all, asserting the description lands in the preview struct. That exact fixture would have failed before the change and passes after — the tightest possible statement of the bug.

## The archaeology

One detail I appreciated while digging: this wasn't the first attempt. An earlier PR, #5822, had tried to fix the same issue but went stale and was closed — and in the meantime the file had moved packages, so the patch wouldn't even have applied cleanly anymore. The bug had been sitting there the whole time, surviving a refactor, because the refactor moved the code without changing the assumption inside it. That's how these parser gaps persist for years: they're not broken loudly enough to force a fix, and every partial attempt rots before it lands.

What's left on the table? Not much, honestly. `<meta name="og:description">` — key `name`, OG value — now also matches, which is technically off-spec but harmless and arguably correct (the author clearly meant it as OG data). Twitter Card tags (`twitter:description`) are still unread; that'd be a reasonable follow-up using the same helper, now that the helper understands `name`. And pages with no description tag at all still get an empty preview, which is correct behavior, not a gap.

The impact is easy to underestimate because it's invisible when things work. Every memos user who pastes a link gets a preview card, and for a meaningful slice of the web — anything without OpenGraph — that card was permanently missing its description. One attribute check, one precedence guard, and the long tail of the web renders properly. The best part of the fix is that there's nothing clever in it. The cleverness was the bug.
