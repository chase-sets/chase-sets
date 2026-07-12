/**
 * Unified support-reference lookup: an operator pastes any support-safe
 * display reference (`ORD-`, `SHP-`, `PYO-`, `SUP-`, `CSG-`, `CS-SL-`) or a raw
 * typed ULID (`ord_`, `shp_`, `pyo_`, `sup_`) and lands on the owning entity's
 * admin surface. Routing is a pure function
 * (`@chase-sets/primitives/support-reference`); resolution stays with each
 * owning context's own read model.
 *
 * Ordering, Fulfillment, and Settlement's read pools plus their own
 * support-lookup query functions are cross-context sources, injected as an
 * opaque host port (`supportReferenceLookupCrossContext`; see
 * `../../../support/runtime-support/services.ts`) assembled once in the
 * `platform-api` composition root -- mirroring the platform policy
 * console's `policyConsoleCrossContext` port. Checkout's `CSG-`/`CS-SL-`
 * lookup is wired the same way even though it isn't display-reference
 * derived, so Platform Operations still never imports any of these
 * contexts' domain code directly (`allowedContextDependencies` stays
 * empty).
 */

/** One normalized lookup result, redacted to what's safe to show a support operator (never raw account emails, payment details, etc). */
export type SupportReferenceLookupResult = Readonly<{
  contextName: string;
  entityType: string;
  displayReference: string | null;
  status: string | null;
  summary: string;
  adminHref: string | null;
}>;

/**
 * One cross-context source: a context's own display-reference lookup,
 * already bound to its own read pool. `lookupById` is omitted for sources
 * that never route from a raw typed ULID (Checkout's `CSG-`/`CS-SL-`
 * references have no raw-id form in the router).
 */
export type SupportReferenceLookupSource = Readonly<{
  contextName: string;
  lookupByReference: (reference: string) => Promise<SupportReferenceLookupResult | null>;
  lookupById?: (id: string) => Promise<SupportReferenceLookupResult | null>;
}>;

/** The host port Platform Operations declares and `platform-api` fulfills at composition time. */
export type SupportReferenceLookupCrossContextPort = Readonly<{
  sources: readonly SupportReferenceLookupSource[];
}>;
