# Saved List Sharing Threat Model

## Security boundary

Collections owns visibility, sharing disclosure, unlisted capability lifecycle, access decisions, and the shared-page projection. Catalog Product identity is safe shared input. Pricing may later supply a current estimate only when the independent value disclosure allows it. Inventory, account internals, moderation storage, and presentation remain outside this boundary.

The shared-page query is the only data source for non-owner views. It selects an explicit allowlist matching the committed Saved List viewer contract. Owner reads use the owner snapshot only after owner authorization and are a distinct result variant.

## Protected data

The following never enters a non-owner response, HTML metadata contract, or analytics/audit fact:

- private notes and private tags;
- Owned Card or Inventory quantities;
- acquisition cost, location, SKU, Inventory identifiers, holds, or availability;
- profit and loss, value history, or edit history;
- owner/internal account fields; and
- raw unlisted secrets or their durable verifiers.

Tracked Quantity and Current Estimated Value are independent, default-hidden disclosures. Hiding value must not be bypassed by exposing quantity-derived totals, coverage metadata, structured data, or alternate endpoints.

## Threats and controls

| Threat | Control |
| --- | --- |
| List-ID enumeration | Missing, private, archived, invalid-secret, and revoked-secret reads return the same not-found result. Shared-view and capability-exchange limits apply before useful state is returned. |
| Capability guessing | Secrets contain a 256-bit HMAC output under deployment-managed key material. Only SHA-256 verifiers are persisted and comparisons are timing-safe. |
| Secret disclosure through URLs | The copyable URL places the secret after `#`; fragments are not sent in HTTP requests. Presentation exchanges the fragment in a request body, strips it from browser history, and never attaches it to analytics. |
| Secret disclosure through logs or audit | Domain events, projection rows, audit facts, error contracts, and abuse-report payloads omit the raw secret. Request logging must redact bodies and cookies on the exchange route. |
| Referrer leakage | Unlisted and owner responses require `Referrer-Policy: no-referrer`; the fragment is removed before following links. |
| Stale link after rotation or revocation | Every rotation/revocation advances the generation and atomically replaces or clears the verifier in the access-policy projection. Authorization uses only the current verifier. |
| Stale visibility or archive state | The projection consumes canonical Saved List visibility/archive facts. Access always checks active lifecycle and current visibility. Unknown or lagging policy fails closed. |
| Cross-viewer SSR/cache bleed | All owner, public, and unlisted responses specify `private, no-store` and vary on Cookie and Authorization. Presentation must not place an authorized payload in a shared route cache. |
| Search indexing of unlisted content | Unlisted and owner responses specify `noindex,nofollow,noarchive`; unlisted routes stay out of sitemaps and canonical public metadata. |
| Scraping | Horizontally scalable rate-limit ports cover shared reads and use stricter limits for capability exchange. Public indexing does not imply unlimited API extraction. |
| Metadata inference | Structured metadata must be built from the returned viewer snapshot only. Hidden quantity/value, owner IDs, verifier generation, and projection versions are not metadata inputs. |
| Report-system bypass | The slice exposes an adapter into the existing moderation workflow. Reports have their own rate limit and never create a parallel moderation store. |
| Partial write failure | Canonical visibility remains in the Saved List aggregate. Missing sharing policy or capability denies access; both disclosures default hidden. Retrying a rotation command deterministically reissues the same secret without storing it. |

## Key operations

Capability keys are deployment secrets with at least 32 bytes of material. A keyring keeps old key IDs available long enough for deterministic command retries; changing the active key affects new rotations only. Removing an old key does not make an existing capability unverifiable because reads compare its persisted verifier, but it prevents reissuing the raw secret for a retried old rotation command.

Rate-limit storage must be shared before more than one API instance serves the route. Audit facts contain list ID, bounded access mode/outcome, optional authenticated viewer account, and timestamp; they contain no secret, verifier, title, Product, or free-form content.

## Verification obligations

Tests cover the complete owner/signed-in/anonymous/copy-capable matrix, quantity redaction, forbidden-field absence, replay, stale expected versions, secret retry, rotation/revocation, normalized failures, archive behavior, no-store/noindex posture, fragment transport, and projection omission of private event fields. Presentation tests must additionally inspect rendered HTML, structured metadata, sitemap entries, browser history, request logging, and analytics payloads.
