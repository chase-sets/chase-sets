import { bootstrapPlatformAdminPassword } from "@chase-sets/auth/server";
import { bootstrapPlatformAdminIdentity } from "@chase-sets/identity/server";
import { syncContextProjectionGroups } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { createFilesystemObjectStorage, createS3ObjectStorage } from "@chase-sets/object-storage";
import { Pool } from "pg";
import { createPlatformApiHost } from "./app";
import { loadBootstrapConfig, type PlatformApiBootstrapConfig } from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";
import { apiContextRegistry } from "./generated/api-context-registry";
import { createProductionTaxQuoteResolverBlocker, shouldBlockProductionTaxQuotes } from "./tax-readiness";
import { createFakeMoneyMovementGateway, createFakePaymentProcessorGateway } from "./test-support/provider-gateways";

// Keep every seed substep budget comfortably inside the deploy-quiesce window (the bootstrap
// job is killed ~780s in). A 30-minute lock budget could never clear before that kill, so it
// only produced silent hangs (exit 124) instead of an actionable error. Bounding the budgets
// here lets schema-bootstrap surface its descriptive lock-timeout error, and the substep
// timeout catches any non-lock stall, both well before the job is force-killed. See #4638.
const DEPLOYMENT_SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS = 300_000;
const DEPLOYMENT_SEED_SUBSTEP_TIMEOUT_MS = 600_000;
const PREVIEW_POSTGRES_READY_TIMEOUT_MS = 120_000;
const PREVIEW_POSTGRES_READY_RETRY_DELAY_MS = 2_000;

async function bootstrap() {
  const config = await runBootstrapPhase("load-config", () => loadBootstrapConfig());
  if (config.previewPostgresAdminUrl) {
    await runBootstrapPhase("preview-postgres-databases", () => ensurePreviewPostgresDatabases(config));
  }
  const pools = await runBootstrapPhase("create-database-pools", () => createPlatformApiPools(config));

  try {
    await runBootstrapPhase("platform-control-plane", () => bootstrapPlatformControlPlane(pools.control));
    const taxQuoteResolver = shouldBlockProductionTaxQuotes(
      config.deploymentEnvironment,
      Boolean(config.taxProviderBackedQuotesRequired),
    )
      ? createProductionTaxQuoteResolverBlocker()
      : undefined;
    const runtime = await runBootstrapPhase("create-runtime", () =>
      createPlatformApiHost({
        pools,
        runtimeProfile: config.runtimeProfile,
        hostPorts: {
          processorGateway: createFakePaymentProcessorGateway(),
          moneyMovementGateway: createFakeMoneyMovementGateway(),
          listingPhotoStorage:
            config.listingPhotoStorage.kind === "s3"
              ? createS3ObjectStorage(config.listingPhotoStorage)
              : createFilesystemObjectStorage(config.listingPhotoStorage),
          ...(taxQuoteResolver ? { taxQuoteResolver } : {}),
        },
      }),
    );
    await runBootstrapPhase("seed-api-host", () =>
      seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
        enabledDataProfiles: config.dataProfiles ?? [],
        environmentName: config.deploymentEnvironment ?? null,
        runtimeProfile: config.runtimeProfile,
        substepTimeoutMs: DEPLOYMENT_SEED_SUBSTEP_TIMEOUT_MS,
        schemaBootstrap: {
          lockAcquisitionTimeoutMs: DEPLOYMENT_SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS,
          lockTimeoutRetryBudgetMs: DEPLOYMENT_SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS,
        },
      }),
    );

    const platformAdmin = config.platformAdmin;
    if (platformAdmin) {
      const identityServices = runtime.services.identity as Parameters<typeof bootstrapPlatformAdminIdentity>[0];
      const authServices = runtime.services.auth as Parameters<typeof bootstrapPlatformAdminPassword>[0];
      const admin = await runBootstrapPhase("platform-admin-identity", () =>
        bootstrapPlatformAdminIdentity(identityServices, {
          email: platformAdmin.email,
          displayName: platformAdmin.displayName,
          accountName: platformAdmin.accountName,
        }),
      );

      await runBootstrapPhase("auth-projection-sync", () => syncContextProjectionGroups(runtime, "auth"));
      await runBootstrapPhase("platform-admin-password", () =>
        bootstrapPlatformAdminPassword(authServices, {
          userId: admin.userId,
          credentialId: admin.credentialId,
          password: platformAdmin.password,
        }),
      );
      console.log("Platform admin bootstrap reconciled.");
    }

    console.log("Platform API bootstrap complete.");
  } finally {
    await runBootstrapPhase("close-database-pools", () => closePlatformApiPools(pools));
  }
}

