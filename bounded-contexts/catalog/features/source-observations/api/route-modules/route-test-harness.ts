import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import { sourceObservationRoutes } from "../route";
import type { SourceObservationRouteServices } from "../route";
import type { CatalogProviderIntegrationProfileVersionStore } from "../providers/provider-integration-profile-store";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import {
  CatalogIntegrationRolloutControlError,
  createCatalogIntegrationRolloutControlPolicy,
} from "../governance/catalog-integration-rollout-controls";

export const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: {
    performedByUserId: "usr_test" as UserId,
    forAccountId: "acc_test" as AccountId,
  },
};

export const manageActor: CatalogAuthoringEnv["Variables"]["actor"] = {
  permissions: ["catalog.view", "catalog.manage"],
};

export const viewOnlyActor: CatalogAuthoringEnv["Variables"]["actor"] = {
  permissions: ["catalog.view"],
};

export function rolloutDenied(
  input: Parameters<ReturnType<typeof createCatalogIntegrationRolloutControlPolicy>["decide"]>[0],
) {
  const policy = createCatalogIntegrationRolloutControlPolicy({
    disabledProviderAdapters: ["tcgdex"],
    disabledImports: ["tcgdex"],
    disabledPromotion: ["tcgdex"],
    disabledReapply: ["tcgdex"],
    activationMode: "disabled",
  });
  const decision = policy.decide(input);
  if (decision.allowed) {
    throw new Error("Expected rollout control policy to deny the test operation.");
  }
  return new CatalogIntegrationRolloutControlError(decision);
}

export function buildApp(
  services: SourceObservationRouteServices,
  profileVersions?: CatalogProviderIntegrationProfileVersionStore,
  actor: CatalogAuthoringEnv["Variables"]["actor"] = manageActor,
) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.use("/source-observations/*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route("/source-observations", sourceObservationRoutes(services, profileVersions));

  return app;
}

export function mutableProfileStore(
  initialRecords: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderIntegrationProfileVersionStore {
  let records: CatalogProviderIntegrationProfileVersionRecord[] = [...initialRecords];
  return {
    seedProfileVersions: async () => records,
    upsertProfileVersion: async (version) => {
      records = records.filter(
        (candidate) =>
          !(
            candidate.providerKey === version.providerKey &&
            candidate.profileKey === version.profileKey &&
            candidate.profileVersion === version.profileVersion
          ),
      );
      records = [...records, version];
      return version;
    },
    listProfileVersions: async (providerKey) =>
      records.filter((version) => !providerKey || version.providerKey === providerKey),
    getProfileVersion: async (providerKey, profileVersion) =>
      records.find((version) => version.providerKey === providerKey && version.profileVersion === profileVersion) ??
      null,
    getActiveProfileVersion: async (providerKey) =>
      records.find(
        (version) => version.providerKey === providerKey && version.active && version.lifecycle === "active",
      ) ?? null,
    activateProfileVersion: async (providerKey, profileVersion) =>
      updateProfileVersion(records, providerKey, profileVersion, "active", true),
    deprecateProfileVersion: async (providerKey, profileVersion) =>
      updateProfileVersion(records, providerKey, profileVersion, "deprecated", false),
    rollbackProfileVersion: async (providerKey, profileVersion) =>
      updateProfileVersion(records, providerKey, profileVersion, "active", true),
    countProfileVersionReferences: async () => 0,
  };

  function updateProfileVersion(
    current: CatalogProviderIntegrationProfileVersionRecord[],
    providerKey: string,
    profileVersion: string,
    lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
    active: boolean,
  ): CatalogProviderIntegrationProfileVersionRecord {
    const version = current.find(
      (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
    );
    if (!version) {
      throw new Error("Profile version not found.");
    }
    const updated = {
      ...version,
      lifecycle,
      active,
      executableMappingContract: version.executableMappingContract
        ? { ...version.executableMappingContract, lifecycle }
        : undefined,
    };
    records = current.map((candidate) => (candidate === version ? updated : candidate));
    return updated;
  }
}

export function profileVersion(
  providerKey: string,
  overrides: Partial<CatalogProviderIntegrationProfileVersionRecord>,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = catalogProviderIntegrationProfileVersions.find((version) => version.providerKey === providerKey);
  if (!base) {
    throw new Error(`Expected seeded ${providerKey} provider profile version.`);
  }

  const nextProfileVersion = overrides.profileVersion ?? base.profileVersion;
  const nextLifecycle = overrides.lifecycle ?? base.lifecycle;

  return {
    ...base,
    ...overrides,
    profileVersion: nextProfileVersion,
    lifecycle: nextLifecycle,
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileVersion: nextProfileVersion,
          lifecycle: nextLifecycle,
        }
      : undefined,
  };
}

export function jobEvent<TJob>(job: TJob, sequence = 1) {
  return {
    sequence,
    eventName: "status" as const,
    job,
    createdAt: "2026-05-28T00:00:00.000Z",
  };
}

export function readSseData(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data:".length).trim()));
}

export function integrationJob(input: { status: "queued" | "running" | "completed" | "failed" }) {
  return integrationJobFixture({
    jobId: "job_integration",
    action: "import",
    scope: { provider: "tcgdex", language: "en", seriesId: "base" },
    status: input.status,
    progress: {
      phase: input.status === "completed" ? "completed" : "processing",
      completed: input.status === "completed" ? 1 : 0,
      total: 1,
      currentName: "Base Set",
      status: input.status === "completed" ? "imported" : null,
    },
    result:
      input.status === "completed"
        ? {
            requested: 1,
            imported: 1,
            observed: 102,
            reapplied: 0,
            skipped: 0,
            failed: 0,
            outcomes: [],
          }
        : null,
    errorMessage: null,
    createdAt: "2026-05-23T00:00:00.000Z",
    startedAt: input.status === "queued" ? null : "2026-05-23T00:00:01.000Z",
    completedAt: input.status === "completed" ? "2026-05-23T00:00:02.000Z" : null,
    updatedAt: "2026-05-23T00:00:02.000Z",
  });
}

export function integrationJobFixture(
  input: Record<string, unknown> & {
    jobId?: string;
    action?: "import" | "reapply";
  },
) {
  return {
    ...baseIntegrationJob(),
    ...input,
  } as const;
}

export function baseIntegrationJob() {
  return {
    jobId: "job_integration",
    action: "import" as const,
    scope: { provider: "tcgdex", language: "en", seriesId: "base" },
    status: "queued" as const,
    progress: {
      phase: "queued" as const,
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    errorMessage: null,
    createdAt: "2026-05-23T00:00:00.000Z",
    startedAt: null as string | null,
    completedAt: null as string | null,
    updatedAt: "2026-05-23T00:00:02.000Z",
  };
}

export function bulkJobFixture(
  input: Record<string, unknown> & {
    jobId?: string;
    action?: "promote" | "reject" | "defer" | "reapply";
  },
) {
  return {
    ...baseBulkJob(),
    ...input,
  } as const;
}

export function baseBulkJob() {
  return {
    jobId: "job_bulk",
    action: "promote" as const,
    selectionMode: "ids" as const,
    observationIds: [] as readonly string[],
    scope: {},
    reason: null as string | null,
    status: "queued" as const,
    progress: {
      phase: "queued" as const,
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    errorMessage: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    startedAt: null as string | null,
    completedAt: null as string | null,
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}
