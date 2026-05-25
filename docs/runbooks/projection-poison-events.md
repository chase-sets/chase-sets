# Projection Poison Events

Use this runbook when a worker or projection group reports `degraded`.

`degraded` means the projection is still draining unrelated streams, but at least one stream is blocked by a poison event. `error` means the runner could not make progress for the turn.

## Triage

1. Open Admin > Operations > Projection Operations.
2. Identify the runner or projection group with `state = degraded`.
3. Check the blocked stream count and poison event count.
4. Inspect the latest poison event details: projection key, event type, stream id, stream version, global position, and error message.
5. Decide whether the failure is a handler bug, malformed historical data, missing reference data, or a projection definition change.

Do not ask publishers to re-run the command as the first response. Publishers already wrote durable events; the projection consumer owns catch-up and repair.

## Repair Choices

- Fix a handler bug, then retry the blocked stream from Admin > Operations > Projection Operations.
- Fix missing reference data, then retry the blocked stream from the same operations page.
- Mark a poison event ignored only when the owning context documents why the event is irrelevant or safely lossy for that projection.
- Rebuild the projection group when the projection definition changed or when many blocked streams indicate replay is safer than individual repair.

Retry must preserve stream order. Apply the first blocked event before later deferred events from the same stream.

## Admin Operations

The projection operations API is mounted under `/api/platform/projections` on `admin-support-api` and requires `security.manage`.

- `GET /api/platform/projections` lists refreshed projection group status, runner status, worker heartbeats, blocked streams, and poison summaries.
- `GET /api/platform/projections/:projectionKey/blocked-streams` lists active blocked stream and poison details for one projection key.
- `POST /api/platform/projections/:projectionKey/blocked-streams/:streamId/retry` replays one blocked stream in stream-version order.
- `POST /api/platform/projections/groups/:contextName/:projectionName/rebuild` rebuilds one projection group and requires `{"confirm":"rebuild"}`.
- `POST /api/platform/projections/groups/:contextName/rebuild` rebuilds all projection groups for one context and requires `{"confirm":"rebuild-all"}`.

Retry and rebuild operations use platform control-plane leases when the control plane is available. If a retry reports that the stream is still blocked because new deferred events arrived during repair, retry the stream again after the current worker turn settles.

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
