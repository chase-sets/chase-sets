# Catalog Scope Registry

The Catalog Scope Registry is the canonical Catalog-owned list of product-line, series, expansion, and set records that can define sync identity. It is a read model over Catalog Reference Records, so a scope record can exist before any provider exposes a matching product line, set id, set name, or category id.

## Scope Record Contract

Catalog Scope Records use these Reference Record type keys:

| Product domain | Product line | Series | Expansion or set |
| --- | --- | --- | --- |
| `pokemon` | `product-line` | `series` | `expansion` |
| `magic` | `product-line` | `series` | `set` |
| `yugioh` | `product-line` | `series` | `set` |
| `one-piece` | `product-line` | `series` | `set` |
| `lorcana` | `product-line` | `series` | `set` |

The canonical product-line Reference Record keys are `pokemon-trading-card-game`, `magic-the-gathering`, `yu-gi-oh-official-card-game`, `one-piece-card-game`, and `disney-lorcana`.

Expansion and set scope records use Reference Record attributes for:

- `release-date`: official first release date for the scope record when known.
- `official-set-code`: product-domain official code, such as `PAF`, `TSP`, `LOB`, `OP-01`, or `1`.
- `language-editions`: language codes for known official editions.

Legacy provider attributes such as `set-code` or `abbreviation` may remain as provider evidence, but the registry contract names `official-set-code` as the canonical scope attribute.

## Read Model

`catalog_scope_records` projects `catalog.reference-record.*` lifecycle events into one row per canonical scope Reference Record. Rows keep:

- product domain and scope kind
- Reference Record id, key, localized name, attributes, and relationships
- parent scope, product-line scope, and series scope ids
- release date, official set code, and language editions
- lifecycle status: `draft`, `active`, `deprecated`, or `archived`

The projection does not rewrite Source Observation sync planning. Provider-specific ids, names, and category mappings remain provider evidence until the Provider Scope Mapping slice maps them onto these canonical Scope Records through review.

## Boundaries

Catalog Scope Record is canonical Catalog identity. Provider Scope Mapping is the reviewed provider-to-canonical bridge keyed by `scope_record_id`, `provider_key`, and `unit_key`. Scope Coverage is the future read model that will show which providers can cover each canonical Scope Record. Scope Sync is the future workflow that starts from a Scope Record, applies approved provider mappings, and then delegates provider pulls.
