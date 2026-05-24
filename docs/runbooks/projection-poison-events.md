# Projection Poison Events

Use this runbook when a worker or projection group reports `degraded`.

`degraded` means the projection is still draining unrelated streams, but at least one stream is blocked by a poison event. `error` means the runner could not make progress for the turn.

## Triage

1. Identify the runner or projection group with `state = degraded`.
2. Check the blocked stream count and poison event count.
3. Inspect the latest poison event details: projection key, event type, stream id, stream version, global position, and error message.
4. Decide whether the failure is a handler bug, malformed historical data, missing reference data, or a projection definition change.

Do not ask publishers to re-run the command as the first response. Publishers already wrote durable events; the projection consumer owns catch-up and repair.

## Repair Choices

- Fix a handler bug, then retry the blocked stream.
- Fix missing reference data, then retry the blocked stream.
- Mark a poison event ignored only when the owning context documents why the event is irrelevant or safely lossy for that projection.
- Rebuild the projection group when the projection definition changed or when many blocked streams indicate replay is safer than individual repair.

Retry must preserve stream order. Apply the first blocked event before later deferred events from the same stream.

## Expected Behavior

- Unrelated streams continue to project while one stream is blocked.
- Later events from the blocked stream remain unapplied for that projection.
- Metrics must not use stream id, event id, account id, item id, or observation id as labels.
- Structured logs may include stream id and event id for targeted repair.

## Escalation

Escalate as a projection correctness incident when:

- a `global-strict` projection is in `error`
- blocked stream count grows quickly
- the same event type poisons many streams
- degraded projection lag affects operator workflows or customer-facing reads
- repair fails after the handler or data fix is deployed
