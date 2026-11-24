# Graded Card Data Model

Graded and raw cards share a catalog item when they are the same printed card. The catalog item owns identity facts such as card name, set, card number, rarity, language, artist, and release year.

Sellable card form is modeled as catalog product resolution:

- `Form = Raw` requires `Condition`.
- `Form = Graded` requires `Grading Company` and `Grade`.
- Sealed products do not use card condition or grading dimensions.

Inventory attaches [Graded Item Details](../../inventory/GLOSSARY.md#graded-item-details), the `gradedCard` snapshot, to graded stock; that glossary entry holds the rule for reading it. Catalog owns the `Grading Company` and `Grade` Options, and the snapshot's `gradingCompany` and `grade` are display copies of the selected Options' labels, written only by Inventory from the selection. Inventory owns the evidence about one graded copy, because certification number and population snapshots belong to a specific copy, not to the printed card:

- `certificationNumber`
- `population.populationAtGrade` when available
- `population.populationHigher` when available
- `population.source` and `population.asOf` when available
- `conditionDescriptors`

Marketplace listings project the inventory graded card details as nullable `graded_card` data. Raw cards and sealed products keep `graded_card = null`, so existing raw-card flows continue to work without duplicated catalog items.

## Workbench Migration Note

Marketplace validates projected graded-card details when a listing is created or later edited through the listing flow. Existing listings are not retroactively invalidated by this validation, but Catalog and Inventory workbenches that create graded-card sellable stock must capture grading company, grade, and certification number before enabling Marketplace listing creation. Unsupported or malformed graded-card details should remain in workbench review until corrected instead of being promoted into listing-ready supply.
