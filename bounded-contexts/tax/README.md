# Tax Bounded Context

Tax owns provider-agnostic sales tax quote contracts, local quote behavior, and state-by-state collection readiness.

Ordering requests tax through an injected quote resolver when creating orders, then stores the resulting tax snapshot with the order. The context is intentionally provider-light for now so production tax providers can be added without coupling Ordering to vendor APIs.

## Owns

- Provider-agnostic tax quote contracts
- Local deterministic tax quote behavior
- Tax quote resolver interfaces used by Ordering
- State-by-state nexus threshold tracking and collection-provider dependency posture
- Tax readiness language for production marketplace promotion

## Does Not Own

- Order creation
- Payment collection
- Tax remittance or filing workflows
- Provider adapter selection by deployables

## Ubiquitous Language

Tax terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Invariants

1. Tax quotes are provider-agnostic at bounded-context boundaries.
2. Ordering stores tax snapshots after quote resolution.
3. Production tax providers must stay behind resolver interfaces.
4. Production marketplace launch may use zero-tax snapshots only while Tax readiness evidence confirms no tracked jurisdiction requires collection.
5. Provider-backed tax quotes become required before collecting sales tax in any registered or collecting jurisdiction.

## Operations

Production launch posture and promotion gates live in [Production Tax Readiness](docs/production-tax-readiness.md).
