import type { Client, ClientConfig } from "pg";
import type { readFileSync } from "node:fs";
import type { chmod, mkdtemp, rm } from "node:fs/promises";

export type DatabaseGrant = Readonly<{ database: string; user: string; kind: "owner" | "wake-listener" }>;
export type GrantAuthority = Readonly<{ host: string; port: number; database: string; user: string; password: string }>;
export type DatabaseGrantDependencies = {
  Client?: new (config: ClientConfig) => Pick<Client, "connect" | "query" | "end">;
  managedPostgresGrantUrl?: typeof managedPostgresGrantUrl;
  statementsForGrant?: typeof statementsForGrant;
  readFileSync?: typeof readFileSync;
  fetchDigitalOceanManagedPostgresCa?: (
    options: { clusterId: string; digitalOceanToken?: string },
    dependencies: { fetch?: typeof fetch },
  ) => Promise<string>;
  fetch?: typeof fetch;
  mkdtemp?: typeof mkdtemp;
  chmod?: typeof chmod;
  rm?: typeof rm;
  tmpdir?: () => string;
  writeManagedPostgresCa?: (caPath: string, certificate: string) => Promise<void>;
  log?: (value: string) => void;
  error?: (value: string) => void;
};

export const GRANT_KINDS: readonly DatabaseGrant["kind"][];
export const WAKE_LISTENER_EVENT_STORE_TABLES: readonly string[];
export function quoteIdentifier(value: string): string;
export function statementsForGrant(grant: DatabaseGrant): string[];
export function assertManagedPostgresGrantUrl(connectionString: string, authority: GrantAuthority, caPath: string): URL;
export function managedPostgresGrantUrl(grant: DatabaseGrant, env: NodeJS.ProcessEnv, caPath: string): string;
export function readGrants(env?: NodeJS.ProcessEnv): DatabaseGrant[];
export function applyDatabaseGrants(
  env?: NodeJS.ProcessEnv,
  dependencies?: DatabaseGrantDependencies,
): Promise<{ grantCount: number }>;
export function runDatabaseGrantMain(env?: NodeJS.ProcessEnv, dependencies?: DatabaseGrantDependencies): Promise<0 | 1>;
