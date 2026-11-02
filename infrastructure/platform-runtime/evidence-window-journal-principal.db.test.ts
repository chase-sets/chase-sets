import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapPlatformControlPlane, createPostgresEvidenceWindowRegistration } from "./control-plane";
import { createPostgresEvidenceWindowProviderWrite } from "./evidence-window-provider-write";
import {
  EVIDENCE_WINDOW_JOURNAL_LOCK_SQL,
  countEvidenceWindowJournalSessions,
  evidenceWindowJournalPrincipal,
  evidenceWindowJournalPrincipalDropStatements,
  evidenceWindowJournalPrincipalExists,
  evidenceWindowJournalPrincipalExpireStatement,
  evidenceWindowJournalPrincipalProvisionStatements,
  listEvidenceWindowJournalPrincipals,
  runEvidenceWindowJournalProbes,
  scramSha256Verifier,
  terminateEvidenceWindowJournalSessions,
  type EvidenceWindowJournalPrincipal,
} from "./evidence-window-journal-principal";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const windowId = "0123456789abcdef0123456789abcdef";
const password = "synthetic-journal-password";

describe("evidence-window journal principal against Postgres", () => {
  let pools: Readonly<Record<"control", PgTransactionalPool>>;
  let controlUrl: string;
  let adminOnControl: PgTransactionalPool;
  let database: string;
  let principal: EvidenceWindowJournalPrincipal;
  const principalPools: PgTransactionalPool[] = [];
  const principalClients: { release: () => void }[] = [];
  const createdPrincipals: EvidenceWindowJournalPrincipal[] = [];
  const endPool = (pool: PgTransactionalPool) => (pool as unknown as { end: () => Promise<void> }).end();
  const principalUrl = (name: string, secret: string) => {
    const url = new URL(controlUrl);
    url.username = name;
    url.password = secret;
    return url.toString();
  };

  const connectAs = async (name: string, secret: string) => {
    const pool = createPgPool(principalUrl(name, secret), { max: 1 });
    principalPools.push(pool);
    const client = await pool.connect();
    principalClients.push(client);
    return client;
  };
  const endPrincipalSessions = async () => {
    for (const client of principalClients.splice(0)) client.release();
    await Promise.all(principalPools.splice(0).map((pool) => endPool(pool).catch(() => undefined)));
  };
  const connectFailure = async (name: string, secret: string) => {
    try {
      await connectAs(name, secret);
      return "connected";
    } catch (error) {
      return (error as { code?: string }).code ?? "unknown";
    }
  };

  beforeAll(async () => {
    if (!adminDatabaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for platform-runtime evidence-window principal DB tests.");
    }
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["control"], "platform_ew_principal");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    controlUrl = databaseUrls.control;
    database = new URL(controlUrl).pathname.slice(1);
    const adminUrl = new URL(adminDatabaseUrl);
    adminUrl.pathname = `/${database}`;
    adminOnControl = createPgPool(adminUrl.toString(), { max: 2 });
  });

  beforeEach(async () => {
    await endPrincipalSessions();
    await resetMultiContextTestSchemas(pools);
    await bootstrapPlatformControlPlane(pools.control);
    principal = evidenceWindowJournalPrincipal(String(randomInt(1, 2 ** 47)), randomInt(1, 100));
    createdPrincipals.push(principal);
    const validUntil = new Date(Date.now() + 3_600_000).toISOString();
    for (const statement of evidenceWindowJournalPrincipalProvisionStatements({
      principal,
      database,
      verifier: scramSha256Verifier(password),
      validUntil,
    })) {
      await adminOnControl.query(statement);
    }
  });

  afterAll(async () => {
    await endPrincipalSessions();
    if (adminOnControl) {
      for (const leftover of createdPrincipals) {
        await terminateEvidenceWindowJournalSessions(adminOnControl, leftover);
        for (const statement of evidenceWindowJournalPrincipalDropStatements(leftover, database)) {
          await adminOnControl.query(statement).catch(() => undefined);
        }
      }
      await endPool(adminOnControl);
    }
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("records the ledgered migration once across repeated fleet boots", async () => {
    await bootstrapPlatformControlPlane(pools.control);
    await bootstrapPlatformControlPlane(pools.control);
    const ledger = await pools.control.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM bounded_context_schema_migrations
       WHERE migration_id = '20261020_evidence_window_journal_principal_write_refusal'`,
    );
    expect(ledger.rows[0]?.count).toBe(1);
    const triggers = await pools.control.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'evidence_window'::regclass AND NOT tgisinternal`,
    );
    expect(triggers.rows.map(({ tgname }) => tgname)).toEqual(["evidence_window_refuse_journal_principal_write"]);
  });

  it("proves journal transaction, readWindow and lock succeed while every other write and table fails", async () => {
    const registration = createPostgresEvidenceWindowRegistration(pools.control);
    const opened = await registration.open({ windowId, retentionSeconds: 3_600 });

    const client = await connectAs(principal.name, password);
    const probes = await runEvidenceWindowJournalProbes(client, windowId);
    expect(probes.filter(({ expected, observed }) => expected !== observed)).toEqual([]);

    await client.query("BEGIN");
    const locked = await client.query(EVIDENCE_WINDOW_JOURNAL_LOCK_SQL, [windowId]);
    await client.query("ROLLBACK");
    expect(locked.rows).toHaveLength(1);

    const journalPool = createPgPool(principalUrl(principal.name, password), { max: 1 });
    principalPools.push(journalPool);
    await expect(createPostgresEvidenceWindowProviderWrite(journalPool).readWindow(windowId)).resolves.toEqual([]);

    const refusal = await client
      .query("UPDATE evidence_window SET version = version WHERE false")
      .catch((error) => error);
    expect(refusal).toMatchObject({ code: "42501", message: "evidence-window-journal-principal-write-refused" });

    // The runtime principal keeps its registration authority.
    await expect(registration.close({ windowId, expectedVersion: opened.version })).resolves.toMatchObject({
      state: "closed",
      version: opened.version + 1,
    });
  });

  it("rejects a withheld and an expired credential, then leaves neither sessions nor the login behind", async () => {
    expect(await connectFailure(principal.name, "withheld-or-wrong")).toBe("28P01");
    await connectAs(principal.name, password);
    expect(await countEvidenceWindowJournalSessions(adminOnControl, principal)).toBe(1);

    await adminOnControl.query(evidenceWindowJournalPrincipalExpireStatement(principal));
    expect(["28P01", "28000"]).toContain(await connectFailure(principal.name, password));

    await terminateEvidenceWindowJournalSessions(adminOnControl, principal);
    await expect.poll(() => countEvidenceWindowJournalSessions(adminOnControl, principal)).toBe(0);
    for (const statement of evidenceWindowJournalPrincipalDropStatements(principal, database)) {
      await adminOnControl.query(statement);
    }
    expect(await evidenceWindowJournalPrincipalExists(adminOnControl, principal)).toBe(false);
    expect((await listEvidenceWindowJournalPrincipals(adminOnControl)).principals).not.toContainEqual(principal);
  });
});
