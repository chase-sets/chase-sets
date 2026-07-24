# ADR 0027: Representative Catalog Observation Packs

## Status

Accepted. Records the approved rulings in [#5872](https://github.com/chase-sets/chase-sets/issues/5872) for the representative Catalog seed-data epic [#5880](https://github.com/chase-sets/chase-sets/issues/5880).

## Context

Dev and preview need representative Catalog truth without replacing Catalog's real import, review, promotion, and Product Asset Set pipeline with hand-authored fixtures. The existing scenario seed remains deterministic for functional tests, but it cannot provide real provider titles, numbering, rarities, and images.

Live provider calls during seed would make local and preview setup network-dependent, rate-limited, and non-replayable. Retaining provider samples also needs an explicit governance, licensing, and review boundary before a replay can promote and publish Catalog truth.

## Decision

Chase Sets captures selected provider data once into governed, versioned **Observation Packs**, then replays an accepted pack through the real Catalog import, promotion, and Product Asset Set path.

- Retain redacted sampled provider transport envelopes (with pricing fields stripped by recording sanitization) and source image bytes in a private, versioned `cs-dev-seed-packs` Space. They are non-production only, available through bucket-scoped dev and CI credentials, and owned by Todd. A pack remains retained while `accepted`; after `revoked` or `superseded`, delete it within 30 days. Supersession is the rotation mechanism.
- Capture one English set per currently reference-seeded product line: Pokemon TCG Prismatic Evolutions through TCGdex; Magic: The Gathering Time Spiral through Scryfall; One Piece Romance Dawn OP-01 through Scrydex One Piece; and Disney Lorcana The First Chapter through Lorcanajson. Capture resolves and pins the active Provider Integration Profile key, version, and ingestion unit in the manifest.
- A pack lifecycle is `captured -> accepted -> superseded | revoked -> deleted`. Acceptance records the operator, time, and #5872 link after review of per-set observation and image counts, redaction-scan results, and sample renders. Acceptance is the durable review authorization for replaying that immutable pack to auto-promote and publish.
- `representative-catalog` is an opt-in environment data profile. It is permitted only when explicitly requested in dev, local, remote-dev, test, or preview. It is rejected in staging and production and is never part of any environment's default profile list.
- Staging keeps the real provider pipeline. The profile does not introduce a staging fallback or an implicit deployment side effect.

## Alternatives Considered

- Replay-time live provider fetches were rejected because they make seeds network-dependent and rate-limited.
- Reusing a public-CDN-fronted Catalog assets bucket was rejected because governed provider samples require separate private storage.
- Re-reviewing each replay into drafts was rejected because the accepted immutable pack is the durable review boundary; repeating review adds latency without improving the content decision.

## Consequences

Later slices may implement pack capture, replay, promotion, asset ingestion, and snapshot acceleration behind this profile. This ADR creates no pack format, provider call, seed implementation, default-profile enrollment, or staging representative-data behavior by itself.

The accepted implementation and developer workflow are documented in [Local Representative Data](../local-representative-data.md), with governed storage and snapshot operations in [Seed Pack Storage](../runbooks/seed-pack-storage.md).
