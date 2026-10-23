---
layout: post
title: "The refresh that minted twice"
permalink: /notes/oauth-refresh-token-race/
categories: [security, oauth, concurrency]
excerpt: "Refresh-token rotation is supposed to expose a stolen token. A check-then-act race in AutoGPT's token endpoint let one refresh token quietly become two independent pairs."
---

Refresh-token rotation has a second job beyond keeping access tokens fresh, and it's the one I care about: it's a tripwire. After rotation, only one party holds a working refresh token. If an attacker has a stolen copy and the real client refreshes, the attacker's copy is dead. If the attacker refreshes first, the real client's next attempt fails and something looks wrong. Either way, the leak stops being invisible.

That whole mechanism depends on one invariant: one refresh token mints exactly one new pair. I found a race in AutoGPT's OAuth backend that broke it, and the failure mode was the quiet kind — nothing errored, both requests succeeded, and a token that had been presented twice simply became two live credential sets.

## The gap between the check and the write

The refresh path did what most of us would write on a first pass. Look the token up, check `revokedAt`, reject if it's already revoked, then revoke it and mint the new pair:

```python
await PrismaOAuthRefreshToken.prisma().update(
    where={"token": token_hash},
    data={"revokedAt": now},
)
```

Two requests carrying the same token could both pass the `revokedAt` check before either one wrote. The `update` was unconditional — it didn't care what state the row was in by the time it landed. So both requests revoked the token (the second write was a no-op in effect) and both went on to mint their own access and refresh tokens. One leaked token, two independent lifelines, and the tripwire never fires because neither side ever sees a failure.

This is the same check-then-act shape as an authorization-code race the project had fixed earlier, which made me suspect it was a pattern rather than a one-off.

## Making the revoke the gate

The fix in [PR #15632](https://github.com/Significant-Gravitas/AutoGPT/pull/15632) moves the revoke from an unconditional update to a conditional write, and treats the write's result as the decision:

```python
revoked = await PrismaOAuthRefreshToken.prisma().update_many(
    where={"token": token_hash, "revokedAt": None},
    data={"revokedAt": now},
)
if revoked != 1:
    raise InvalidGrantError("refresh token has been revoked")
```

Prisma compiles this to a single `UPDATE ... WHERE token = $1 AND "revokedAt" IS NULL` — I confirmed that in the Postgres statement log rather than trusting the ORM. The reason this closes the race is a Postgres behavior worth knowing: under READ COMMITTED, when an `UPDATE` blocks behind a concurrent transaction touching the same row, it re-evaluates its `WHERE` clause against the latest committed version of that row once it unblocks. So the second request doesn't act on the snapshot it read earlier. It re-checks `revokedAt IS NULL` against the row the first request already changed, matches zero rows, and gets an `invalid_grant` error. Exactly one request flips the column, and only that request may mint.

The pleasant part is what didn't need to change. The existing checks — token exists, belongs to this application, hasn't expired, owner isn't banned — all still run first. A token's application and expiry are set at creation and never mutate, so the read-side checks genuinely cover them. `revokedAt` is the only column another request can change in between, which is why it's the only column the claim condition needs. A wrong-client request still can't burn someone else's token, and a banned user's token still waits for the unban rather than being destroyed.

## Testing a race so it races every time

Timing-dependent concurrency tests are how flaky suites are born, so the tests don't rely on timing. They patch the ban check — the last check before the revoke — with a barrier that holds every request until all of them have passed their checks:

```python
checks_passed = asyncio.Barrier(parties)

async def not_banned(user_id: str) -> bool:
    await asyncio.wait_for(checks_passed.wait(), timeout=10)
    return False
```

Release the barrier and every request claims the token at once, on every run. One test fires two concurrent `refresh_tokens` calls and expects exactly one token pair plus one `InvalidGrantError`. The other goes through the real HTTP endpoint with three concurrent refresh grants and expects one 200, two 400s, and — the part that actually matters — exactly one live refresh token and one access token in the database afterwards. These run against the CI stack's real Postgres, not a mock, because the entire guarantee lives in the database's re-check semantics.

## What's still open

Two things were deliberately left out. Reuse detection — revoking the whole token family when an already-rotated token gets replayed, per RFC 6749 §10.4 — needs a token-family link in the schema, which is a bigger change than this fix. And the revoke plus the two inserts that follow still aren't one transaction, so a failed insert after a successful revoke can leave a client holding nothing. That behavior predates the race and the patch doesn't make it worse, but it's worth naming honestly.

If you run an OAuth server with refresh rotation, it's worth grepping your own codebase for the shape: a read, a check, then an unconditional write. Rotation is only a theft-detection mechanism if exactly one party can survive it. A race that lets one token become two pairs doesn't throw an exception — it just quietly retires your tripwire.
