import { parseSupportReference } from "@chase-sets/primitives/support-reference";
import type { SupportReferenceLookupResult, SupportReferenceLookupSource } from "./contracts";

export type SupportReferenceLookupServices = ReturnType<typeof createSupportReferenceLookupRuntime>;

export function createSupportReferenceLookupRuntime({
  sources,
}: Readonly<{ sources: readonly SupportReferenceLookupSource[] }>) {
  return {
    resolveSupportReference: (rawInput: string) => resolveSupportReference(sources, rawInput),
  };
}

/**
 * Routes `rawInput` to the bounded context that owns it (via the shared
 * `parseSupportReference` primitive) and delegates resolution to that
 * context's own already-composed lookup. Returns `null` when the input
 * matches no known prefix, no source is configured for that context (its
 * pool wasn't available at composition time), or the owning context has no
 * record for it -- all three are "not found" from an operator's
 * perspective, not an error.
 */
export async function resolveSupportReference(
  sources: readonly SupportReferenceLookupSource[],
  rawInput: string,
): Promise<SupportReferenceLookupResult | null> {
  const route = parseSupportReference(rawInput);
  if (!route) {
    return null;
  }

  const source = sources.find((candidate) => candidate.contextName === route.contextName);
  if (!source) {
    return null;
  }

  if (route.kind === "display-reference") {
    return source.lookupByReference(route.reference);
  }

  if (!source.lookupById) {
    return null;
  }

  return source.lookupById(route.id);
}
