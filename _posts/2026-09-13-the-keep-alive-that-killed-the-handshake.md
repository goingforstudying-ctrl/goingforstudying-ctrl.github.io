---
layout: post
title: "The keep-alive that killed the handshake"
---

The graphql-ws handshake looks simple enough to skip reading the spec: the client sends `connection_init`, the server answers `connection_ack`, and subscriptions flow. But the spec deliberately says nothing about what a client should do with a message that arrives before the ack. Most servers send nothing in between, so nobody notices. Some servers do send something. Hasura, for example, fires a `ka` keep-alive at the client immediately when a WebSocket connection opens, and it has done that since at least 2021.

Netflix's DGS framework — the GraphQL framework a lot of Java and Kotlin Spring services use — answered the spec's silence with a strict reading: the first message out of the socket must be the ack, or the handshake throws. This has been sitting in the client since before anyone filed the issue in late 2022:

```kotlin
client
    .receive()
    .take(1)
    .map { message ->
        if (message.type == GQL_CONNECTION_ACK) {
            message
        } else {
            throw GraphQLException("Acknowledgement expected from server, received $message")
        }
    }.timeout(acknowledgementTimeout)
    .then()
```

One `take(1)`, one type check. The strict reading is defensible — the spec doesn't define pre-ack behavior, so the client picked a policy and enforced it. But the policy makes every pre-ack message an error, and a keep-alive is a perfectly normal pre-ack message. Point the DGS WebSocket client at a Hasura endpoint and the failure is instant and total: every subscription attempt dies before it starts, with `Acknowledgement expected from server, received ka`.

The fix changes the handshake from "the first message must be the ack" to "wait for the ack, skipping everything that isn't one, except connection errors":

```kotlin
.handle<OperationMessage> { message, sink ->
    when (message.type) {
        GQL_CONNECTION_ACK -> sink.next(message)
        GQL_CONNECTION_ERROR ->
            sink.error(GraphQLException("Connection rejected by server, received $message"))
        else ->
            logger.debug(
                "Skipping message received before connection acknowledgement: {}",
                message,
            )
    }
}.next()
.timeout(acknowledgementTimeout)
```

Two decisions there are deliberate, and they're easy to get wrong in either direction.

Skipping keep-alives is the obvious part. Less obvious is that stray `data` messages also get skipped, and that's correct: no subscription has been started before the ack, so a data message arriving this early cannot belong to this client. Treating it as fatal would just recreate the original bug with a different message type.

The subtle case is `connection_error`, and it must not be skipped. A server that rejects `connection_init` — bad auth, subscription not allowed, whatever its error payload says — will never send the ack we're now waiting for. Skipping it would burn the full thirty-second acknowledgement timeout and then fail with a generic timeout, throwing away the error the server actually sent. So `connection_error` fails the handshake immediately instead. That's the one non-ack message that still means the handshake is over, just unsuccessfully.

The timeout still wraps the whole wait, so a server that never answers at all still fails on schedule. The behavior change is only about what the client tolerates in between.

The regression tests cover all three branches against the mock server: a keep-alive before the ack, a stray data message before the ack, and a connection error that must reject rather than skip. The first two cases run a full query to completion afterward, proving the handshake isn't just surviving — it ends in the right state, with the subscription stream working normally.

Who hits this in practice: anyone pointing DGS's WebSocketGraphQLClient at Hasura, or at any graphql-ws-compatible server that emits keep-alives eagerly on connect. It's a per-connection startup failure, so it isn't subtle or intermittent — subscriptions simply never work against those servers, and there's no workaround short of patching the client or proxying the connection. Given how long Hasura has sent `ka` on connect, plenty of DGS users will have hit this, filed it under "DGS doesn't work with Hasura," and moved to a different client.

The fix is in [Netflix/dgs-framework PR 2343](https://github.com/Netflix/dgs-framework/pull/2343). Protocol specs leave edges unspecified on purpose, and the difference between a strict client and an interoperable one is often just deciding what to ignore while you wait.
