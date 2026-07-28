import { describe, expect, it } from "vitest";
import {
  createCatalogProviderIntegrationProfileVersionStore,
  seedCatalogProviderIntegrationProfileVersions,
} from "./provider-integration-profile-store";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
  tcgdexPokemonTcgProviderProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import { defineCatalogProviderIngestionUnitIdentityContract } from "./provider-integration-mapping-contract";

type QueryResult<T> = Promise<{ rows: T[] }>;

describe("catalog provider integration profile version store", () => {
  it("seeds current provider profiles through the persisted data path", async () => {
    const db = new InMemoryProfileVersionDb();

    await seedCatalogProviderIntegrationProfileVersions(db);

    expect(db.statements).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
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
      sourceContract: {
        fixtureSetVersion: "tcgdex-pokemon-executable-v1",
      },
      executableMappingContract: expect.objectContaining({
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
      }),
    });
  });

  it("requires a transactional pool for profile writes", async () => {
    const db = {
      query: async () => ({ rows: [] }),
    };

    await expect(seedCatalogProviderIntegrationProfileVersions(db)).rejects.toThrow(
      "Catalog provider profile version writes require a transactional Postgres pool.",
    );
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

  it("allows two active versions for the same provider when ingestion units differ", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    const pokemon = tcgdexVersion("2026.06.03", "active", true);
    const mtg = tcgdexVersionWithUnit("2026.06.04", "active", true, "magic-card-profile", {
      productDomain: "mtg",
      productForm: "single-card",
      ingestionPurpose: "source-observation-import",
    });
    await store.seedProfileVersions([pokemon, mtg]);

    await expect(
      store.getActiveProfileVersion("tcgdex", {
        ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(pokemon),
      }),
    ).resolves.toMatchObject({ profileKey: "pokemon-tcg" });
    await expect(
      store.getActiveProfileVersion("tcgdex", {
        ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(mtg),
      }),
    ).resolves.toMatchObject({ profileKey: "magic-card-profile" });
    await expect(store.getActiveProfileVersion("tcgdex")).rejects.toThrow(/multiple active profile units/);
  });

  it("activating one unit only deprecates the prior active version for that unit", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    await store.seedProfileVersions([
      tcgdexVersion("2026.06.03", "active", true),
      tcgdexVersionWithUnit("2026.06.04", "active", true, "magic-card-profile", {
        productDomain: "mtg",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
      tcgdexVersionWithUnit("2026.06.05", "test", false, "magic-card-profile", {
        productDomain: "mtg",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
    ]);

    await store.activateProfileVersion("tcgdex", "2026.06.05");

    expect(
      (await store.listProfileVersions("tcgdex")).map((version) => [
        version.profileKey,
        version.profileVersion,
        version.lifecycle,
        version.active,
      ]),
    ).toEqual([
      ["magic-card-profile", "2026.06.05", "active", true],
      ["magic-card-profile", "2026.06.04", "deprecated", false],
      ["pokemon-tcg", "2026.06.03", "active", true],
    ]);
  });

  it("requires profile or unit selection when provider and version identify multiple profile rows", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    const pokemon = tcgdexVersion("2026.06.03", "active", true);
    const mtg = tcgdexVersionWithUnit("2026.06.03", "test", false, "magic-card-profile", {
      productDomain: "mtg",
      productForm: "single-card",
      ingestionPurpose: "source-observation-import",
    });
    await store.seedProfileVersions([pokemon, mtg]);

    await expect(store.getProfileVersion("tcgdex", "2026.06.03")).rejects.toThrow(/multiple profile units/);
    await expect(
      store.getProfileVersion("tcgdex", "2026.06.03", { profileKey: "magic-card-profile" }),
    ).resolves.toMatchObject({ profileKey: "magic-card-profile" });

    await store.activateProfileVersion("tcgdex", "2026.06.03", { profileKey: "magic-card-profile" });

    expect(
      (await store.listProfileVersions("tcgdex")).map((version) => [
        version.profileKey,
        version.profileVersion,
        version.lifecycle,
        version.active,
      ]),
    ).toEqual([
      ["pokemon-tcg", "2026.06.03", "active", true],
      ["magic-card-profile", "2026.06.03", "active", true],
    ]);
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

  it("persists migration evidence and authoring audit metadata", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    await store.upsertProfileVersion({
      ...tcgdexVersion("2026.06.04", "draft", false),
      migrationEvidence: {
        evidenceText: "Replay compared against the prior active TCGdex mapping.",
        mappingFingerprintBefore: "before",
        mappingFingerprintAfter: "after",
        fixtureRunId: "fixture-run-1",
        recordedAt: "2026-06-03T00:00:00.000Z",
        recordedByUserId: "usr_test",
        recordedForAccountId: "acc_test",
      },
      authoringAudit: {
        createdAt: "2026-06-03T00:00:00.000Z",
        createdByUserId: "usr_test",
        createdForAccountId: "acc_test",
        updatedAt: "2026-06-03T00:01:00.000Z",
        updatedByUserId: "usr_test",
        updatedForAccountId: "acc_test",
      },
    });

    await expect(store.getProfileVersion("tcgdex", "2026.06.04")).resolves.toMatchObject({
      migrationEvidence: {
        evidenceText: "Replay compared against the prior active TCGdex mapping.",
        fixtureRunId: "fixture-run-1",
      },
      authoringAudit: {
        createdByUserId: "usr_test",
        updatedByUserId: "usr_test",
      },
    });
  });

  it("refreshes section projections after canonical profile version writes", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);

    await store.upsertProfileVersion(currentTcgdexVersion());

    expect(
      db.statements.some((statement) => statement.includes("INSERT INTO catalog_provider_profile_version_sections")),
    ).toBe(true);
    expect(
      db.statements.some((statement) =>
        statement.includes("DELETE FROM catalog_provider_profile_version_section_diagnostics"),
      ),
    ).toBe(true);
    expect(
      db.statements.some((statement) => statement.includes("DELETE FROM catalog_provider_profile_version_sections")),
    ).toBe(true);
  });

  it("does not clobber admin-authored profile rows during seed reconciliation", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    await store.upsertProfileVersion({
      ...tcgdexVersion("2026.06.03", "test", false),
      profile: {
        ...tcgdexPokemonTcgProviderProfile,
        displayName: "Admin edited TCGdex",
      },
      authoringAudit: {
        createdAt: "2026-06-03T00:00:00.000Z",
        createdByUserId: "usr_test",
        createdForAccountId: "acc_test",
      },
    });
    await store.upsertProfileVersion({
      ...tcgdexVersion("2026.06.04", "active", true),
      authoringAudit: {
        createdAt: "2026-06-03T00:01:00.000Z",
        createdByUserId: "usr_test",
        createdForAccountId: "acc_test",
      },
    });

    await seedCatalogProviderIntegrationProfileVersions(db);

    await expect(store.getProfileVersion("tcgdex", "2026.06.03")).resolves.toMatchObject({
      lifecycle: "test",
      active: false,
      profile: {
        displayName: "Admin edited TCGdex",
      },
      authoringAudit: {
        createdByUserId: "usr_test",
      },
    });
  });

  it("fails seed reconciliation when a seeded provider is left without an active profile row", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    await store.upsertProfileVersion({
      ...tcgdexVersion("2026.06.03", "test", false),
      authoringAudit: {
        createdAt: "2026-06-03T00:00:00.000Z",
        createdByUserId: "usr_test",
        createdForAccountId: "acc_test",
      },
    });

    await expect(seedCatalogProviderIntegrationProfileVersions(db)).rejects.toThrow(
      "requires an active profile row for provider 'tcgdex'",
    );
  });

  it("counts Source Observation references to a provider profile version", async () => {
    const db = new InMemoryProfileVersionDb();
    const store = createCatalogProviderIntegrationProfileVersionStore(db);
    db.setProfileVersionReferenceCount("tcgdex", "2026.06.03", 2);

    await expect(store.countProfileVersionReferences("TCGDEX", "2026.06.03")).resolves.toBe(2);
    expect(db.statements.some((statement) => statement.includes("FROM catalog_source_observations"))).toBe(true);
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

function tcgdexVersionWithUnit(
  profileVersion: string,
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
  active: boolean,
  profileKey: string,
  unit: Readonly<{
    productDomain: "pokemon" | "mtg";
    productForm: "single-card" | "sealed-product" | "set";
    ingestionPurpose: "source-observation-import" | "reference-data" | "image-evidence";
  }>,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = tcgdexVersion(profileVersion, lifecycle, active);
  const ingestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: base.providerKey,
    ...unit,
  });
  return {
    ...base,
    profileKey,
    ingestionUnitIdentity,
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileKey,
          ingestionUnitIdentity,
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
      fixtureSetVersion: "previous-executable-profile-v1",
    },
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
  private referenceCounts = new Map<string, number>();

  setProfileVersionReferenceCount(providerKey: string, profileVersion: string, count: number): void {
    this.referenceCounts.set(referenceKey(providerKey, profileVersion), count);
  }

  async connect(): Promise<{ query: InMemoryProfileVersionDb["query"]; release: () => void }> {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }

  async query<T>(sql: string, params: readonly unknown[] = []): QueryResult<T> {
    this.statements.push(sql);

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }

    if (
      sql.includes("UPDATE catalog_provider_integration_profile_versions") &&
      sql.includes("profile_key = $2") &&
      sql.includes("profile_version = $3") &&
      sql.includes("active = true") &&
      sql.includes("lifecycle = 'active'")
    ) {
      const providerKey = String(params[0]);
      const profileKey = String(params[1]);
      const profileVersion = String(params[2]);
      const updatedRows: PersistedProfileVersionRow[] = [];
      for (const [key, row] of this.rows) {
        if (
          row.provider_key === providerKey &&
          row.profile_key === profileKey &&
          row.profile_version === profileVersion &&
          row.active &&
          row.lifecycle === "active"
        ) {
          const updatedRow = {
            ...row,
            active: false,
            lifecycle: "deprecated",
          } as const satisfies PersistedProfileVersionRow;
          this.rows.set(key, updatedRow);
          updatedRows.push(updatedRow);
        }
      }
      return { rows: updatedRows as T[] };
    }

    if (
      sql.includes("FROM catalog_provider_integration_profile_versions") &&
      sql.includes("profile_version <> $2") &&
      sql.includes("active = true") &&
      sql.includes("lifecycle = 'active'")
    ) {
      const providerKey = String(params[0]);
      const profileVersion = String(params[1]);
      return {
        rows: [...this.rows.values()]
          .filter(
            (row) =>
              row.provider_key === providerKey &&
              row.profile_version !== profileVersion &&
              row.active &&
              row.lifecycle === "active",
          )
          .sort(compareRows) as T[],
      };
    }

    if (sql.includes("FROM catalog_source_observations") && sql.includes("COUNT(*) AS reference_count")) {
      const providerKey = String(params[0]);
      const profileVersion = String(params[1]);
      return {
        rows: [
          {
            reference_count: this.referenceCounts.get(referenceKey(providerKey, profileVersion)) ?? 0,
          },
        ] as T[],
      };
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
          .sort((left, right) => right.profile_version.localeCompare(left.profile_version)) as T[],
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
  ingestion_unit_key: string;
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
  active: boolean;
  profile_json: string;
  source_contract_json: string;
  fixture_contract_json: string;
  retirement_plan_json: string | null;
  executable_mapping_contract_json: string | null;
  migration_evidence_json: string | null;
  authoring_audit_json: string | null;
}>;

function rowFromInsertParams(params: readonly unknown[]): PersistedProfileVersionRow {
  return {
    provider_key: String(params[0]),
    profile_key: String(params[1]),
    profile_version: String(params[2]),
    ingestion_unit_key: String(params[3]),
    lifecycle: params[4] as CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
    active: Boolean(params[5]),
    profile_json: String(params[6]),
    source_contract_json: String(params[7]),
    fixture_contract_json: String(params[8]),
    retirement_plan_json: typeof params[9] === "string" ? params[9] : null,
    executable_mapping_contract_json: typeof params[10] === "string" ? params[10] : null,
    migration_evidence_json: typeof params[11] === "string" ? params[11] : null,
    authoring_audit_json: typeof params[12] === "string" ? params[12] : null,
  };
}

function rowKey(row: PersistedProfileVersionRow): string {
  return `${row.provider_key}:${row.profile_key}:${row.profile_version}`;
}

function referenceKey(providerKey: string, profileVersion: string): string {
  return `${providerKey.trim().toLowerCase()}:${profileVersion.trim()}`;
}

function compareRows(left: PersistedProfileVersionRow, right: PersistedProfileVersionRow): number {
  return left.provider_key === right.provider_key
    ? right.profile_version.localeCompare(left.profile_version)
    : left.provider_key.localeCompare(right.provider_key);
}
