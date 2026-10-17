---
layout: post
title: "The PONG that never came"
permalink: /notes/the-pong-that-never-came/
categories: [redis, task-queues]
excerpt: "Celery workers on managed Redis were going catatonic — alive, reachable, and silently deaf to broadcasts. The health check meant to catch this only ever watched half the conversation."
---

A Celery worker that stops answering `inspect ping` but refuses to die is an unsettling thing to debug. That was celery/celery#10502: workers on managed Redis (ElastiCache, Valkey over TLS) would run fine for a while, then silently stop consuming fanout messages. Process alive. Broker reachable. No traceback anywhere. A restart fixed it, which is the worst kind of fix, because it tells you the failure was in some state you just threw away.

The detail that unlocked it came from kokhlo in that thread: the pub/sub connection is unusual among Redis connections. A BRPOP connection cycles commands constantly, so a dead path surfaces as a failed read fairly quickly. The subclient socket, while idle, issues no commands at all — it just waits to become readable. If the TCP path dies silently (a failover at the managed broker, a NAT gateway aging out the connection-table entry), there is no traffic to fail, so nothing ever errors. And Linux won't help you either: TCP keepalive doesn't send its first probe until 7200 seconds by default. The worker can sit there deaf for two hours, looking perfectly healthy to every supervisor check.

## The health check that only sends

kombu#2498 had already added a `maybe_check_subclient_health` timer that calls redis-py's `PubSub.check_health()`, and that's the right idea. But reading the redis-py source, the check is only half of a health check:

```python
if conn.health_check_interval and time.monotonic() > conn.next_health_check:
    conn.send_command("PING", self.HEALTH_CHECK_MESSAGE, check_health=False)
    self.health_check_response_counter += 1
```

It sends the PING and increments a counter. That's it. On a half-open socket, the write lands in the kernel's send buffer and succeeds — the local kernel has no idea the other end is gone. No exception, no error return, nothing for kombu to catch. The timer fires every interval, the counter ticks up, and the worker stays catatonic until someone restarts the container.

The receiving half of the exchange was already being counted, just nobody was looking at it. redis-py decrements `health_check_response_counter` every time a PONG is parsed, so on a healthy connection the value hovers at 0 or 1. A counter that climbs interval over interval means pings are going out and nothing is coming back — which is exactly the half-open signature the send-only check can't see.

## Counting what doesn't come back

The fix I landed in [kombu PR #2590](https://github.com/celery/kombu/pull/2590) watches that counter inside the existing timer:

```python
missed = getattr(client, 'health_check_response_counter', None)
if isinstance(missed, int) and missed >= SUBCLIENT_MAX_MISSED_HEALTH_CHECKS:
    warning('Redis pub/sub connection missed %d health '
            'check responses; dropping stale connection', missed)
    client.health_check_response_counter = 0
    connection = client.connection
    if connection is not None:
        connection.disconnect()
    continue
client.check_health()
```

Once two full intervals pass without a PONG, the connection is treated as dead and dropped. From there kombu's existing reconnect machinery does the work it already knows how to do: `_on_connection_disconnect` prunes the fd from the poller, and the next `on_poll_start` re-registers the subclient and resubscribes. With the default `health_check_interval` of 25 seconds, detection is bounded at roughly 50 seconds instead of two hours or a manual restart.

Two decisions I went back and forth on. First, the threshold is 2, not 1. A single outstanding PING can just mean the event loop stalled for an interval — a long callback, a GC pause. Two unanswered pings in a row means the path is gone. False reconnects on busy-but-healthy workers seemed worse than one extra interval of detection time, since a reconnect drops and re-establishes every subscription on that socket.

Second, resetting the counter when we drop. redis-py's `clean_health_check_responses()` only drains responses that actually arrive, so a counter inflated by the dead connection survives the reconnect. Leave it at the threshold and the fresh connection gets dropped on the very next timer pass — a reconnect loop that looks, from the outside, exactly like the original bug. Zeroing it mirrors what `PubSub.reset()` does.

The inert cases matter too. If `health_check_interval` is 0, redis-py never sends pings, the counter never increments, and the new check simply never triggers. And if someone runs an older redis-py without the counter attribute, the `getattr` falls through to the old send-only behavior. No new failure modes for deployments that haven't opted into health checks.

## Testing a socket that lies to you

The unit tests cover the drop at threshold, sub-threshold pass-through, the counter reset, the missing-attribute fallback, and a stale counter with no connection object attached. But mocks can make counter interop look easier than it is, so I also ran the scenario against a real `redis.client.PubSub` wired to a fake half-open connection, to confirm the counter actually behaves the way the fix assumes when a real parser is involved.

The integration tests go further: subscribe a fanout consumer to a live Redis, force the counter to the threshold, run the health timer, and assert the socket is gone — then let the next poll cycle resubscribe and confirm a published message actually arrives. That last part is the one that matters operationally. Dropping a stale connection is only a fix if messages flow again afterwards.

Who hits this: anyone running Celery fanout — control broadcasts, `inspect`, remote revoke — over a managed Redis with failovers or a NAT in the path, which is to say most cloud deployments. The PR merged on August 31, 2026. If your workers have been mysteriously ignoring broadcasts until restarted, this is probably why.
