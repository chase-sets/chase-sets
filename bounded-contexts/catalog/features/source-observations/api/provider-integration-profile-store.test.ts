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
  private referenceCounts = new Map<string, number>();

  setProfileVersionReferenceCount(providerKey: string, profileVersion: string, count: number): void {
    this.referenceCounts.set(referenceKey(providerKey, profileVersion), count);
  }

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
  migration_evidence_json: string | null;
  authoring_audit_json: string | null;
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
