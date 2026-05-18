# Realtime SSE Runbook

## Ownership

Realtime SSE is a platform transport over bounded-context owned projection outboxes.
Contexts publish client-facing projection patches after read model updates. Deployables
only compose context stores into `/api/realtime/events`.

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

If a cursor is older than retained patches, the server sends `sync.required` with
`reason: "cursor-expired"`. If a subscriber is too far behind and repeatedly fills
replay batches, the server sends `sync.required` with `reason: "replay-backpressure"`
and advances the cursor to the context head. In either case, clients refetch the
current route data and continue live patching.

## Postgres Wake-Up

`recordRealtimeProjectionPatch` sends `pg_notify` on
`realtime_projection_patch` after the durable outbox write. A deployment can attach
a dedicated Postgres client with `createPostgresRealtimeWakeSignal` and pass it to
`createRealtimeRoutes` as `wakeSignal` to wake idle SSE loops without waiting for
the next polling interval. Platform API wires one listener per unique realtime
context pool and merges them into a single route wake signal.

## Operational Checks

- Watch active stream counts and rejected stream counts from `RealtimeObserver`.
- Watch `sync.required` rates by reason; repeated backpressure means the route is
  under-provisioned or clients are reconnecting from stale cursors.
- Watch per-topic lag histograms; hot topic families with sustained lag need
  smaller route topic sets, more API capacity, or narrower projections.
- Use `/internal/realtime/status` from trusted internal networks to inspect active
  streams, configured topic families, route tuning, retention, wake-signal status,
  and per-context outbox heads during incidents.
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
