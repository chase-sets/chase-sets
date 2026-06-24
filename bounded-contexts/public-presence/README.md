# Public Presence Bounded Context

## Purpose

Public Presence owns Chase Sets public product pages, prelaunch policy surfaces, waitlist behavior, and internal waitlist review.

## Owns

- Public product pages
- Prelaunch policy surfaces
- Waitlist capture and waitlist entries
- Internal waitlist review
- Landing page positioning and analytics vocabulary

## Does Not Own

- Authenticated account, checkout, or marketplace transactions
- Catalog product truth (referenced, never owned here)
- Notification delivery

## Ubiquitous Language

Public Presence terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Composition

The marketplace and admin deployables only compose routes from this context. Product copy, waitlist domain behavior, read models, UI, and tests stay here.

## Docs

- [Landing page positioning](docs/landing-page-positioning.md)
- [Landing page analytics](docs/landing-page-analytics.md)