async function runBootstrapPhase<T>(phase: string, action: () => T | Promise<T>): Promise<T> {
  const startedAt = Date.now();
  console.log(`[platform-bootstrap] ${phase} started.`);
  try {
    const result = await action();
    console.log(`[platform-bootstrap] ${phase} completed in ${Date.now() - startedAt}ms.`);
    return result;
  } catch (error) {
    console.error(`[platform-bootstrap] ${phase} failed after ${Date.now() - startedAt}ms.`, error);
    throw error;
  }
}

async function ensurePreviewPostgresDatabases(config: PlatformApiBootstrapConfig): Promise<void> {
  if (!config.previewPostgresAdminUrl) {
    return;
  }

  const adminPool = new Pool({ connectionString: config.previewPostgresAdminUrl, max: 1 });
  try {
    await waitForPreviewPostgres(adminPool);
    for (const spec of previewDatabaseSpecs(config)) {
      await ensurePreviewDatabase(adminPool, spec);
    }
  } finally {
    await adminPool.end();
  }
}

async function waitForPreviewPostgres(adminPool: Pool): Promise<void> {
  const deadline = Date.now() + PREVIEW_POSTGRES_READY_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      await adminPool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(PREVIEW_POSTGRES_READY_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Preview Postgres did not become ready before bootstrap timeout: ${String(lastError)}`);
}

async function ensurePreviewDatabase(adminPool: Pool, spec: PreviewDatabaseSpec): Promise<void> {
  const roleExists = await adminPool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = $1)",
    [spec.username],
  );
  if (roleExists.rows[0]?.exists) {
    await adminPool.query(
      `alter role ${quoteIdentifier(spec.username)} with login password ${quoteLiteral(spec.password)}`,
    );
  } else {
    await adminPool.query(
      `create role ${quoteIdentifier(spec.username)} with login password ${quoteLiteral(spec.password)}`,
    );
  }

  const databaseExists = await adminPool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_database where datname = $1)",
    [spec.database],
  );
  if (!databaseExists.rows[0]?.exists) {
    await adminPool.query(`create database ${quoteIdentifier(spec.database)} owner ${quoteIdentifier(spec.username)}`);
  } else {
    await adminPool.query(
      `alter database ${quoteIdentifier(spec.database)} owner to ${quoteIdentifier(spec.username)}`,
    );
  }

  await adminPool.query(
    `grant all privileges on database ${quoteIdentifier(spec.database)} to ${quoteIdentifier(spec.username)}`,
  );
}

function previewDatabaseSpecs(config: PlatformApiBootstrapConfig): readonly PreviewDatabaseSpec[] {
  const urls = [
    config.controlDatabaseUrl,
    config.workSignalDatabaseUrl,
    ...Object.values(config.contextDatabaseUrls),
    ...Object.values(config.contextWaiterDatabaseUrls ?? {}),
  ].filter((value): value is string => Boolean(value));
  const specs = new Map<string, PreviewDatabaseSpec>();

  for (const url of urls) {
    const spec = parsePreviewDatabaseUrl(url);
    specs.set(`${spec.database}:${spec.username}`, spec);
  }

  return [...specs.values()].sort((left, right) =>
    `${left.database}:${left.username}`.localeCompare(`${right.database}:${right.username}`, "en"),
  );
}

type PreviewDatabaseSpec = Readonly<{
  database: string;
  username: string;
  password: string;
}>;

function parsePreviewDatabaseUrl(rawUrl: string): PreviewDatabaseSpec {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  if (!database || !username || !password) {
    throw new Error("Preview Postgres database URLs must include database, username, and password.");
  }

  return { database, username, password };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void bootstrap().catch((error) => {
  console.error("Platform API bootstrap failed.", error);
  process.exit(1);
});
