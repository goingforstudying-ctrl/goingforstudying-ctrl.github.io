---
layout: post
title: "The join that followed redirects forever"
---

Every retry loop deserves a hostile review question: "what's the bound?" I asked it of rqlite's cluster join path and the answer was "there isn't one" — a client trying to join a Raft cluster would follow leader redirects in a bare `for {}` loop, and if the cluster's view of leadership was even slightly confused, the join hung forever. No error, no timeout, no log line that explains itself. Just a node that never joins.

rqlite is the distributed SQLite database that wires SQLite to HashiCorp's Raft. When a new node joins a cluster, it has to reach the Raft leader, because only the leader can add it to the cluster configuration. The client rarely knows who the leader is, so the protocol is redirect-based: ask any node; if it's not the leader, it replies "not leader" plus the address it believes is the leader, and the client dials that address and asks again. In a healthy cluster this converges in one or two hops.

The loop that implemented it had no exit condition of its own:

```go
for {
    conn, err := c.dial(nodeAddr)
    // ... send JoinRequest, read response ...
    if resp.Error == "not leader" {
        nodeAddr = resp.Leader   // follow the redirect, ask again
        continue
    }
    return nil
}
```

The failure mode, flagged in the linked issue, is two nodes redirecting to each other. Node A says "the leader is B," node B says "the leader is A," and the client ping-pongs between them indefinitely. That sounds exotic until you think about when joins actually happen: cluster bootstrap, re-bootstrap after a wipe, recovery from a bad topology change — precisely the moments when a node's cached idea of leadership is most likely to be stale or flat-out wrong. Each hop is a fresh TCP dial, a protobuf round-trip, and a close, so the loop isn't just stuck, it's stuck *busy*, burning connections on both ends at full speed. And because nothing in the loop body consulted the context, even a caller who passed a cancellable context only got cancellation checked once, before the first iteration.

The fix in [rqlite PR 2664](https://github.com/rqlite/rqlite/pull/2664) gives the loop a bound and a conscience:

```go
const maxRedirects = 10

for i := 0; i < maxRedirects; i++ {
    if err := ctx.Err(); err != nil {
        return err
    }
    conn, err := c.dial(nodeAddr)
    // ... same redirect-following body ...
    return nil
}
return errors.New("max redirects exceeded")
```

Ten redirects is generous — real clusters resolve in one or two — so hitting the cap is itself diagnostic: if you bounced ten times, the cluster's leadership view is broken and the honest thing to do is return an error that says so, instead of contributing more load to a confused cluster. The `ctx.Err()` check at the top of every iteration means a caller with a deadline or cancellation now actually gets heard mid-loop, not just before it.

Both changes are deliberately boring. There's no backoff, no jitter, no deduplicating the addresses seen so far. I considered tracking visited addresses and failing on the first repeat — it would catch a two-node cycle in three hops instead of ten — but it adds a map and a subtlety (legitimate paths can revisit an address if leadership is actively settling) for no real gain. A flat cap fails slightly later and is impossible to misunderstand. Simple bound, clear error, context respected. That's the whole fix.

The tests are the part I enjoyed, because "an infinite redirect loop" is exactly the kind of thing you can now test *because* it's bounded. The main regression test stands up a stub server whose handler always answers "not leader" with its own address — a one-node infinite loop, the purest form of the bug. Every redirect it serves gets pushed into a buffered channel. The test asserts `Join` returns an error containing "max redirects exceeded", then drains the channel and counts exactly `maxRedirects` attempts — not eleven, not "at least one," the loop runs precisely the advertised number of times and stops. Before the fix, that test would hang forever, which is its own way of demonstrating the bug.

A second test cancels the context before calling `Join` against the same always-redirecting server and asserts the error is `context canceled`, pinning the per-iteration context check. A third verifies the happy path still works: first response redirects, second succeeds, `Join` returns nil after exactly two attempts. Bounded doesn't mean broken for healthy clusters.

Who hits this: anyone automating rqlite cluster formation — Kubernetes init containers, Terraform provisioners, bootstrap scripts — where a hung join is a hung deployment with no error to alert on. An unbounded redirect loop fails silently; a bounded one fails with a message you can grep for. The broader lesson is one I keep applying everywhere now: any loop whose trip count depends on the *other side's* behavior is a trust boundary. Redirects, retries, pagination cursors, follow-up requests — if a confused peer can make you loop forever, the loop needs a bound you chose, not one they did.
