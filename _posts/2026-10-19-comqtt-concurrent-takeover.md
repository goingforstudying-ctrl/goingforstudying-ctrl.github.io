---
layout: post
title: "The reconnect that connected and then went dark"
permalink: /notes/comqtt-concurrent-takeover/
categories: [concurrency, distributed-systems]
excerpt: "Two MQTT connections with the same client id could both pass session takeover, leaving one live but invisible to the broker. A striped lock and an identity-checked delete fixed it."
---

A device on a flaky network reconnects to the broker. The broker says you're connected. And then nothing arrives. Your subscriptions are still live, the socket is fine, publishes are flowing through the broker — just not to you. I hit this with comqtt, and it turned into one of those bugs where the failure mode is silence, which is the worst kind to chase because every health check insists the client is fine.

The path involved is session takeover. When a client connects with a client id that's already registered, MQTT says the broker must disconnect the old connection and hand the session to the new one ([MQTT-3.1.4-3]). In comqtt that handoff lived in `attachClient`:

```go
sessionPresent := s.inheritClientSession(pk, cl) // get + disconnect + delete existing
s.Clients.Add(cl)
```

Two lines, with nothing synchronizing between them and nothing serializing the pair across goroutines. So when two connects with the same id arrive at once — a device retrying while its old connection is still half-open, completely normal on a bad network — both goroutines can run `inheritClientSession` before either one adds itself. Both see "no existing session." Both call `Add`. The map keeps the last write.

The loser is the interesting one. Its socket is still open, its read loop is still running, it believes it has a session. But it's no longer in `Clients`, so every publish addressed to its subscriptions goes through `Clients.Get` — which returns the other connection. Silent message loss on a connection that looks perfectly healthy from the outside.

And the loser gets one last bite on the way down: when it finally disconnects, cleanup called `s.Clients.Delete(cl.ID)` unconditionally. That delete doesn't care whose entry it removes — it could knock the *winner* out of the registry too.

## The fix, in two pieces

First, serialize the inherit-and-add pair per client id. I added a small striped lock — 64 mutexes keyed by FNV-32a of the client id — so takeovers of the same id are atomic, while unrelated ids never block each other:

```go
unlock := s.establishMu.lock(cl.ID)
sessionPresent := s.inheritClientSession(pk, cl)
s.Clients.Add(cl) // [MQTT-4.1.0-1]
unlock()
```

Now each duplicate connect properly disconnects its predecessor, and exactly one connection survives.

Second, make deletes identity-checked. The registry grew a `CompareAndDelete` that removes an entry only if the map still holds that exact client pointer:

```go
func (cl *Clients) CompareAndDelete(id string, val *Client) bool {
	cl.Lock()
	defer cl.Unlock()
	if cur, ok := cl.internal[id]; ok && cur == val {
		delete(cl.internal, id)
		return true
	}
	return false
}
```

A stale cleanup path can now only remove itself, never whoever replaced it. The session-expiry sweeper had the same dangerous shape — snapshot the map, decide a disconnected client has expired, delete by id, with a fresh reconnection able to slip in between — so `clearExpiredClients` uses `CompareAndDelete` too.

## Why stripes instead of something simpler

One broker-wide mutex around `attachClient` would also close the race, but it serializes every connect in the process behind a takeover. A per-id map of locks avoids that, but then the locks themselves need lifecycle management — when do you delete a lock, and who deletes it while someone else is about to lock it? Stripes are the boring middle ground: bounded memory, no lifecycle, and a collision just means two unrelated ids occasionally wait a few microseconds for each other. The critical section is a map lookup and a disconnect; that's a fine price.

## Making the race deterministic

The hard part of testing a window this small is forcing it open. I used a hook: `takeoverBarrierHook` parks every connection inside `OnSessionEstablish` on a channel until released. The test spins up sixteen connections with client id `"zen"` over `net.Pipe`, waits for all sixteen to arrive at the barrier, then releases them together.

Before the fix: one of fifteen duplicates got disconnected; the rest stayed live but invisible to the broker. After: exactly one survivor, and closing it drops the id from the registry completely. `go test -race ./mqtt/...` is clean, and I ran the new test with `-count=10` to make sure it isn't flaky. That's in [the PR](https://github.com/wind-c/comqtt/pull/185) if you want the full packet bytes for the hand-rolled CONNECT frame.

One edge I deliberately left alone: `cluster/agent.go` deletes clients by id in response to peer messages, with its own cross-node ordering semantics. It probably deserves the same identity-checked treatment, but the ordering story there is different enough that it wants its own look rather than a drive-by in this patch.

Who hits this in production: anyone running comqtt in front of clients that reconnect aggressively — IoT fleets on cellular, devices bouncing between access points, mobile apps in elevators. The window is small, but the cost of hitting it is a silently deaf device, and those are the tickets that take weeks because nothing looks broken.
