# Platform Operations

Platform Operations owns internal operator workflows for cross-context platform runtime health.

## Owns

- Projection operation console journeys
- Platform operation UI language
- Platform operation admin route modules
- Platform operation API clients
- Platform operation workflow tests

## Does Not Own

- Projection handlers, read models, or projection group declarations
- Projection replay, retry, rebuild, lease, or fencing semantics
- Source-context event facts
- Bounded-context business repair policy
- Deployable runtime composition

## Boundary Notes

Platform Operations gives staff a coherent way to inspect and act on platform runtime signals. Shared infrastructure still owns generic projection runtime behavior, while each bounded context owns the projections and read models it declares.

Deployables compose Platform Operations routes. They should not own page behavior, view models, workflow state, or route tests.
