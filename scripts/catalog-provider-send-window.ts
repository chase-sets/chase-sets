#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  normalizePgPoolConnectionString,
  resolvePgPoolSslConfig,
  type PgTransactionalPool,
} from "../infrastructure/event-core-postgres/index.ts";
import {
  createPostgresProviderSendLedger,
  validateProviderSendInstallation,
} from "../bounded-contexts/catalog/features/source-observations/api/providers/provider-send-ledger.ts";
import { loadCatalogProviderSendWindowEnabled } from "../infrastructure/platform-runtime/config-schema.ts";
import type { ProviderSendBinding } from "../bounded-contexts/catalog/features/source-observations/api/providers/provider-send-admission.ts";

export type ProviderSendWindowCommand = Readonly<{
  environment: string;
  action: "read" | "arm" | "advance" | "terminate";
  apply: boolean;
  installation?: unknown;
  expected?: ProviderSendBinding;
}>;

export async function runProviderSendWindowCommand(pool: PgTransactionalPool, command: ProviderSendWindowCommand) {
  if (command.environment !== "staging") throw new Error("provider-send-window-staging-required");
  if (!["read", "arm", "advance", "terminate"].includes(command.action))
    throw new Error("provider-send-window-action-invalid");
  const identity = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (identity.rows.length !== 1 || identity.rows[0]?.name !== "chase_sets_staging_catalog") {
    throw new Error("provider-send-window-database-identity-refused");
  }
  const ledger = createPostgresProviderSendLedger(pool);
  if (command.action === "arm") validateProviderSendInstallation(command.installation);
  if (command.action === "advance" || command.action === "terminate") {
    const binding = command.expected;
    if (
      !binding ||
      typeof binding.windowId !== "string" ||
      !Number.isSafeInteger(binding.pass) ||
      binding.pass < 0 ||
      binding.pass > 9 ||
      binding.phase !== (binding.pass === 0 ? "preflight" : "pass")
    )
      throw new Error("provider-send-window-binding-invalid");
  }
  if (command.apply) {
    if (command.action === "arm") await ledger.arm(command.installation);
    if (command.action === "advance") await ledger.advance(command.expected!);
    if (command.action === "terminate") await ledger.terminate(command.expected!);
  }
  return {
    schemaVersion: "catalog-provider-send-window/v1",
    environment: "staging",
    action: command.action,
    result: command.apply ? "applied" : "dry-run",
    providerSendWindow: await ledger.read(),
  };
}

async function main(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(environment|action|mode|installation|window|phase|pass|out)=(.+)$/.exec(argument);
    if (!match || values.has(match[1]!)) throw new Error("provider-send-window-arguments-invalid");
    values.set(match[1]!, match[2]!);
  }
  const environment = values.get("environment");
  if (environment !== "staging" || !loadCatalogProviderSendWindowEnabled())
    throw new Error("provider-send-window-staging-enablement-required");
  const action = values.get("action");
  if (action !== "read" && action !== "arm" && action !== "advance" && action !== "terminate")
    throw new Error("provider-send-window-action-invalid");
  const mode = values.get("mode") ?? "dry-run";
  if (mode !== "apply" && mode !== "dry-run") throw new Error("provider-send-window-mode-invalid");
  const databaseUrl = process.env.DATABASE_URL_CATALOG;
  if (!databaseUrl) throw new Error("provider-send-window-database-required");
  const installationPath = values.get("installation");
  const phase = values.get("phase");
  if (phase !== undefined && phase !== "preflight" && phase !== "pass")
    throw new Error("provider-send-window-binding-invalid");
  const command: ProviderSendWindowCommand = {
    environment,
    action,
    apply: mode === "apply",
    installation: installationPath ? JSON.parse(readFileSync(installationPath, "utf8")) : undefined,
    expected: phase ? { windowId: values.get("window") ?? "", phase, pass: Number(values.get("pass")) } : undefined,
  };
  const pool = new pg.Pool({
    connectionString: normalizePgPoolConnectionString(databaseUrl),
    ssl: resolvePgPoolSslConfig(databaseUrl),
    max: 1,
  });
  try {
    const report = await runProviderSendWindowCommand(pool, command);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    const destination = values.get("out");
    if (destination) writeFileSync(destination, output, "utf8");
    else process.stdout.write(output);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("provider-send-window-command-refused\n");
    process.exitCode = 1;
  });
}
