---
layout: post
title: "The range between private and public"
permalink: /notes/memos-cgnat-ssrf/
categories: [security, networking]
excerpt: "Memos blocked loopback and RFC 1918 in its SSRF guards, but 100.64.0.0/10 isn't private as far as Go is concerned. On the right network that range includes a cloud metadata endpoint."
---

Memos has a link preview feature: paste a URL into a note and the server fetches the page to pull out a title and description. It's a nice feature, and it's also an HTTP client that takes attacker-controlled URLs. The RPC behind it, `GetLinkMetadata`, is unauthenticated — it's on the public methods list. That combination is the classic SSRF shape, and Memos already had guards for it: the fetcher and the webhook delivery path both reject loopback, RFC 1918 private ranges, and link-local addresses.

Except there's a range that isn't in any of those lists, and Go's `net.IP.IsPrivate()` doesn't cover it either: `100.64.0.0/10`, the RFC 6598 carrier-grade NAT space. As far as the guard was concerned, anything in that range was public internet.

## Why this particular range is worse than it sounds

CGNAT space is not theoretical. Tailscale assigns addresses from it. Some carriers route it. And Alibaba Cloud puts its instance metadata service at `100.100.100.200` — an endpoint that serves RAM role credentials to anyone who can reach it. Cloud metadata endpoints are the highest-value SSRF target there is; the famous capital-one-style breaches all went through one.

So the attack against an unpatched Memos on the wrong network was: ask the link preview API to fetch `http://100.100.100.200/...`, and read the response reflected back as page metadata. No credentials needed, because the RPC is public. This is the same class of hole as CVE-2024-29028 and CVE-2025-22952, which the earlier guards were written for — they just never included the shared address space. The reporter had emailed about it in June, got no response, and eventually filed it as issue #6099 with a working demonstration.

## Both doors, not just the front one

An earlier attempt at the fix only touched the link-metadata side and stalled unmerged. That matters because Memos has a second outbound path that fetches attacker-influenced URLs: webhook delivery. Fixing one guard and leaving the other is how these bugs get rediscovered.

The guard itself is a small predicate. In the fetcher it sits behind `isInternalIP`, which already rejected loopback, private, link-local, and unspecified addresses — the fix adds the CGNAT range, with `To4()` normalization so IPv4-mapped IPv6 forms like `::ffff:100.100.100.200` can't slip past as a "different" address family. The webhook side keeps its own `reservedNetworks` prefix list, which gets `100.64.0.0/10` too. And the fetcher checks twice: when the URL is validated, and again at dial time on the address DNS actually resolved to, which is what closes DNS-rebinding style bypasses where the hostname you validated is not the address you connect to.

I opened [PR #6256](https://github.com/usememos/memos/pull/6256) carrying that fix for both paths. While it sat open, the guard change reached main through the maintainer's side, and my branch merged main in and kept what turned out to be the durable part: the regression coverage. The merged commit is the test suite.

## Tests are the actual deliverable here

SSRF guards are exactly the kind of code that regresses quietly. Someone refactors the fetcher, reorders a check, swaps a predicate for one that looks equivalent, and the hole is back — and nobody notices, because nothing about normal usage touches it. The incomplete earlier fix proves the point: one path got guarded, the other didn't, and it took a second look to notice.

So the tests are written to pin the range, not just the idea of it. Boundary addresses on both sides: `100.63.255.255` is just outside and must be allowed, `100.64.0.1` is just inside and must be rejected, `100.127.255.255` at the top of the range is rejected, `100.128.0.0` above it is fine. The Alibaba metadata address is in there by name, because that's the address an attacker actually types. The mapped form `::ffff:100.100.100.200` gets its own case, since that's the bypass you'd try if the plain form is blocked. Public controls like `8.8.8.8` make sure the guard didn't just start rejecting everything.

The test I care most about is the dial-time one. It stubs DNS resolution to return the metadata address for a normal-looking hostname, arms a tripwire on the dial function, and asks the fetcher for a page. The assertion is that the fetcher returns `ErrInternalIP` and the tripwire never fires — the rejection happens after resolution but before a single packet leaves. That ordering is the whole defense against rebinding, and it's now a test failure if anyone breaks it.

If you run Memos on a Tailscale-addressed network, on Alibaba Cloud, or behind a carrier that routes shared space, this was a reachable, unauthenticated hole. My [memos PR #6256](https://github.com/usememos/memos/pull/6256) merged on October 13, 2026. [The test suite](https://github.com/usememos/memos/pull/6256/files) is short and worth reading if you write SSRF guards of your own.
