# Agent Listing Integrations

Inventory exposes the listing migration workflow through the same review-first Import Batch model used by the Marketplace account UI.

## Supported Flow

1. The client or agent calls `GET /api/inventory/import-batches/sources` or MCP `inventory.list-import-sources`.
2. The client chooses a source profile such as `tcgplayer-csv`, `shopify-csv`, `ebay-csv`, `whatnot-csv`, or `cardtrader-csv`.
3. The client submits source rows through `POST /api/inventory/import-batches` or MCP `inventory.create-import-batch`.
4. Inventory validates rows, resolves Catalog-owned external references, infers selected Options from the source profile, and marks rows as accepted or rejected.
5. The client inspects `GET /api/inventory/import-batches/{id}`, MCP `inventory.get-import-batch`, or resource `chase-sets://inventory/{accountId}/import-batches/{batchId}`.
6. After confirmation, the client commits accepted rows through `POST /api/inventory/import-batches/{id}/commit` or MCP `inventory.commit-import-batch`.

Commit creates or adjusts Inventory Items. If accepted rows include listing price and quantity cap, Inventory calls the existing Marketplace draft-listing host port. Marketplace still owns Listing lifecycle and publication.

## Connector Boundary

Small connectors should fetch provider rows only:

- CSV connectors parse files into rows.
- Shopify, eBay, and other API connectors may fetch provider inventory rows later.
- AI agents can produce either CSV text or parsed rows.

Connectors must not decide Catalog semantics. Source profiles define header aliases, value mappings, ordered external reference candidates, target intent, and selected-option inference. Catalog remains the owner of external Catalog Item and Product references.

## Agent Guardrails

MCP write tools require account scope, `inventory.manage`, explicit confirmation, and an idempotency key. Tool handlers also reject account-id mismatches before calling Inventory services.

Agents should treat rejected rows as review evidence, not failure of the entire import. Manual product selection should be the exception path after external references and profile-driven selected-option inference have been exhausted.

## What This Does Not Do Yet

This slice does not store seller Shopify/eBay credentials or schedule provider sync jobs. Identity owns API keys and linked platform authorizations; a future account-managed connector slice should introduce durable connection state there or in an explicit integration-owning context before adding scheduled sync.
