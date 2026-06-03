import { describe, expect, it } from "vitest";
import {
  createCatalogProviderIntegrationProfileVersionStore,
  seedCatalogProviderIntegrationProfileVersions,
} from "./provider-integration-profile-store";
import {
  catalogProviderIntegrationProfileVersions,
  tcgdexPokemonTcgProviderProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";

type QueryResult<T> = Promise<{ rows: T[] }>;

describe("catalog provider integration profile version store", () => {
  it("seeds current provider profiles through the persisted data path", async () => {
    const db = new InMemoryProfileVersionDb();

    await seedCatalogProviderIntegrationProfileVersions(db);

    expect(
      db.statements.some((statement) =>
        statement.includes("INSERT INTO catalog_provider_integration_profile_versions"),
      ),
    ).toBe(true);
    expect(
      await createCatalogProviderIntegrationProfileVersionStore(db).getActiveProfileVersion("TCGDEX"),
    ).toMatchObject({
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.03",
      active: true,
      compatibilityMode: "executable-mapping-contract",
      sourceContract: {
        fixtureSetVersion: "tcgdex-pokemon-executable-v1",
      },
      executableMappingContract: expect.objectContaining({
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
      }),
    });
  });

  it("deprecates an existing active provider version before seeding a new active version", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    await store.seedProfileVersions([legacyActiveTcgdexVersion()]);

    await seedCatalogProviderIntegrationProfileVersions(db);

    expect(
      (await store.listProfileVersions("tcgdex")).map((version) => [
        version.profileVersion,
        version.lifecycle,
        version.active,
      ]),
    ).toEqual([
      ["2026.06.03", "active", true],
      ["2026.06.02", "deprecated", false],
    ]);
  });

  it("activates a persisted version and deprecates the previous active version", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    await store.seedProfileVersions([currentTcgdexVersion(), tcgdexVersion("2026.06.04", "test", false)]);

    await store.activateProfileVersion("tcgdex", "2026.06.04");

    expect(
      (await store.listProfileVersions("tcgdex")).map((version) => [version.profileVersion, version.lifecycle]),
    ).toEqual([
      ["2026.06.04", "active"],
      ["2026.06.03", "deprecated"],
    ]);
    expect(await store.getActiveProfileVersion("tcgdex")).toMatchObject({
      profileVersion: "2026.06.04",
      active: true,
    });
  });

  it("rolls persisted lookup back to a prior profile version", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    await store.seedProfileVersions([
      tcgdexVersion("2026.06.03", "deprecated", false),
      tcgdexVersion("2026.06.04", "active", true),
    ]);

    await store.rollbackProfileVersion("tcgdex", "2026.06.03");

    expect(await store.getActiveProfileVersion("tcgdex")).toMatchObject({
      profileVersion: "2026.06.03",
      lifecycle: "active",
      profile: tcgdexPokemonTcgProviderProfile,
    });
  });

  it("deprecates a persisted profile version through the version store", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    await store.seedProfileVersions([tcgdexVersion("2026.06.03", "active", true)]);

    const deprecated = await store.deprecateProfileVersion("tcgdex", "2026.06.03");

    expect(deprecated).toMatchObject({
      providerKey: "tcgdex",
      profileVersion: "2026.06.03",
      lifecycle: "deprecated",
      active: false,
      executableMappingContract: expect.objectContaining({
        lifecycle: "deprecated",
      }),
    });
    expect(await store.getActiveProfileVersion("tcgdex")).toBeNull();
  });
});

function tcgdexVersion(
  profileVersion: string,
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
  active: boolean,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = currentTcgdexVersion();
  return {
    ...base,
    profileVersion,
    lifecycle,
    active,
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileVersion,
          lifecycle,
        }
      : undefined,
  };
}

function legacyActiveTcgdexVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const base = currentTcgdexVersion();
  return {
    ...base,
    profileVersion: "2026.06.02",
    lifecycle: "active",
    active: true,
    sourceContract: {
      ...base.sourceContract,
      fixtureSetVersion: "transitional-static-profile-v1",
    },
    compatibilityMode: "transitional-static-profile",
    retirementPlan: {
      trackingIssue: 621,
      removeAfter: "executable-mapping-contract-activated",
      diagnosticText:
        "Retire the static TCGdex profile wrapper after the executable mapping contract drives normalization, reference extraction, and promotion planning.",
    },
    executableMappingContract: undefined,
  };
}

function currentTcgdexVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const version = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === "tcgdex");
  if (!version) {
    throw new Error("Expected seeded TCGdex profile version.");
  }
  return version;
}

class InMemoryProfileVersionDb {
  readonly statements: string[] = [];
  private rows = new Map<string, PersistedProfileVersionRow>();

  async query<T>(sql: string, params: readonly unknown[] = []): QueryResult<T> {
    this.statements.push(sql);

    if (
      sql.includes("UPDATE catalog_provider_integration_profile_versions") &&
      sql.includes("profile_version <> $2") &&
      sql.includes("active = true") &&
      sql.includes("lifecycle = 'active'")
    ) {
      const providerKey = String(params[0]);
      const profileVersion = String(params[1]);
      for (const [key, row] of this.rows) {
        if (
          row.provider_key === providerKey &&
          row.profile_version !== profileVersion &&
          row.active &&
          row.lifecycle === "active"
        ) {
          this.rows.set(key, {
            ...row,
            active: false,
            lifecycle: "deprecated",
          });
        }
      }
      return { rows: [] as T[] };
    }

    if (sql.includes("INSERT INTO catalog_provider_integration_profile_versions")) {
      const row = rowFromInsertParams(params);
      this.rows.set(rowKey(row), row);
      return { rows: [row as T] };
    }

    if (sql.includes("WHERE provider_key = $1 AND profile_version = $2")) {
      const providerKey = String(params[0]);
      const profileVersion = String(params[1]);
      return {
        rows: [...this.rows.values()]
          .filter((row) => row.provider_key === providerKey && row.profile_version === profileVersion)
          .sort((left, right) => left.profile_key.localeCompare(right.profile_key)) as T[],
      };
    }

    if (sql.includes("active = true AND lifecycle = 'active'")) {
      const providerKey = String(params[0]);
      return {
        rows: [...this.rows.values()]
          .filter((row) => row.provider_key === providerKey && row.active && row.lifecycle === "active")
          .sort((left, right) => right.profile_version.localeCompare(left.profile_version))
          .slice(0, 1) as T[],
      };
    }

    if (sql.includes("WHERE provider_key = $1")) {
      const providerKey = String(params[0]);
      return {
        rows: [...this.rows.values()].filter((row) => row.provider_key === providerKey).sort(compareRows) as T[],
      };
    }

    return {
      rows: [...this.rows.values()].sort(compareRows) as T[],
    };
  }
}

type PersistedProfileVersionRow = Readonly<{
  provider_key: string;
  profile_key: string;
  profile_version: string;
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
  active: boolean;
  profile_json: string;
  source_contract_json: string;
  fixture_contract_json: string;
  compatibility_mode: CatalogProviderIntegrationProfileVersionRecord["compatibilityMode"];
  retirement_plan_json: string | null;
  executable_mapping_contract_json: string | null;
}>;

function rowFromInsertParams(params: readonly unknown[]): PersistedProfileVersionRow {
  return {
    provider_key: String(params[0]),
    profile_key: String(params[1]),
    profile_version: String(params[2]),
    lifecycle: params[3] as CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
    active: Boolean(params[4]),
    profile_json: String(params[5]),
    source_contract_json: String(params[6]),
    fixture_contract_json: String(params[7]),
    compatibility_mode: params[8] as CatalogProviderIntegrationProfileVersionRecord["compatibilityMode"],
    retirement_plan_json: typeof params[9] === "string" ? params[9] : null,
    executable_mapping_contract_json: typeof params[10] === "string" ? params[10] : null,
  };
}

function rowKey(row: PersistedProfileVersionRow): string {
  return `${row.provider_key}:${row.profile_key}:${row.profile_version}`;
}

function compareRows(left: PersistedProfileVersionRow, right: PersistedProfileVersionRow): number {
  return left.provider_key === right.provider_key
    ? right.profile_version.localeCompare(left.profile_version)
    : left.provider_key.localeCompare(right.provider_key);
}
