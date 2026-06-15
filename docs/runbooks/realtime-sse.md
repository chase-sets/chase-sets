# Realtime SSE Runbook

## Ownership

Realtime SSE is a platform transport over bounded-context owned projection outboxes.
Contexts publish client-facing projection patches after read model updates. Deployables
only compose context stores into `/api/realtime/events`. The [Post-Write
Consistency Policy](../architecture/post-write-consistency.md) classifies
realtime as a bounded correction channel: it can reconcile already loaded views
and multi-tab updates, but critical immediate-feedback writes need `fresh-read`,
`snapshot-return`, or a documented reload/refetch fallback.

## Push-Driven Migration Note

Milestone #19 is governed by [ADR 0010: Push-Driven Projection Runtime](../adr/0010-push-driven-projection-runtime.md) and the [Push-Driven Projection Runtime Phase Map](../architecture/push-driven-projection-runtime-phase-map.md). Realtime wake signals must either migrate through the platform work-signal composite or remain as documented, connection-budgeted exceptions. Context-owned realtime outbox rows remain the source of truth, and clients must continue to replay from durable cursors after reconnects.

## Message Contract

Publish `projection.patch` messages only. Do not stream raw domain events.

- `topics` are route-derived client topics such as `public:market`, `item:{id}`,
  `listing:{id}`, `public-account:{id}`, `account:{id}:listings`, and
  `account:{id}:offers`.
- `changes` use `upsert`, `remove`, or `summary`.
- `projection` must match the emitting outbox projection name.
- Patch compatibility is versioned by projection contract. Prefer additive payload
  changes within a projection; when a breaking client contract is required, publish
  through a new projection name and update route consumers deliberately.
- Outbox rows are retained for 24 hours by default.

## Runtime Behavior

The SSE route accepts a browser `Last-Event-ID` cursor and replays retained patches
per context-owned outbox. Cursor ids are opaque base64url vectors keyed by context.
Summary-only replay noise is compacted within each replay batch so older summaries
for the same `{entity, id}` are superseded by the newest summary in that batch.

During deployment drain, new SSE streams are rejected with
`503 process_draining`. Existing streams may close after the configured stream
drain grace period. This is expected: clients reconnect with their cursor and
either replay retained patches or receive `sync.required`.

If a cursor is older than retained patches, the server sends `sync.required` with
`reason: "cursor-expired"`. If a subscriber is too far behind and repeatedly fills
replay batches, the server sends `sync.required` with `reason: "replay-backpressure"`
and advances the cursor to the context head. In either case, clients refetch the
current route data and continue live patching.

Routes must also refetch or reload when a patch cannot be applied safely, the
stream fails repeatedly, a stream is rejected by resource limits, or the route
needs authoritative state after a critical write. SSE wake-ups and `pg_notify`
notifications are latency hints; durable outbox replay and projection/API reads
remain the correctness floor.

## Postgres Wake-Up

`recordRealtimeProjectionPatch` emits a versioned work-signal envelope
(`realtime.outbox-wake`, payload `{ context, projection, topics }`) on
`realtime_projection_patch` after the durable outbox write, through the
[platform work-signal composite](../architecture/work-signal-composite.md). A
deployment can pass a realtime context pool to `createRealtimeOutboxWakeSignal`
and hand the result to `createRealtimeRoutes` as `wakeSignal` to wake idle SSE
loops without waiting for the next polling interval. The listener connects
lazily, falls back to the bounded poll timeout when `LISTEN` is unavailable, and
circuit-breaks reconnect attempts. Platform API wires one wake signal per unique
realtime context pool and merges them into a single route wake signal; the
waiter also accepts pre-composite raw `{ topics }` payloads during rolling
deploys.

## Operational Checks

- Watch active stream counts and rejected stream counts from `RealtimeObserver`.
- Watch `sync.required` rates by reason; repeated backpressure means the route is
  under-provisioned or clients are reconnecting from stale cursors.
- Watch per-topic lag histograms; hot topic families with sustained lag need
  smaller route topic sets, more API capacity, or narrower projections.
- Use `/internal/realtime/status` from trusted internal networks to inspect active
  streams, configured topic families, route tuning, retention, wake-signal status,
  and per-context outbox heads during incidents.
- During frequent deployments, watch `process_draining`,
  `too_many_realtime_streams`, and reconnect rates. A brief 429 window can occur
  after forced process exit while stream limiter TTLs expire; clients should retry
  with backoff.
- Run the retention sweeper in each platform API process; advisory locks make
  duplicate sweepers safe.
- Keep topic manifests and patch factories in the bounded context that owns the
  read model.

## Verification

Use these checks before changing SSE behavior:

```powershell
pnpm run typecheck
pnpm run test:fast
pnpm run check:structure
```

With Postgres available:

```powershell
$env:TEST_DATABASE_URL="postgres://..."
pnpm --filter @chase-sets/platform-runtime run test -- realtime.db.test.ts
```
