# Scanning

The Scanning bounded context owns the event-sourced scan-session lifecycle and a replayable read model. It stores only bounded opaque `assetRef` metadata and synthetic capture metadata. Image storage, provider adapters, paid dispatch, privacy policy, and Catalog writes belong to their owning contexts.

## Purpose

Scanning records account-owned card captures through identification and seller confirmation for listing intake.

## Owns

- Scan Session aggregate and lifecycle events
- Opaque Card Scan capture references
- Identification Candidates and Confirmed Match outcomes
- The `scanning_scan_sessions` and `scanning_scan_records` read model

## Does Not Own

- Image bytes, storage, URLs, EXIF, GPS, or provider credentials
- Card or Product identity truth (Catalog)
- Provider adapters or paid identification dispatch
- Listing creation, inventory, or seller policy

## Ubiquitous Language

Scanning terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Scan Session

## Incoming Dependencies

- None. The session accepts account and listing-intake metadata and emits bounded Product descriptors without importing another bounded-context package.

## Outgoing Integration Events

- `scanning.scan-session.started`
- `scanning.scan-session.scan-captured`
- `scanning.scan-session.scan-identified`
- `scanning.scan-session.scan-unidentified`
- `scanning.scan-session.match-confirmed`
- `scanning.scan-session.match-corrected`
- `scanning.scan-session.scan-discarded`
- `scanning.scan-session.completed`

## Invariants

1. A session starts once and cannot accept commands after completion.
2. Each capture uses a bounded opaque `assetRef`; image bytes and provider credentials never enter the aggregate.
3. Candidate lists are bounded to 20 entries, and Confirmed Matches require a complete Product descriptor.
4. Every scan has a terminal outcome before the session completes; completion counts must match aggregate state.

## Tests

Run `pnpm --filter @chase-sets/scanning run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/scanning run test` before opening a PR.
