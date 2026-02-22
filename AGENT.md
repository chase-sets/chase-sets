# Agent Guide

## Purpose
Provide operating rules for AI agents working in this documentation-first repository.

## Repository Boundaries
- This repo defines product, architecture, and engineering documentation.
- This repo does not contain production application code.
- Agents must avoid claiming runtime behavior as implemented.

## Docs Organization
- `docs/00-overview/`: boundaries, glossary, and decisions.
- `docs/01-getting-started/`: onboarding and workflows.
- `docs/02-architecture/`: architecture principles and boundaries.
- `docs/03-engineering/`: standards and delivery policy.
- `docs/04-product/`: PRD, requirements, flows, and acceptance.
- `docs/05-operations/`: runbooks and incident stubs.
- `docs/06-reference/`: templates and reference contracts.

## Where To Look First
- Architecture intent: `docs/02-architecture/index.md`
- Standards and quality bar: `docs/03-engineering/standards.md`
- Workflow and doc placement: `docs/01-getting-started/workflows.md`
- Product intent: `docs/04-product/prd.md`

## Writing Conventions For Agents
- Keep docs short, structured, and link-forward.
- Keep one canonical doc per topic.
- Prefer updating canonical docs over creating summaries.
- Use relative links only.
- Use explicit `must`, `should`, and `may` language for norms.

## Decision Recording
Record major architecture or product decisions in `docs/00-overview/decisions.md` using the ADR-lite format defined there.
