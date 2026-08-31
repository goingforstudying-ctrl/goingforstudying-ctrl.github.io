---
layout: post
title: "PING succeeds, PONG never comes"
---

There's a class of production incident that drives people towards superstition: the Celery worker that's alive, the broker that's reachable, and absolutely nothing happening. No traceback, no error log, messages piling up on a fanout exchange, `inspect ping` going unanswered. Restart the container and everything is fine again, sometimes for days. The reports in celery/celery#10502 all had that shape, and they clustered around managed Redis — ElastiCache, Valkey, anything behind TLS termination or a NAT gateway.

I got pulled into that thread because the mechanism kokhlo described there was one I'd been bitten by before. A Celery worker's pub/sub connection is weird compared to every other connection it holds. The BRPOP connection, the pool connections — they all issue commands constantly, so a dead TCP path surfaces quickly as a read timeout or a broken pipe. The pub/sub connection does the opposite: while idle it issues *no* commands at all. It just sits there waiting for the socket to become readable. If the path dies silently — a failover at the managed broker, a NAT connection-table entry expiring — nothing on that socket ever times out. The connection is half-open: your side thinks it's up, the other side is gone, and since nobody sends anything, nobody notices.

This is the textbook case TCP keepalive exists for, except Linux defaults the first keepalive probe to 7200 seconds. Two hours of catatonic worker.

Kombu already had a partial answer. A while back, #2498 added a `maybe_check_subclient_health` timer that calls redis-py's `PubSub.check_health()` every `health_check_interval` (25 seconds by default). The right idea. So why were workers still freezing? Because of what `check_health()` actually does:

```python
if conn.health_check_interval and time.monotonic() > conn.next_health_check:
    conn.send_command("PING", self.HEALTH_CHECK_MESSAGE, check_health=False)
    self.health_check_response_counter += 1
```

It *sends* the PING. That's it. And here's the nasty part about half-open sockets: a write doesn't fail. The data lands in the kernel send buffer, `send()` returns success, and from kombu's perspective the health check "passed". The dead connection absorbs PING after PING, the counter ticks up, the timer pats itself on the back, and the worker stays catatonic until someone gets paged.

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

Once two full health-check intervals pass without a single PONG, the connection is declared dead and dropped. The beautiful part is that nothing else had to change: kombu's reconnect machinery already knows how to handle a disconnected subclient. `_on_connection_disconnect` prunes the fd from the poller, and the next `on_poll_start` re-registers and resubscribes. With the default 25s interval, detection is bounded at roughly 50 seconds — versus two hours of TCP keepalive defaults or a manual container restart.

Two design points I went back and forth on.

Threshold of 2, not 1. One outstanding PING doesn't necessarily mean a dead path — it can just mean the event loop was stalled for an interval (a long callback, a GC pause) and the PONG is sitting in a buffer nobody's read yet. Killing the connection on a single miss would turn routine event-loop hiccups into reconnect storms. Two consecutive misses means the path is dead, full stop. The integration tests reflect this split: a healthy subclient survives the health check and keeps receiving fanout messages, while a subclient parked at the threshold gets dropped, resubscribes on the next poll, and receives the very next published message.

Resetting the counter to zero on the way out is load-bearing. redis-py's `clean_health_check_responses()` only drains responses that actually arrive, and the counter lives on the `PubSub` object, not the connection — it survives the reconnect. Leave it at 2 and the freshly resubscribed connection would trip the threshold on the very next timer fire, forever. That would be a reconnect loop dressed up as a fix.

I also kept the escape hatch wide: the counter is read with `getattr(..., None)`, so an older redis-py that predates `health_check_response_counter` just falls through to the old send-a-PING behavior. No hard dependency bump.

Who hits this? Anyone running Celery with Redis as the broker, fanout (broadcast) workloads, on infrastructure where TCP paths can die without an RST — which is to say, basically every managed Redis offering and every NAT'd network. The failure mode is maximally unfair: the worker looks healthy in every superficial check, so it usually gets found by a queue-depth alarm or an angry user, not by monitoring on the worker itself. If your workers mysteriously stop answering broadcasts until restarted, this is almost certainly your bug, and it's now fixed on kombu main.
