# Collections Domain Glossary

## Saved List

A **Saved List** is an account-owned, ordered set of exact Catalog Products kept for curation, tracking, sharing, copying, or launching later workflows.

Notes:

- A Saved List is private when created.
- A Saved List expresses intent; it is not an owned-stock record.
- “List” is acceptable inside the My Collection Lists section when context is clear. “Collection” does not mean a Saved List.

## Saved List Line

A **Saved List Line** is one stable row for one exact Catalog Product selection in a Saved List.

Notes:

- It retains the Catalog Item, deterministic Product key, and normalized selected Options.
- Adding the same Product selection again increases the existing line's Tracked Quantity; it never creates a duplicate line.
- Its stable line identity survives quantity, private metadata, and ordering changes.

## Tracked Quantity

**Tracked Quantity** is the positive whole-number amount an account intends to associate with a Saved List Line.

Notes:

- It does not claim that the account owns that quantity.
- Inventory alone owns Total Quantity, Available Quantity, holds, and stock location.

## Saved List Visibility

**Saved List Visibility** is the Saved List state that determines which sharing posture may be applied: `private`, `unlisted`, or `public`.

Notes:

- Private is the creation default.
- Visibility does not itself grant access. Unlisted capabilities, revocation, disclosure policy, and public-safe projections are separate sharing behavior.

## Saved List Cover

A **Saved List Cover** selects one current Saved List Line as the source for cover presentation.

Notes:

- Collections stores only the line reference. Catalog remains the owner of image and display metadata.
- Removing the selected line clears the cover.

## Saved List Inventory Source Snapshot

A **Saved List Inventory Source Snapshot** is the immutable list version and selected-line evidence sent to Inventory's review-first import.

Notes:

- It includes deterministic source row IDs, Saved List Line IDs, exact Products and selected Options, and Tracked Quantities.
- It excludes acquisition cost, private notes, private tags, stock state, and workflow state.
- The owner-authorized snapshot starts Inventory work, but its list correlation is navigation and audit metadata rather than authority for later Inventory access.

## Saved List Estimated Market Value

**Saved List Estimated Market Value** is the current sum of eligible Pricing estimates multiplied by each Saved List Line's Tracked Quantity.

Notes:

- It is an estimate of current market value, not owned stock, cost basis, profit and loss, or a historical valuation.
- Missing and stale estimates are excluded rather than treated as zero.
- Low-confidence estimates may contribute to the total but remain explicitly counted.
- A shared view receives valuation only when it also receives Tracked Quantity and Pricing approves the estimate for public disclosure.

## Estimate Coverage

**Estimate Coverage** states how many Saved List Lines and tracked units have a current eligible estimate, alongside missing, stale, and low-confidence counts.

## Saved List Sharing

**Saved List Sharing** governs who may view an active Saved List and independently controls whether the shared view reveals Tracked Quantity and Current Estimated Value.

Notes:

- Both controls default to hidden.
- A disclosed Current Estimated Value is current Pricing-derived context, never acquisition cost, profit and loss, or history.
- Visibility grants a sharing posture; disclosure decides which optional fields that posture may reveal.

## Unlisted Saved List Capability

An **Unlisted Saved List Capability** is a high-entropy, revocable secret that grants read access to one active unlisted Saved List.

Notes:

- Rotation immediately replaces the prior capability; revocation leaves no active capability.
- Only a one-way verifier is durable. The raw secret is returned to the owner and transported in a URL fragment for a body-based exchange.
- Possession permits viewing, not editing, collaboration, or ownership transfer.
