/**
 * The `vi.mock("@chase-sets/public-docs", ...)` factory used by suites that need
 * a consent-activatable document.
 *
 * Production deliberately has no seam for this: `assessConsentRecordingPublication`
 * reads the compiled corpus and the decider passes it no override, so there is no
 * options bag a caller could widen -- which is the point of keeping declared
 * members and derived requirements apart. A test that needs an activatable
 * document therefore replaces the compiled MODULE, exactly as a build carrying a
 * published artifact would, and then drives the unmodified production entry
 * point.
 *
 * This module deliberately imports NOTHING. A `vi.mock` factory is hoisted above
 * every import in its file, so it can only reach helpers through a dynamic
 * import -- and any helper that itself imported `@chase-sets/public-docs`
 * (directly or through the bundle module) would re-enter the module currently
 * being mocked.
 */

export type PublicDocsModule = Readonly<Record<string, unknown>> & {
  publicPolicyPublicationRecords: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

/**
 * Flips exactly the named keys to a published, consent-activatable record and
 * leaves every other export -- and every other document -- untouched.
 */
export async function publicDocsWithConsentActivatable(
  importOriginal: () => Promise<unknown>,
  policyKeys: readonly string[],
  /** Per-key published version overrides, for suites that need a non-default version. */
  versions: Readonly<Record<string, string>> = {},
): Promise<PublicDocsModule> {
  const actual = (await importOriginal()) as PublicDocsModule;
  const records: Record<string, Readonly<Record<string, unknown>>> = { ...actual.publicPolicyPublicationRecords };
  for (const policyKey of policyKeys) {
    const record = records[policyKey];
    if (!record) {
      throw new Error(`No compiled publication record exists for '${policyKey}'.`);
    }
    records[policyKey] = {
      ...record,
      publicationStatus: "published",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      counselApprovalReference: "counsel-approval-test-support",
      rolloutJurisdictionsOrProductLimits: ["US"],
      consentActivatable: true,
      ...(versions[policyKey] === undefined ? {} : { version: versions[policyKey] }),
    };
  }
  return { ...actual, publicPolicyPublicationRecords: records };
}
