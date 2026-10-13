---
layout: post
title: "The private range that wasn't"
permalink: /notes/the-private-range-that-wasnt/
categories: [security, go]
excerpt: "Memos blocked loopback and RFC 1918 in its SSRF guards, but Go's net package doesn't think 100.64.0.0/10 is private. On a tailnet or Alibaba Cloud, that turned an unauthenticated link-preview endpoint into a readable SSRF."
---

Memos has a link preview feature I like: paste a URL into a note and the server fetches the page, pulls the OpenGraph title and description, and renders a card. It's convenient, and it's also the exact shape of a classic server-side request forgery problem. The server dials an attacker-chosen host on demand. Memos knows this, and both the link-metadata fetcher and the webhook delivery path reject destinations that point at loopback, RFC 1918 private space, and link-local addresses.

There was a hole in the list, and it was a meaningful one. Neither guard covered `100.64.0.0/10`, the RFC 6598 shared address space, better known as carrier-grade NAT space. I put up [a fix that closes it in both places](https://github.com/usememos/memos/pull/6256), and the reason the hole existed at all is worth understanding, because it's a trap in Go's standard library that other people are probably sitting on too.

## IsPrivate has an opinion

The link-metadata guard was a one-liner built out of `net.IP` helpers:

```go
func isInternalIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()
}
```

That reads like it covers everything internal. It doesn't. Go's `IsPrivate()` returns true only for RFC 1918 (`10/8`, `172.16/12`, `192.168/16`) and the IPv6 ULA range. The `100.64.0.0/10` block is deliberately excluded, because RFC 6598 calls it "shared address space" rather than private — it's meant for ISP-grade NAT, and in principle a host in that range can be reachable across administrative boundaries. Go's authors implemented the RFC's classification faithfully, and the RFC's classification is exactly what makes it dangerous to rely on here.

The problem is what lives in that range in practice. Tailscale assigns every node on a tailnet an address from `100.64.0.0/10`. Alibaba Cloud's instance metadata endpoint is `100.100.100.200`, and it serves RAM credentials. Carrier networks route it internally. If a Memos server sits on any network where that space is routable, the guard looked at an internal, credential-serving host and classified it as public internet.

What made this worse than the usual "missing range" bug is the endpoint's auth posture. `GetLinkMetadata` and `BatchGetLinkMetadata` are in Memos' `PublicMethods` list — no session required. So anyone who could reach the server at all could ask it to fetch `http://100.100.100.200/latest/meta-data/...` and read the response back through the returned title and description. That's a readable, unauthenticated SSRF. The earlier CVE fixes in this codebase (CVE-2024-29028, CVE-2025-22952) had closed the same hole for the ranges they covered; this was the range those fixes missed.

## Closing both doors

There are two independent fetch paths in Memos, and both had the gap. The link-metadata fetcher resolves the host and checks each resolved IP before dialing — that dial-time re-check is what stops DNS rebinding, so it's the layer that matters most. The webhook validator keeps its own blocklist as a table of `netip.Prefix` values. An earlier attempt at this fix only touched the fetcher side and never landed, so I made a point of covering both.

The fetcher guard now has an explicit range check after the standard helpers:

```go
func isInternalIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return true
	}
	// IsPrivate excludes RFC 6598 shared address space (100.64.0.0/10).
	// To4 also covers IPv4-mapped IPv6 addresses.
	ipv4 := ip.To4()
	return ipv4 != nil && ipv4[0] == 100 && ipv4[1] >= 64 && ipv4[1] <= 127
}
```

The `To4()` call is doing quiet but important work: it normalizes IPv4-mapped IPv6 addresses, so `::ffff:100.100.100.200` collapses to the same four bytes and gets rejected instead of sailing through as an IPv6 address the range check doesn't recognize. The webhook side got the equivalent one-liner — `netip.MustParsePrefix("100.64.0.0/10")` added to its `reservedNetworks` table, which its own matcher already walks at URL-validation time and again at dial time.

I considered the alternative of replacing the hand-rolled check in the fetcher with a shared prefix table like the webhook path uses. It would be tidier, but the fetcher works on `net.IP` values coming back from the resolver, the byte check is cheap and obviously correct, and the two packages don't share code today. Consistency within each guard beat unifying them across packages.

## Pinning the boundaries

Range checks are the kind of code that's easy to get subtly wrong — an off-by-one on the second octet, a mapped-IPv6 form that bypasses the comparison — so the tests matter as much as the guard. Both test suites now pin the exact boundaries: `100.63.255.255` just below the range must pass, `100.64.0.1` at the bottom and `100.127.255.255` at the top must be blocked, `100.128.0.0` just above must pass, and the mapped IPv6 form of the Alibaba metadata address must be blocked. The fetcher also gets a behavioral test that stubs the resolver to return `100.100.100.200` and asserts the dialer never fires at all — the request dies with `ErrInternalIP` before a socket opens.

The boundary cases are the ones I'd expect a future refactor to break. Someone "simplifying" the check back to `IsPrivate()` alone, or widening it to `ipv4[1] >= 64` without the upper bound, would flip a test immediately.

## Who actually hits this

The exposure is specific but real: any Memos deployment where CGNAT space is routable and reachable from the server. Self-hosters running Memos on a tailnet are the obvious group — their tailnet services sit squarely in `100.64.0.0/10`, and the unauthenticated endpoint would happily fetch and reflect them. Deployments on Alibaba Cloud are the scarier case, because the metadata endpoint's RAM credentials are the prize, and the whole point of that endpoint is that nothing should be able to reach it except the instance itself. Carrier-grade NAT on the upstream network is the third case, and the operator usually doesn't even know their ISP does it.

The broader lesson isn't really about Memos. If you write SSRF guards in Go and your blocklist starts and ends with `IsPrivate()`, you've made a decision about RFC 6598 whether you meant to or not. The standard library's taxonomy is technically correct; it's just answering a different question than the one a security guard needs answered. "Is this address private per the RFCs" and "can this address reach something I shouldn't dial" overlap heavily, but they are not the same set. `100.64.0.0/10` lives in the gap, and so does whatever your infrastructure put there.
