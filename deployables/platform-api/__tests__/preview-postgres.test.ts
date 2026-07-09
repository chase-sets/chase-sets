import { describe, expect, it } from "vitest";
import type { PlatformApiBootstrapConfig } from "../src/config";
import { ensurePreviewPostgresDatabases, type PreviewPostgresPool } from "../src/preview-postgres";

type RecordedQuery = Readonly<{
  connectionString: string;
  queryText: string;
  values?: readonly unknown[];
}>;

function createRecordingPoolFactory(queries: RecordedQuery[], connectionStrings: string[]) {
  return (connectionString: string): PreviewPostgresPool => {
    connectionStrings.push(connectionString);
    return {
      query: async (queryText, values) => {
        queries.push({ connectionString, queryText, ...(values ? { values } : {}) });
        return { rows: [{ exists: false }] };
      },
      end: async () => {},
    };
  };
}

function previewBootstrapConfig(): PlatformApiBootstrapConfig {
  const host = "chase-sets-pr-123-chase-sets-platform-preview-postgres:5432";
  return {
    previewPostgresAdminUrl: `postgresql://postgres:super-secret@${host}/postgres?sslmode=disable`,
    controlDatabaseUrl: `postgresql://cs_preview_control:app-secret@${host}/chase_sets_preview_control?sslmode=disable`,
    workSignalDatabaseUrl: `postgresql://cs_preview_control:app-secret@${host}/chase_sets_preview_control?sslmode=disable`,
    contextDatabaseUrls: {
      catalog: `postgresql://cs_preview_catalog:app-secret@${host}/chase_sets_preview_catalog?sslmode=disable`,
      discovery: `postgresql://cs_preview_discovery:app-secret@${host}/chase_sets_preview_discovery?sslmode=disable`,
    },
    contextWaiterDatabaseUrls: {
      discovery: `postgresql://cs_preview_discovery:app-secret@${host}/chase_sets_preview_discovery?sslmode=disable`,
    },
  } as unknown as PlatformApiBootstrapConfig;
}

describe("preview postgres provisioning", () => {
  it("creates roles and databases for every distinct preview database", async () => {
    const queries: RecordedQuery[] = [];
    const connectionStrings: string[] = [];

    await ensurePreviewPostgresDatabases(previewBootstrapConfig(), {
      createPool: createRecordingPoolFactory(queries, connectionStrings),
    });

    const sql = queries.map((query) => query.queryText);
    expect(sql).toContain("create role \"cs_preview_control\" with login password 'app-secret'");
    expect(sql).toContain("create role \"cs_preview_catalog\" with login password 'app-secret'");
    expect(sql).toContain("create role \"cs_preview_discovery\" with login password 'app-secret'");
    expect(sql).toContain('create database "chase_sets_preview_discovery" owner "cs_preview_discovery"');
    expect(sql).toContain('grant all privileges on database "chase_sets_preview_discovery" to "cs_preview_discovery"');

    // Context and waiter URLs sharing a database/user pair provision once.
    expect(sql.filter((text) => text.includes('create role "cs_preview_discovery"'))).toHaveLength(1);
    expect(sql.filter((text) => text.includes('create database "chase_sets_preview_control"'))).toHaveLength(1);
  });

  it("installs required extensions with the superuser because preview context roles cannot", async () => {
    const queries: RecordedQuery[] = [];
    const connectionStrings: string[] = [];

    await ensurePreviewPostgresDatabases(previewBootstrapConfig(), {
      createPool: createRecordingPoolFactory(queries, connectionStrings),
    });

    const extensionQueries = queries.filter((query) => query.queryText.startsWith("create extension"));
    expect(extensionQueries).toEqual([
      {
        connectionString:
          "postgresql://postgres:super-secret@chase-sets-pr-123-chase-sets-platform-preview-postgres:5432/chase_sets_preview_discovery?sslmode=disable",
        queryText: 'create extension if not exists "vector"',
      },
    ]);

    // Only the discovery database needs an extension connection; the admin
    // pool plus one per-database extension pool are the full set.
    expect(connectionStrings).toEqual([
      "postgresql://postgres:super-secret@chase-sets-pr-123-chase-sets-platform-preview-postgres:5432/postgres?sslmode=disable",
      "postgresql://postgres:super-secret@chase-sets-pr-123-chase-sets-platform-preview-postgres:5432/chase_sets_preview_discovery?sslmode=disable",
    ]);
  });

  it("does nothing without a preview admin URL", async () => {
    const queries: RecordedQuery[] = [];
    const connectionStrings: string[] = [];
    const config = { ...previewBootstrapConfig(), previewPostgresAdminUrl: null } as PlatformApiBootstrapConfig;

    await ensurePreviewPostgresDatabases(config, {
      createPool: createRecordingPoolFactory(queries, connectionStrings),
    });

    expect(queries).toEqual([]);
    expect(connectionStrings).toEqual([]);
  });
});
