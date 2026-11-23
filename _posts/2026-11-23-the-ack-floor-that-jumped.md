---
layout: post
title: "The purge deleted two messages and lost a third"
permalink: /notes/the-ack-floor-that-jumped/
categories: [distributed-systems, messaging]
excerpt: "JetStream terminated the delivery of two purged messages, exactly as designed. The same code then walked the ack floor over an unacknowledged message sitting below them."
---

Message 2 was never acked. NATS JetStream lost it anyway.

The setup in [issue #8648](https://github.com/nats-io/nats-server/issues/8648) is short enough to hold in your head: a durable pull consumer with `AckPolicy: All`, four messages fetched and left unacknowledged. An operator purges two of them by subject. The consumer NAKs the batch and fetches again. What should come back is the two survivors. What comes back is one of them. Somewhere between the purge and the redelivery, the ack floor jumped over a message nobody had acknowledged, and from the consumer's point of view that message was done. The reporter attached a single-file .NET program that walks the steps and prints REPRODUCED at the end, on both v2.12.8 and v2.15.0.

## Two operations, one code path

Under `AckPolicy: All`, acking a message acknowledges every message below it. Batch consumers lean on that: fetch fifty, ack the last one, done. The implementation tracks two floors — `asflr` for the stream sequence, `adflr` for the delivery sequence — plus a `pending` map of everything delivered but not yet acked. A regular AckAll ack moves both floors to the acked sequence and deletes every pending entry at or below it. Correct, when a client asks for exactly that.

Termination is a different animal. When a pending message disappears from the stream — filtered purge, retention limits, max age — the consumer terminates its delivery so it isn't redelivered forever. The bug is where that termination landed: `processTermLocked` fed the terminated sequence into the same `processAckMsgLocked` AckAll branch as a client ack. Terminating message 4 moved both floors to 4 and dropped the pending entries for 2 and 3 as a side effect. Nobody had acknowledged 2. The floor said otherwise.

Two paths fed deleted messages into that funnel. `decStreamPending`, the store's deletion notification, terminated the message directly. And `consumer.purge` on a filtered purge only walked the pending map when the purge moved the stream's first sequence past the consumer's ack floor:

```go
if o.asflr < sseq {
    o.asflr = sseq - 1
    // remove those no longer relevant from pending...
}
```

Purge messages 3 and 4 with the floor at 1 and the guard fails, so the pending entries survive — until a redelivery attempt fails to load them from the store and they fall into the term funnel anyway. And on the runs where the walk did execute, it pushed `adflr` forward across entries that were still pending.

## Scoping the removal to the message

The fix threads an `explicit` marker through every layer. Server-side removals — `decStreamPending`, the failed-redelivery path in `getNextMsg`, the deleted-entry cleanup in `consumer.purge` — mark their termination explicit. Under AckAll (and AckFlowControl, which behaves like it) an explicit ack is scoped to its own sequence:

```go
case AckAll, AckFlowControl:
    if explicit {
        // Server-side removal of a deleted message: only this sequence,
        // never the ones below it.
        if p, ok := o.pending[sseq]; ok {
            delete(o.pending, sseq)
            dseq = p.Sequence
            o.moveAckFloor(dseq, sseq)
        }
        ...
        break
    }
```

`moveAckFloor` still advances the floors across sequences that are already clear — it just never crosses a live pending entry. The tempting shortcut would be "termination never moves the floor," but then a terminated sequence at the bottom of the range would pin the floor forever and the consumer state would never compact. The scoped version gets both: the survivor keeps its pending entry, and the bookkeeping still tightens where it legitimately can.

The same flag flows into `updateAcks`, onto the `ConsumerStore.UpdateAcks` interface, and through both the file and memory stores, each of which falls through to its per-message path when the flag is set. The purge walk also lost its `o.asflr < sseq` guard, so a filtered purge checks every surviving pending entry against the store regardless of whether the floor moved.

## A flag that has to survive Raft

The clustered case is the part I found most interesting. Consumer state operations replicate through Raft as byte-encoded commands, and `updateAcksOp` was two varints: delivery sequence, stream sequence. Marking an ack explicit means adding a third piece of data to a command that older replicas have to keep decoding. The change appends an optional trailing `1` byte, and the decoder simply doesn't validate trailing data:

```go
if bi < len(buf) && buf[bi] == 1 {
    explicit = true
}
```

A replica running older code decodes the two varints, ignores the byte, and applies the old semantics. During a rolling upgrade the fix quietly degrades to pre-fix behavior on mixed-version groups instead of breaking the command stream. I'd rather live with the old bug for the length of an upgrade than reject every ack from a newer leader.

One behavior deliberately stayed put: a client-sent `+TERM` under AckAll still works like a regular ack and acknowledges everything below it. That's long-standing documented behavior, and `TestJetStreamAckAllClientTermAcksBelow` pins it so the scoped semantics stay reserved for server-side removal.

The regression tests replay the issue's exact scenario against both memory and file stores: floor at 1, pending 2 through 5, purge the shared subject of 3 and 4, then assert 2 and 5 stay pending, the floor doesn't move, and both come back after ackWait. It fails on main and passes with the change. A second test drives a single-message delete through `decStreamPending`; a third removes a message while it sits queued for redelivery — simulating a deletion signal missed during a leader change — and lets the next pull walk into the gap.

## Who this bites

The audience is anyone running AckAll consumers over streams that delete messages: retention limits, max-age expiry, or filtered purges run by operators. That's a common combination precisely because AckAll is the cheap way to manage batch acknowledgment. The window is a message deleted while it's pending, and the loss is silent — the termination advisory fires for the deleted message, not for the neighbor the floor skipped. For a batch job, that's the record that never gets processed and never raises an error.

My [nats-server PR #8659](https://github.com/nats-io/nats-server/pull/8659) merged on November 23, 2026. [Implementation and tests](https://github.com/nats-io/nats-server/pull/8659/files).
