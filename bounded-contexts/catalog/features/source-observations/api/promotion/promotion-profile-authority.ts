import { isDeepStrictEqual } from "node:util";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogProviderIntegrationProfileVersionReader } from "../source-observation-runtime-contracts";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import { createCatalogProviderIntegrationProfileVersionStore } from "../providers/provider-integration-profile-store";

export function trackPromotionProfileAuthority(
  reader: CatalogProviderIntegrationProfileVersionReader,
  selected: CatalogProviderIntegrationProfileVersionRecord,
  select: (
    reader: CatalogProviderIntegrationProfileVersionReader,
  ) => Promise<CatalogProviderIntegrationProfileVersionRecord>,
): Readonly<{
  reader: CatalogProviderIntegrationProfileVersionReader;
  validate: (client: PgQueryable) => Promise<void>;
}> {
  const retained = new Map<string, CatalogProviderIntegrationProfileVersionRecord>();
  const remember = (version: CatalogProviderIntegrationProfileVersionRecord | null) => {
    if (version)
      retained.set(JSON.stringify([version.providerKey, version.profileKey, version.profileVersion]), version);
    return version;
  };
  remember(selected);
  return {
    reader: {
      ...reader,
      listProfileVersions: async (...args) => {
        const versions = await reader.listProfileVersions(...args);
        versions.forEach(remember);
        return versions;
      },
    },
    async validate(client) {
      const canonical = createCatalogProviderIntegrationProfileVersionStore(client);
      if (!isDeepStrictEqual(await select(canonical), selected))
        throw new Error("promotion-target-profile-selection-changed");
      const byProvider = new Map<string, readonly CatalogProviderIntegrationProfileVersionRecord[]>();
      for (const expected of retained.values()) {
        if (!byProvider.has(expected.providerKey))
          byProvider.set(expected.providerKey, await canonical.listProfileVersions(expected.providerKey));
        const matches = byProvider
          .get(expected.providerKey)!
          .filter((row) => row.profileKey === expected.profileKey && row.profileVersion === expected.profileVersion);
        if (matches.length !== 1 || !isDeepStrictEqual(matches[0], expected))
          throw new Error("promotion-target-profile-material-changed");
      }
    },
  };
}
