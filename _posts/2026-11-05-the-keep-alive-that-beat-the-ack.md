---
layout: post
title: "The keep-alive that beat the ack"
permalink: /notes/the-keep-alive-that-beat-the-ack/
categories: [kotlin, graphql, websockets]
excerpt: "Netflix's DGS WebSocketGraphQLClient failed every subscription against Hasura because it demanded the first frame off the wire be the connection ack. Hasura sends a keep-alive first. The fix is a handshake that waits for the ack instead of assuming it."
---

The exception message was doing that thing where it tells you exactly what happened and still doesn't help: `Acknowledgement expected from server, received OperationMessage(type=ka, payload=null, id=)`. Every subscription through Netflix DGS's `WebSocketGraphQLClient` against a Hasura backend died during the handshake, before a single byte of actual GraphQL went over the wire. Same client against other servers worked. Hasura against other clients worked. The pairing was the problem.

Some quick protocol background. The `subscriptions-transport-ws` protocol that this client speaks starts every connection the same way: the client sends `connection_init`, the server answers `connection_ack`, and only then do subscriptions begin. It's a simple two-frame handshake, and the client implemented it with the most natural reading possible — send init, take the first frame that comes back, and require it to be the ack:

```kotlin
client.receive()
    .take(1)
    .map { message ->
        if (message.type == GQL_CONNECTION_ACK) {
            message
        } else {
            throw GraphQLException("Acknowledgement expected from server, received $message")
        }
    }
    .timeout(acknowledgementTimeout)
```

The catch is that the spec doesn't actually promise the ack will be the first frame. It defines that the server responds to init with ack; it says nothing about the server being forbidden from sending other messages in the meantime. Hasura takes advantage of that silence: it emits a `ka` (keep-alive) frame immediately on connect, a known behavior tracked in hasura/graphql-engine#7002. So against Hasura, the first frame off the wire is the keep-alive, the `take(1)` grabs it, the type check fails, and the client throws before the ack — which was coming one frame later — ever gets read.

## Waiting for the ack instead of assuming it

The fix in [PR #2343](https://github.com/Netflix/dgs-framework/pull/2343) reshapes the handshake from "first frame must be the ack" into "keep reading until the ack shows up":

```kotlin
client.receive()
    .handle<OperationMessage> { message, sink ->
        when (message.type) {
            GQL_CONNECTION_ACK -> sink.next(message)
            GQL_CONNECTION_ERROR ->
                sink.error(GraphQLException("Connection rejected by server, received $message"))
            else ->
                logger.debug("Skipping message received before connection acknowledgement: {}", message)
        }
    }.next()
    .timeout(acknowledgementTimeout)
```

Three cases, each chosen deliberately. The ack completes the handshake, same as before. A `connection_error` fails immediately rather than being skipped — that's the server rejecting the init, and waiting for an ack that will never come would just burn the whole acknowledgement timeout before reporting the real problem. Anything else (keep-alives, and in principle stray data frames) gets logged at debug and skipped.

The `connection_error` branch is worth a second look because it preserves a behavior the old code had by accident. The old `take(1)` threw on anything that wasn't the ack, so a connection error surfaced instantly. A naive "skip everything until ack" rewrite would have quietly regressed that: an auth failure would present as a 30-second handshake timeout instead of a clear rejection. The timeout still exists, of course, and still bounds the wait for servers that connect and then say nothing at all.

Skipping stray data frames is safe for a structural reason: no subscription has been started before the handshake completes, so any data message arriving that early cannot belong to this client. It's not ours to deliver, and dropping it into the debug log is the honest thing to do with it.

## Proving it with a talkative fake server

The tests drive the client against a scripted server that gets to decide the exact frame order. One test sends keep-alive, then ack, then real subscription data, and verifies the subscription completes normally. A second sends a stray data frame before the ack and confirms the client still settles and delivers the real data. The third sends `connection_error` and asserts the handshake fails fast with the rejection in the exception, rather than hanging to the timeout. That third test is the one that would catch the "skip everything" regression I mentioned.

What I like about this bug is how representative it is of protocol code in general. "Reply to init with ack" reads as a sequence, and the first implementation turned that reading directly into `take(1)`. But a protocol specification constrains what each party sends; it rarely constrains what the wire looks like between the messages you care about. Interop lives in that gap. Hasura wasn't violating the spec, and neither was the client, strictly speaking — the spec just had nothing to say about their disagreement, so the disagreement was settled by whichever side was less tolerant. Making the client tolerant was the cheap fix, and the strictness that actually mattered (fail fast on rejection, bound the wait on silence) got to stay.
