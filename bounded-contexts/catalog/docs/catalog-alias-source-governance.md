# Catalog Alias Source Governance

Catalog turns localized provider names into reviewed aliases so marketplace search and identity stay accurate without polluting Catalog truth. This policy decides which external sources may supply an **official English equivalent**, which alias kinds may be auto-accepted versus held for review, how governed sources break ties when they disagree on the official English name, and how generated translations and romanizations are constrained.

This is the policy that #1903, #1906, #1908, #1909, and #1911 reference rather than inventing their own. The acceptance-disposition policy (`auto-accept`, `require-review`, `never-official`) and the source-precedence order are defined here and consumed there. Display of aliases is owned by #1914.

The authoritative executable policy lives in `bounded-contexts/catalog/features/source-observations/api/catalog-integration-data-governance.ts` (alias source governance section). Provider-data storage, redaction, retention, and approval are governed by the sibling [Catalog Integration Data Governance](./catalog-integration-data-governance.md) policy; this doc reuses those governed data classes for alias evidence rather than defining new retention machinery.

The governing policy version is `alias-source-governance-v1`. Every auto-accepted and accepted alias records this version so a later policy change can be reconciled against what was true at acceptance.

## Why This Exists

- TCGdex is useful but incomplete for English equivalents on Japanese and other Asia-region cards.
- The TCGdex `id` language code is **Indonesian**, not English, and is never English evidence.
- Machine translation and romanization can improve search recall but can never be official truth.
- Official English card/set equivalence may require an official English source, a curated operator mapping, or a same-id provider English endpoint, each with its own trust level.

## Approved Alias Source Categories

A category describes *how* a candidate English equivalent was produced, independent of which concrete provider supplied it.

| Category | Can be official English | Acceptance disposition | Produces alias types |
| --- | --- | --- | --- |
| Official English source | Yes | `auto-accept` (after legal/source approval) | `official-equivalent`, `set-equivalent`, `series-equivalent` |
| Curated operator mapping | Yes | `auto-accept` | `official-equivalent`, `set-equivalent`, `series-equivalent` |
| Provider same-id localized endpoint | Yes | `require-review` | `official-equivalent`, `set-equivalent`, `series-equivalent` |
| Provider localized name | No | `require-review` | `provider-localized-name` |
| Species reference | No | `require-review` | `species-name` |
| Machine translation | No | `never-official` | `literal-translation`, `generated-translation` |
| Romanization | No | `never-official` | `romanization` |

## Acceptance Disposition Versus Review State

This is the policy downstream slices consume. A source category carries an **acceptance disposition** (an action), and the disposition resolves to a **review state** (a noun) that downstream review tooling gates on. The disposition is action-style so it never collides with a review-state noun. The mapping is:

- `auto-accept` → review state `auto-accepted`
- `require-review` → review state `pending`
- `never-official` → review state `pending` (evidence-only, never official)

The categories assigned to each disposition:

- **`auto-accept`**: official English source (only when legal/source approval for the named source is on record) and curated operator mapping. The alias is promoted to an official equivalent and its acceptance is recorded with the governing policy version.
- **`require-review`**: provider same-id localized endpoint (strong but cross-language id alignment is not guaranteed), provider localized name, and species reference. An operator must accept before it can become official, and a species reference or provider localized name never becomes an official English equivalent on its own.
- **`never-official`**: machine translation and romanization. They are retained as low-confidence, evidence-marked aliases for search recall only and can never be promoted to or displayed as official equivalents.

Any candidate read from the TCGdex `id` (Indonesian) language code is rejected as English evidence regardless of its category and falls back to the `pending` review state.

## Source Precedence For Conflicting Official Equivalents

