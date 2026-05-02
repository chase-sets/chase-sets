# Realtime SSE Runbook

## Ownership

Realtime SSE is a platform transport over bounded-context owned projection outboxes.
Contexts publish client-facing projection patches after read model updates. Deployables
only compose context stores into `/api/realtime/events`.

## Message Contract

Publish `projection.patch` messages only. Do not stream raw domain events.

- `topics` are route-derived client topics such as `public:market`, `item:{id}`,
  `listing:{id}`, `seller:{id}`, `account:{id}:listings`, and
  `account:{id}:offers`.
- `changes` use `upsert`, `remove`, or `summary`.
- `projection` must match the emitting outbox projection name.
- Outbox rows are retained for 24 hours by default.

## Runtime Behavior

The SSE route accepts a browser `Last-Event-ID` cursor and replays retained patches
per context-owned outbox. Cursor ids are opaque base64url vectors keyed by context.

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
- Run the retention sweeper in each platform API process; advisory locks make
  duplicate sweepers safe.
- Keep topic manifests and patch factories in the bounded context that owns the
  read model.

## Verification

Use these checks before changing SSE behavior:

```powershell
npm run typecheck
npm run test:fast
npm run check:structure
```

With Postgres available:

```powershell
$env:TEST_DATABASE_URL="postgres://..."
npm run test --workspace @chase-sets/platform-runtime -- realtime.db.test.ts
```
