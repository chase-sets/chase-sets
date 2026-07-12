import { parseTypedId } from "./typed-ids";

/**
 * The bounded contexts a support reference or raw typed ULID can route to.
 * Checkout's `CSG-`/`CS-SL-` references are its own read-model format (not
 * derived through `display-reference.ts`), but they share the same
 * "paste one string, land on the owning entity" shape as the `ORD-`/`SHP-`/
 * `PYO-` display references, so routing for all five lives here together.
 */
export type SupportReferenceContextName = "ordering" | "fulfillment" | "settlement" | "checkout";

/** A normalized display-style reference (`ORD-`, `SHP-`, `PYO-`, `CSG-`, `CS-SL-`), ready to hand to the owning context's own lookup. */
export type SupportReferenceRoute = Readonly<{
  kind: "display-reference";
  contextName: SupportReferenceContextName;
  reference: string;
}>;

/** A raw typed ULID (`ord_...`, `shp_...`, `pyo_...`), ready to hand to the owning context's own by-id lookup. */
export type SupportReferenceTypedIdRoute = Readonly<{
  kind: "typed-id";
  contextName: SupportReferenceContextName;
  typedIdPrefix: "ord" | "shp" | "pyo";
  id: string;
}>;

export type ParsedSupportReference = SupportReferenceRoute | SupportReferenceTypedIdRoute;

const TYPED_ID_CONTEXT_BY_PREFIX: Readonly<Record<"ord" | "shp" | "pyo", SupportReferenceContextName>> = {
  ord: "ordering",
  shp: "fulfillment",
  pyo: "settlement",
};

const TYPED_ID_INPUT_PATTERN = /^(ord|shp|pyo)_(.+)$/i;

// Longest/most-specific collapsed (hyphen-free) prefix first so "CS-SL-" and
// "CSG-" aren't shadowed by a broader prefix.
const DISPLAY_REFERENCE_PREFIXES: readonly Readonly<{
  prefix: string;
  contextName: SupportReferenceContextName;
}>[] = [
  { prefix: "CS-SL-", contextName: "checkout" },
  { prefix: "CSG-", contextName: "checkout" },
  { prefix: "ORD-", contextName: "ordering" },
  { prefix: "SHP-", contextName: "fulfillment" },
  { prefix: "PYO-", contextName: "settlement" },
];

/** Trims and uppercases operator input for display-reference matching. Typed ULIDs are handled separately and keep their own casing rules. */
export function normalizeSupportReferenceInput(input: string): string {
  return input.trim();
}

/**
 * Routes a support-safe reference or raw typed ULID to the bounded context
 * that owns its resolution. Tolerant of surrounding whitespace, case, and a
 * missing hyphen after the prefix (e.g. `ord a1b2c3d4` or `csgcardvault`
 * resolve the same as `ORD-A1B2C3D4` / `CSG-CARDVAULT`). Returns `null` when
 * the input matches no known prefix -- callers should treat that as "not
 * found" rather than an error, since operators paste arbitrary text.
 */
export function parseSupportReference(input: string): ParsedSupportReference | null {
  const trimmed = normalizeSupportReferenceInput(input);
  if (!trimmed) {
    return null;
  }

  const typedIdMatch = TYPED_ID_INPUT_PATTERN.exec(trimmed);
  if (typedIdMatch) {
    const typedIdPrefix = typedIdMatch[1]!.toLowerCase() as "ord" | "shp" | "pyo";
    const idSuffix = typedIdMatch[2]!.trim();
    if (!idSuffix) {
      return null;
    }

    const candidate = `${typedIdPrefix}_${idSuffix.toUpperCase()}`;
    try {
      const id = parseTypedId(candidate, typedIdPrefix);
      return { kind: "typed-id", contextName: TYPED_ID_CONTEXT_BY_PREFIX[typedIdPrefix], typedIdPrefix, id };
    } catch {
      return null;
    }
  }

  const collapsed = trimmed.toUpperCase().replace(/-/g, "");
  for (const { prefix, contextName } of DISPLAY_REFERENCE_PREFIXES) {
    const collapsedPrefix = prefix.replace(/-/g, "");
    if (!collapsed.startsWith(collapsedPrefix)) {
      continue;
    }

    const suffix = collapsed.slice(collapsedPrefix.length);
    if (!suffix) {
      return null;
    }

    return { kind: "display-reference", contextName, reference: `${prefix}${suffix}` };
  }

  return null;
}
