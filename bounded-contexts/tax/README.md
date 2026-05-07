# Tax Bounded Context

Tax owns provider-agnostic sales tax quote contracts and local quote behavior.

Ordering requests tax through an injected quote resolver when creating orders, then stores the resulting tax snapshot with the order. The context is intentionally provider-light for now so production tax providers can be added without coupling Ordering to vendor APIs.

## Owns

- Provider-agnostic tax quote contracts
- Local deterministic tax quote behavior
- Tax quote resolver interfaces used by Ordering

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
