# Experience Bounded Context

## Purpose

Experience owns platform feedback about how Chase Sets feels to use.

## Owns

- Platform Feedback submission
- Platform feedback prompt dismissal
- Feedback review queue status
- Basic platform feedback reporting read models
- Internal admin review surfaces for platform feedback

## Does Not Own

- Account reviews or reputation summaries
- Support tickets or response SLAs
- Product catalog, listing, offer, checkout, inventory, or payment truth
- Public feedback summaries
- User contact methods

## Ubiquitous Language

Experience terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates

- Platform Feedback
- Platform Feedback Prompt

## Invariants

1. Platform Feedback is internal-only product signal.
2. Platform Feedback is not a public account Review.
3. A user submission is immutable after it is sent.
4. Admin lifecycle state is limited to new, reviewed, and archived.
5. Follow-up consent records permission to use existing contact methods; Experience does not store a new contact method.
