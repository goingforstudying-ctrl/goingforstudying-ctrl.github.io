---
layout: post
title: "PING succeeds, PONG never comes"
---

A Celery worker can remain alive while Redis broadcasts stop reaching it. In [celery/celery#10502](https://github.com/celery/celery/issues/10502), workers stopped responding to control traffic and recovered after a restart. The investigation focused on a pub/sub connection that stayed open locally while no longer receiving responses.

The key distinction is the pub/sub connection. Other worker connections issue commands or use blocking operations with their own timeout behavior. An idle pub/sub connection can instead wait for readable data. If packets disappear without a reset, the connection can look established locally even though it is no longer receiving anything.

TCP keepalive and transport timeout settings can help, but their effect depends on whether they are enabled and how they are configured. An application-level health check needs to account for a missing response as well as a failed send.

Kombu already had a partial answer. An earlier change, [#2498](https://github.com/celery/kombu/pull/2498), added a `maybe_check_subclient_health` timer that calls redis-py's `PubSub.check_health()` every `health_check_interval` (25 seconds by default). The right idea. So why were workers still freezing? Because of what `check_health()` actually does:

```python
if conn.health_check_interval and time.monotonic() > conn.next_health_check:
    conn.send_command("PING", self.HEALTH_CHECK_MESSAGE, check_health=False)
    self.health_check_response_counter += 1
```

This path sends the PING; it does not synchronously wait for a PONG. On a broken network path, a write can initially succeed because the kernel accepted the bytes into a send buffer. A successful send therefore does not prove that the broker received the request or that its response will arrive.

The information needed to detect this was already there, though — redis-py decrements `health_check_response_counter` every time a PONG is parsed, so on a healthy connection the value hovers at 0 or 1. The counter *was* the tell; nothing was reading it. My fix in [celery/kombu#2590](https://github.com/celery/kombu/pull/2590) makes the timer look at that other side of the exchange:

```python
missed = getattr(client, 'health_check_response_counter', None)
if isinstance(missed, int) and missed >= SUBCLIENT_MAX_MISSED_HEALTH_CHECKS:
    warning('Redis pub/sub connection missed %d health check responses; '
            'dropping stale connection', missed)
    client.health_check_response_counter = 0
    connection = client.connection
    if connection is not None:
        connection.disconnect()
    continue
client.check_health()
```

The new timer path disconnects when it observes at least two outstanding health-check responses. Kombu then uses its existing disconnect, poller registration, and subscription recovery paths. With a 25-second interval, recovery is expected on the scale of a few timer ticks, but 50 seconds is not a hard bound: the check runs before the next PING, the first tick has a phase offset, and event-loop delays can postpone both reads and timer callbacks.

Two details matter to the recovery behavior.

A threshold of two tolerates more delay than a threshold of one. It is a recovery policy, not proof that the network path is dead: a busy event loop can delay PONG processing even on a working connection. The integration tests exercise both a healthy connection that keeps receiving fanout messages and a connection whose counter is explicitly set to the threshold, which then disconnects and resubscribes. That second test checks recovery, not a measured blackhole-detection deadline or lossless delivery during the outage.

Resetting the counter to zero on the way out is load-bearing. redis-py's `clean_health_check_responses()` only drains responses that actually arrive, and the counter lives on the `PubSub` object, not the connection — it survives the reconnect. Leave it at 2 and the freshly resubscribed connection would trip the threshold on the very next timer fire, forever. That would be a reconnect loop dressed up as a fix.

I also kept the escape hatch wide: the counter is read with `getattr(..., None)`, so an older redis-py that predates `health_check_response_counter` just falls through to the old send-a-PING behavior. No hard dependency bump.

The change is relevant to Celery deployments using Redis fanout or broadcast traffic where a pub/sub connection can silently stop receiving. It does not diagnose every worker hang, and it relies on health checks being enabled and on a redis-py version exposing the response counter. If broadcasts stop until a restart, inspect those conditions alongside broker, network, and event-loop health. The fix merged in Kombu #2590; check whether your installed release includes it.

Implementation reference: [merged commit](https://github.com/celery/kombu/commit/3842028220fe45df684f780dc4bd4783133771f8) (2026-08-31).
