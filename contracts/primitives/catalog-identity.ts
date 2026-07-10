import type { CatalogItemId } from "./typed-ids";

/**
 * A deterministic key derived from a Catalog Item and its normalized selected
 * Options. It identifies a selection for display and lookup; it is not an
 * independently minted Product identity.
 */
export type ProductKey = `${CatalogItemId}::${string}`;
