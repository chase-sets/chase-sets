# Graded Card Data Model

Graded and raw cards share a catalog item when they are the same printed card. The catalog item owns identity facts such as card name, set, card number, rarity, language, artist, and release year.

Sellable card form is modeled as catalog product resolution:

- `Form = Raw` requires `Condition`.
- `Form = Graded` requires `Grading Company` and `Grade`.
- Sealed products do not use card condition or grading dimensions.

Inventory owns copy-specific slab details because certification number and population snapshots belong to a specific graded copy, not to the printed card:

- `gradingCompany`
- `grade`
- `certificationNumber` when available
- `population.populationAtGrade` when available
- `population.populationHigher` when available
- `population.source` and `population.asOf` when available
- `conditionDescriptors`

Marketplace listings project the inventory graded card details as nullable `graded_card` data. Raw cards and sealed products keep `graded_card = null`, so existing raw-card flows continue to work without duplicated catalog items.