When governed official-English sources disagree on the official English name, the winner is decided by this precedence order (strongest first). This is consumed by promotion conflict handling (#1909).

1. Official English source (e.g. Pokemon TCG official/card database)
2. Curated operator mapping
3. Provider same-id localized endpoint (e.g. TCGdex `en`)

Categories that cannot be official (provider localized name, species reference, machine translation, romanization) never participate in the tiebreak. Indonesian `id` evidence is discarded before ranking. If no eligible candidate remains, there is no official English winner and the localized name stays without an official equivalent.

## Generated Translation Policy

Generated translations and romanizations are low-confidence, evidence-marked, reviewable, and never displayed as official equivalents. They may improve search recall only. A translation adapter must never emit an `official-equivalent` alias type; it may only emit `generated-translation`, `literal-translation`, or `romanization`. Display ownership of these aliases is #1914.

## Cards With No Official English Equivalent

Where no governed source provides an official English name, the card keeps its localized name and any pending or evidence-only aliases. Search recall may still benefit from species reference, romanization, or generated translation evidence, but none of it is promoted to an official equivalent.

## Trainer/Energy And Composite Set Equivalence

- Species reference does not apply to Trainer and Energy cards; those rely on an official English source, curated operator mapping, or a same-id provider English endpoint for any official equivalent.
- Set and series equivalence (`set-equivalent`, `series-equivalent`) follows the same source precedence as card names. Split or composite set equivalence (one localized set mapping to multiple English sets, or the reverse) defaults to the `pending` review state until an operator or curated mapping resolves the composite relationship.

## Legal And Licensing Constraints

Storing official English names from a third-party source requires recorded legal/source approval for that named source before it may be used as an official English source or auto-accepted. Translation adapters never grant official status and do not need source approval, but their output may never be displayed as official. Legal/source approval requirements must be documented before wiring in any new official English source.

## Source Retention And Redaction

Alias evidence reuses the governed data classes from [Catalog Integration Data Governance](./catalog-integration-data-governance.md):

- Official-English, curated, same-id, provider-localized, and species evidence is retained as **audit evidence** (retained audit summary), storing a redacted source reference and content hash, never the raw provider body.
- Machine-translation and romanization evidence is retained as **engine diagnostic** (retained redacted summary).
- Provider secrets, account/seller facts, commerce fields, and raw provider bodies are redacted before any alias evidence appears in Admin, logs, metrics, traces, exports, or audit summaries.

## Audit Requirements

Every accepted, auto-accepted, or revoked alias decision records:

1. Alias type and source category.
2. Review state (`pending`, `accepted`, `auto-accepted`, `rejected`, or `revoked`).
3. The governing policy version (`alias-source-governance-v1`).
4. The source-category precedence rank used for any official-English winner.
5. Actor (operator id for accepted and revoked decisions, system for auto-accepted).
6. A redacted source-evidence reference and content hash, never the raw provider body.
7. Whether the alias is marked official or low-confidence evidence-only.
8. The legal/source approval reference when storing an official English name from a third party.

## Future Translation Provider Adapter Requirements

Before a translation provider adapter may produce alias evidence:

1. Generated aliases must be marked low-confidence and evidence-only, never displayed as official equivalents.
2. Adapter output must carry deterministic fixtures proving alias type, source category, and confidence marking.
3. The adapter must never emit an `official-equivalent` alias type.
4. Adapter evidence retention and redaction follow the engine-diagnostic governed data class.
5. The adapter must declare its source category and pass language-code validation that rejects TCGdex `id` (Indonesian) as English.
6. Legal/source approval is required before any new official English source is wired in; translation adapters never grant official status.

## Related Issues

- #1903 owns the alias ADR and locks the alias type and review-state vocabulary this policy uses.
- #1906, #1908, #1909, and #1911 consume the acceptance-disposition policy defined here.
- #1909 owns promotion conflict handling and consumes the source-precedence order.
- #1914 owns alias display and the rule that generated translations never show as official.
- The provider-data governed data classes reused for alias evidence retention and redaction are defined in [Catalog Integration Data Governance](./catalog-integration-data-governance.md).
