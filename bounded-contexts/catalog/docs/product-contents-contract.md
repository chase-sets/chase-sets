# Product Contents Contract

## Purpose

Product Contents is the Catalog-owned relationship that describes what one configured Product contains.

It exists for sealed products, bundles, kits, decks, boxes, packages, and any future container-like catalog item without encoding product-line language in Catalog core. Catalog owns the canonical relationship. Discovery, Marketplace, Inventory, Checkout, and Ordering consume published Catalog facts and never infer contents from provider text, categories, tags, or product-line-specific rules.

## Ubiquitous Language

`Product Contents` is the canonical term for the resolved relationship.

`Product Content Line` is one contained item or product selection within a container product.

`Product Content Type` is Catalog configuration for the natural-language meaning of a line, such as the provider- or product-line-specific label, localized display copy, sort order, and optional Discovery search weight. Catalog core treats this as configuration, not an enum.

`Product Content Inclusion Policy` is Catalog configuration for whether a line is guaranteed, possible, random, choice-based, per-pack, per-box, or otherwise policy-dependent. Catalog core stores the policy reference and quantity semantics; configured policy copy explains the user-facing meaning.

## Ownership

Catalog owns:

- Product Contents authoring commands and review state.
- Product Content Type and Product Content Inclusion Policy configuration.
- Validation that container and contained selections reference existing Catalog Items and valid selected Options.
- The stable published Product Contents fact.
- Reverse lookup read models derived from the same Catalog-owned relationship.

Catalog does not own:

- Discovery ranking, filtering, or detail-page layout.
- Inventory quantities for contained products.
- Marketplace listing availability or bundle sale strategy.
- Checkout, Ordering, Fulfillment, or payment behavior for selling a container product.

## Canonical Shape

Authoring commands reference Catalog Item identity plus selected Options. They do not accept raw `product_id` as the source of truth because Product identity is derived from the Catalog Item, Blueprint dimension order, and normalized selected Options.

```ts
type ProductContentLine = {
  containerCatalogItemId: CatalogItemId;
  containerSelectedOptions?: readonly SelectedOptionEntry[];
  containedCatalogItemId?: CatalogItemId;
  containedSelectedOptions?: readonly SelectedOptionEntry[];
  quantity: number | null;
  contentTypeId: ProductContentTypeId;
  inclusionPolicyId?: ProductContentInclusionPolicyId;
  provenance: ContentProvenance;
};
```

`containerSelectedOptions` is omitted when the contents apply to every Product under the container Catalog Item. It is present when contents differ by selected Options, such as language, edition, packaging form, or another configured Product dimension.

`containedCatalogItemId` is optional while provider evidence is unresolved. Once Catalog can identify the contained Catalog Item, the line should point to it explicitly. `containedSelectedOptions` is present when the relationship targets one resolved Product selection rather than the whole contained Catalog Item.

`quantity` is nullable when the count is unknown, variable, random, or described only by an inclusion policy. A known exact count uses a positive integer.

`contentTypeId` and `inclusionPolicyId` point to Catalog configuration. Product-line terms such as promo card, booster pack, deck, accessory, insert, foil, parallel, or serialized item belong in configuration and localized copy, not in Catalog domain enums.

## Published Fact

Catalog publishes `catalog.product-contents.resolved` as the downstream contract.

The fact is derived from accepted Product Contents lines and includes:

- `container_catalog_item_id`
- `container_selected_options`
- derived `container_product_id` when the selected Options resolve to one Product
- stable ordered content lines
- for each line: contained Catalog Item identity when resolved, contained selected Options when applicable, derived contained Product ID when resolvable, quantity, content type id with configured display name, inclusion policy id with configured display name when present, provenance summary, and resolution status
- a fact hash or version that changes only when the resolved downstream view changes

Discovery consumes this fact for item detail, reverse lookup, and optional search weighting. Discovery must not consume Product Contents command streams, provider evidence, unresolved review state, or Product Content Type internals beyond the published resolved shape.

## Command Rules

Commands must:

1. Identify container and contained Products by `catalog_item_id` plus normalized `selected_options`.
2. Derive `product_id` in command validation, projections, or read models where a resolved Product ID is needed.
3. Accept unresolved provider evidence only as Catalog review/provenance state, not as downstream truth.
4. Keep Product Content Type and Inclusion Policy references configurable and product-line agnostic.
5. Reject self-containment and cycles that would make downstream traversal ambiguous.

## Edge Cases

Unresolved provider evidence remains Catalog review state until the contained Catalog Item is identified or intentionally published as unresolved evidence. Downstream contexts receive a resolution status and display only support-safe provenance.

Variable or random contents use `quantity: null` or a configured Inclusion Policy. The policy describes the semantics; Catalog core does not hardcode random-pack, choice, or rarity-specific rules.

Nested sealed products are allowed only when the resolved graph stays acyclic. Read models should preserve direct lines and may compute bounded traversal views for detail pages.

Archived or removed targets do not silently disappear. The resolved fact carries target lifecycle status so Discovery can hide, label, or de-rank according to its presentation policy while preserving auditability.

Reverse lookup is a Catalog-derived read model over accepted Product Contents. Discovery may project it for "included in" or "appears in" surfaces, but the relationship remains Catalog-owned.

Cycles are invalid for accepted contents. Draft or imported evidence that would create a cycle must stay blocked for review until corrected.

## Why Not Other Homes

Fields describe attributes on one Catalog Item. Product Contents is a relationship between container and contained Catalog selections and needs reverse lookup, lifecycle, provenance, and cycle validation.

Tags and Categories organize browse and merchandising. They cannot express quantity, inclusion policy, selected Options, or provider provenance.

Reference Record relationships describe reusable descriptive facts such as Expansion, Series, Product Line, or Manufacturer. They do not create Product-to-Product contents and should not carry sellable item containment.

External Catalog Item References and External Product References map provider identifiers to Catalog truth. They are lookup keys, not canonical containment relationships.

Discovery-only inference would make search/detail behavior the source of truth, duplicate provider interpretation, and prevent other contexts from consuming the same resolved fact.
