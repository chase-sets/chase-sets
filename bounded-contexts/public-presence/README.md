# Public Presence Bounded Context

## Purpose

Public Presence owns Chase Sets public product pages, prelaunch policy surfaces, waitlist behavior, and internal waitlist review.

## Owns

- Public product pages
- Prelaunch policy surfaces
- Public help articles and their category taxonomy
- Waitlist capture and waitlist entries
- Internal waitlist review
- Landing page positioning and analytics vocabulary

## Does Not Own

- Authenticated account, checkout, or marketplace transactions
- Catalog product truth (referenced, never owned here)
- Notification delivery

## Ubiquitous Language

Public Presence terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Waitlist Signup

## Incoming Dependencies

- Public articles receive reviewed, field-level public policy values through the `publicPolicySources` host port. The platform API composes resolvers from each owning bounded context; Public Presence never queries another context's policy tables or accepts generic policy documents.
- Internal waitlist review receives an authenticated actor at the deployable composition layer (`AuthenticatedApiEnv`) rather than importing Auth or Identity facts directly.

## Outgoing Integration Events

- None outside Public Presence. `public-presence.waitlist-signup.recorded`, `public-presence.waitlist-signup.updated`, and `public-presence.waitlist-signup.cohort-quality-provided` are consumed only by Public Presence's own waitlist and transactional-email projections today.

## Invariants

1. A Waitlist Signup id is derived deterministically from the normalized email address, so a repeat submission from the same email updates the existing signup instead of creating a duplicate.
2. Early-access email consent is implied by joining the waitlist and is recorded automatically at signup time; it is never a required condition of joining. Consent to additional product updates beyond early-access notifications is a separate, optional opt-in.
3. A Waitlist Signup must declare at least one interest.

## Tests

Run `pnpm --filter @chase-sets/public-presence run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/public-presence run test` before opening a PR.

## Composition

The marketplace and admin deployables only compose routes from this context. Product copy, waitlist domain behavior, read models, UI, and tests stay here.

## Docs

- [Landing page positioning](docs/landing-page-positioning.md)
- [Landing page analytics](docs/landing-page-analytics.md)
- [Help article contract](docs/help-article-contract.md)
