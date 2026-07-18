#!/usr/bin/env node
// Read-only gate for the staging-refresh chain. The report is intentionally
// support-safe: it emits credential names/states, provider state categories,
// expected public set labels, and workflow links only.
import { execFile as execFileCallback } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  STAGING_REFRESH_PREFLIGHT_VERSION,
  stagingRefreshCredentialedProviders,
  stagingRefreshOverlapWorkflowNames,
  stagingRefreshRequiredSecrets,
  stagingRefreshSetMatrix,
} from "./staging-refresh-preflight-config.mjs";

const execFile = promisify(execFileCallback);
const SESSION_COOKIE_NAME = "chase_sets_session";
const DEFAULT_ADMIN_BASE_URL = "https://admin.staging.chasesets.com";
const MAX_OPTION_PAGES = 20;

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readEnv(name, env) {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function parseStagingRefreshPreflightArgs(argv, env = process.env) {
  return {
    environment: readOption(argv, "--environment") ?? readEnv("STAGING_REFRESH_ENVIRONMENT", env) ?? "staging",
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env) ?? "chase-sets/chase-sets",
    adminBaseUrl:
      readOption(argv, "--admin-base-url") ?? readEnv("STAGING_REFRESH_ADMIN_BASE_URL", env) ?? DEFAULT_ADMIN_BASE_URL,
    adminEmail:
      readEnv("CATALOG_ADMIN_E2E_EMAIL", env) ??
      readEnv("PLATFORM_ADMIN_EMAIL", env) ??
      readEnv("TF_VAR_platform_admin_email", env),
    adminPassword:
      readEnv("CATALOG_ADMIN_E2E_PASSWORD", env) ??
      readEnv("PLATFORM_ADMIN_PASSWORD", env) ??
      readEnv("TF_VAR_platform_admin_password", env),
    allowCreditedProviderReads:
      hasFlag(argv, "--allow-credited-provider-reads") ||
      readEnv("STAGING_REFRESH_ALLOW_CREDITED_PROVIDER_READS", env) === "true",
    skipGithubMetadata: hasFlag(argv, "--skip-github-metadata"),
    skipDoctl: hasFlag(argv, "--skip-doctl"),
    skipOverlapCheck: hasFlag(argv, "--skip-overlap-check"),
    skipAdminChecks: hasFlag(argv, "--skip-admin-checks"),
    scheduledOverlapConfirmed:
      hasFlag(argv, "--confirm-no-scheduled-overlap") ||
      readEnv("STAGING_REFRESH_NO_SCHEDULED_OVERLAP_CONFIRMED", env) === "true",
    digitalOceanAppName:
      readOption(argv, "--digitalocean-app-name") ??
      readEnv("STAGING_REFRESH_DIGITALOCEAN_APP_NAME", env) ??
      "chase-sets-staging-platform",
    currentRunId: readEnv("GITHUB_RUN_ID", env) ?? null,
    outPath: readOption(argv, "--out") ?? null,
  };
}

function validatesSecretValue(valueKind, value) {
  if (!value) {
    return false;
  }
  if (valueKind === "stripe-secret-test") {
    return value.startsWith("sk_test_");
  }
  if (valueKind === "stripe-publishable-test") {
    return value.startsWith("pk_test_");
  }
  if (valueKind === "stripe-webhook") {
    return value.startsWith("whsec_");
  }
  if (valueKind === "easypost-test") {
    return value.startsWith("EZTK");
  }
  return true;
}

export function evaluateStagingRefreshSecrets(secretMetadata, env = process.env) {
  const metadataByName = new Map(secretMetadata.map((secret) => [secret.name, secret]));
  return stagingRefreshRequiredSecrets.map((requirement) => {
    const metadata = metadataByName.get(requirement.name);
    const value = env[requirement.name];
    const valueAvailable = typeof value === "string" && value.length > 0;
    const valueValid = valueAvailable ? validatesSecretValue(requirement.valueKind, value) : null;
    return {
      name: requirement.name,
      metadataState: metadata ? "present" : "missing",
      updatedAt: metadata?.updatedAt ?? null,
      valueState: valueValid === true ? "verified" : valueValid === false ? "invalid" : "not-inspectable",
      expectedKind: requirement.valueKind,
    };
  });
}

export function evaluateProviderPosture(overview) {
  const providers = overview?.providerReadiness?.providers ?? [];
  const credentialPosture = stagingRefreshCredentialedProviders.map((providerKey) => {
    const provider = providers.find((candidate) => candidate.providerKey === providerKey);
    return {
      providerKey,
      readiness: provider?.readiness ?? "unknown",
      credentialReadiness: provider?.credentialReadiness ?? "unknown",
      credentialReadinessState: provider?.credentialReadinessState ?? "unknown",
    };
  });
  const scrydex = providers.find((provider) => provider.providerKey === "scrydex");
  const diagnosticCodes = new Set((scrydex?.diagnostics ?? []).map((diagnostic) => diagnostic.code));
  let creditCategory = "unknown";
  if ([...diagnosticCodes].some((code) => code.includes("credit") && code.includes("exhaust"))) {
    creditCategory = "exhausted";
  } else if ([...diagnosticCodes].some((code) => code.includes("credit") && code.includes("low"))) {
    creditCategory = "low";
  } else if (diagnosticCodes.has("scrydex-account-usage-checked") || scrydex?.usageBudget?.readiness === "ready") {
    creditCategory = "available";
  } else if (scrydex?.usageBudget?.readiness === "blocked") {
    creditCategory = "exhausted";
  } else if (scrydex?.usageBudget?.readiness === "degraded") {
    creditCategory = "low";
  }
  return { credentialPosture, scrydexCreditCategory: creditCategory };
}

export function deployedSecretPostureFromApp(app) {
  const spec = app?.spec ?? app?.active_deployment?.spec ?? {};
  const components = [...(spec.services ?? []), ...(spec.workers ?? []), ...(spec.jobs ?? [])];
  return stagingRefreshRequiredSecrets.map((requirement) => {
    const configuredComponents = components
      .filter((component) =>
        (component.envs ?? []).some(
          (entry) => entry.key === requirement.name && entry.type === "SECRET" && String(entry.value ?? "").length > 0,
        ),
      )
      .map((component) => component.name)
      .filter(Boolean)
      .sort();
    return {
      name: requirement.name,
      state: configuredComponents.length > 0 ? "configured" : "missing",
      components: configuredComponents,
    };
  });
}

export function activeStagingRefreshOverlaps(runs, currentRunId = null) {
  const overlapNames = new Set(stagingRefreshOverlapWorkflowNames);
  return runs
    .filter(
      (run) =>
        run.status !== "completed" &&
        String(run.databaseId) !== String(currentRunId ?? "") &&
        overlapNames.has(run.name),
    )
    .map((run) => ({ name: run.name, status: run.status, url: run.url, databaseId: run.databaseId }));
}

function normalized(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function matchingExpectedOption(items, selection) {
  const expectedLabels = new Set(selection.labels.map(normalized));
  const expectedValues = new Set(selection.values.map(normalized));
  return (
    items.find((item) => expectedLabels.has(normalized(item.label)) || expectedValues.has(normalized(item.value))) ??
    null
  );
}

export async function findExpectedOptionAcrossPages(selection, loadPage) {
  let cursor = null;
  let pageCount = 0;
  let optionCount = 0;
  do {
    const page = await loadPage(cursor);
    pageCount += 1;
    const items = Array.isArray(page.items) ? page.items : [];
    optionCount += items.length;
    const match = matchingExpectedOption(items, selection);
    if (match) {
      return { match, pageCount, optionCount };
    }
    cursor = page.page?.hasMore ? (page.page.nextCursor ?? null) : null;
  } while (cursor && pageCount < MAX_OPTION_PAGES);
  return { match: null, pageCount, optionCount };
}

async function githubSecretMetadata(options, run = execFile) {
  const endpoint = `repos/${options.repository}/environments/${encodeURIComponent(options.environment)}/secrets`;
  const { stdout } = await run("gh", [
    "api",
    endpoint,
    "--paginate",
    "--jq",
    ".secrets[] | [.name,.updated_at] | @tsv",
  ]);
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, updatedAt] = line.split("\t");
      return { name, updatedAt: updatedAt || null };
    });
}

async function githubActiveRuns(options, run = execFile) {
  const { stdout } = await run("gh", [
    "run",
    "list",
    "--repo",
    options.repository,
    "--limit",
    "100",
    "--json",
    "databaseId,name,status,url",
  ]);
  return JSON.parse(stdout);
}

async function digitalOceanDeployedSecrets(options, run = execFile) {
  const commandOptions = { maxBuffer: 20 * 1024 * 1024 };
  const { stdout: listOutput } = await run("doctl", ["apps", "list", "--output", "json"], commandOptions);
  const apps = JSON.parse(listOutput);
  const appSummary = apps.find((app) => app?.spec?.name === options.digitalOceanAppName);
  if (!appSummary?.id) {
    throw new Error("digitalocean-staging-app-not-found");
  }
  const { stdout: getOutput } = await run("doctl", ["apps", "get", appSummary.id, "--output", "json"], commandOptions);
  const response = JSON.parse(getOutput);
  const app = Array.isArray(response) ? response[0] : response;
  return deployedSecretPostureFromApp(app);
}

async function fetchJson(url, init, fetchImpl) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    let code = "unknown";
    try {
      code = (await response.json())?.error?.code ?? code;
    } catch {
      // Status and support-safe error code are enough; never echo an upstream body.
    }
    throw new Error(`request-failed:${response.status}:${code}`);
  }
  return response.json();
}

async function signIn(options, fetchImpl) {
  const body = await fetchJson(
    new URL("/api/auth/password-sign-in", options.adminBaseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: options.adminEmail, password: options.adminPassword }),
    },
    fetchImpl,
  );
  if (!body.sessionToken) {
    throw new Error("admin-sign-in-session-token-missing");
  }
  return `${SESSION_COOKIE_NAME}=${body.sessionToken}`;
}

async function optionPage(options, cookie, query, fetchImpl) {
  const url = new URL("/api/catalog/source-observations/integration-options", options.adminBaseUrl);
  for (const [name, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  return fetchJson(url, { headers: { cookie } }, fetchImpl);
}

export async function inspectSetMatrix(options, cookie, fetchImpl = fetch) {
  const cache = new Map();
  const results = [];
  for (const check of stagingRefreshSetMatrix) {
    if (check.providerKey === "scrydex" && !options.allowCreditedProviderReads) {
      results.push({
        id: check.id,
        productLine: check.productLine,
        providerKey: check.providerKey,
        state: "human-gated",
        reason: "credited-provider-read-not-approved",
        units: check.unitKeys.map((unitKey) => ({ unitKey, state: "human-gated" })),
      });
      continue;
    }

    const unitResults = [];
    for (const unitKey of check.unitKeys) {
      const selected = [];
      let failedSelection = null;
      let totalPages = 0;
      for (const selection of check.selections) {
        const languageCode = selection.languageFrom === undefined ? null : selected[selection.languageFrom]?.value;
        const parentValue = selection.parentFrom === undefined ? null : selected[selection.parentFrom]?.value;
        const baseQuery = {
          providerKey: check.providerKey,
          ingestionUnitKey: unitKey,
          queryKind: selection.queryKind,
          languageCode,
          parentValue,
          limit: 100,
          forceRefresh: true,
        };
        let found;
        try {
          found = await findExpectedOptionAcrossPages(selection, async (cursor) => {
            const cacheKey = JSON.stringify({ ...baseQuery, cursor });
            if (!cache.has(cacheKey)) {
              cache.set(cacheKey, optionPage(options, cookie, { ...baseQuery, cursor }, fetchImpl));
            }
            return cache.get(cacheKey);
          });
        } catch (error) {
          failedSelection = {
            queryKind: selection.queryKind,
            expectedLabels: selection.labels,
            expectedValues: selection.values,
            inspectedPages: 0,
            inspectedOptions: 0,
            diagnostic: error instanceof Error ? error.message : "option-query-failed",
          };
          break;
        }
        totalPages += found.pageCount;
        if (!found.match) {
          failedSelection = {
            queryKind: selection.queryKind,
            expectedLabels: selection.labels,
            expectedValues: selection.values,
            inspectedPages: found.pageCount,
            inspectedOptions: found.optionCount,
          };
          break;
        }
        selected.push({ label: found.match.label, value: found.match.value });
      }
      unitResults.push({
        unitKey,
        state: failedSelection ? "missing" : "confirmed",
        selected,
        inspectedPages: totalPages,
        ...(failedSelection ? { missingSelection: failedSelection } : {}),
      });
    }
    results.push({
      id: check.id,
      productLine: check.productLine,
      providerKey: check.providerKey,
      state: unitResults.every((unit) => unit.state === "confirmed") ? "confirmed" : "missing",
      units: unitResults,
    });
  }
  return results;
}

async function inspectAdmin(options, fetchImpl) {
  const cookie = await signIn(options, fetchImpl);
  if (!options.allowCreditedProviderReads) {
    const matrix = await inspectSetMatrix(options, cookie, fetchImpl);
    return { providerPosture: null, matrix, errors: [] };
  }
  let providerPosture = null;
  const errors = [];
  try {
    const overview = await fetchJson(
      new URL(
        "/api/catalog/source-observations/integration-control-plane/overview?audience=daily",
        options.adminBaseUrl,
      ),
      { headers: { cookie } },
      fetchImpl,
    );
    providerPosture = evaluateProviderPosture(overview);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "provider-readiness-query-failed");
  }
  const matrix = await inspectSetMatrix(
    {
      ...options,
      // The explicit operator approval authorizes the posture read. Additional
      // live Scrydex option reads proceed only after that read says credits are available.
      allowCreditedProviderReads: providerPosture?.scrydexCreditCategory === "available",
    },
    cookie,
    fetchImpl,
  );
  return { providerPosture, matrix, errors };
}

function reportFindings({ secretPosture, deployedSecretPosture, overlaps, admin, collectionErrors, options }) {
  const blockers = [];
  const humanGates = [];

  for (const secret of secretPosture) {
    if (secret.metadataState === "missing" || secret.valueState === "invalid") {
      blockers.push(`credential:${secret.name}:${secret.metadataState === "missing" ? "missing" : "invalid-mode"}`);
    } else if (secret.valueState === "not-inspectable") {
      humanGates.push(`credential:${secret.name}:verify-value-kind`);
    }
  }
  for (const secret of deployedSecretPosture) {
    if (secret.state === "missing") {
      blockers.push(`deployed-credential:${secret.name}:missing`);
    }
  }
  for (const overlap of overlaps) {
    blockers.push(`overlap:${overlap.name}:${overlap.status}`);
  }
  if (!options.skipOverlapCheck && !options.scheduledOverlapConfirmed) {
    humanGates.push("overlap:confirm-no-scheduled-staging-evidence-window");
  }
  if (collectionErrors.length > 0) {
    humanGates.push(...collectionErrors.map((error) => `collection:${error}`));
  }
  if (admin === null && !options.skipAdminChecks) {
    humanGates.push("admin:credentials-required-for-live-readiness-and-matrix");
  }
  for (const provider of admin?.providerPosture?.credentialPosture ?? []) {
    if (provider.readiness === "blocked" || provider.credentialReadiness === "blocked") {
      blockers.push(`provider:${provider.providerKey}:blocked`);
    } else if (provider.readiness === "unknown" || provider.credentialReadiness === "unknown") {
      humanGates.push(`provider:${provider.providerKey}:readiness-unknown`);
    }
  }
  const creditCategory = admin?.providerPosture?.scrydexCreditCategory ?? "unknown";
  if (creditCategory === "low" || creditCategory === "exhausted") {
    blockers.push(`scrydex-credit:${creditCategory}`);
  } else if (!options.skipAdminChecks && creditCategory === "unknown") {
    humanGates.push("scrydex-credit:approved-read-required");
  }
  for (const check of admin?.matrix ?? []) {
    if (check.state === "missing") {
      blockers.push(`matrix:${check.id}:missing`);
    } else if (check.state === "human-gated") {
      humanGates.push(`matrix:${check.id}:credited-read-required`);
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueHumanGates = [...new Set(humanGates)];
  return {
    schemaVersion: STAGING_REFRESH_PREFLIGHT_VERSION,
    generatedAt: new Date().toISOString(),
    environment: options.environment,
    result: uniqueBlockers.length > 0 ? "blocked" : uniqueHumanGates.length > 0 ? "human-gated" : "pass",
    credentialPosture: secretPosture,
    deployedCredentialPosture: deployedSecretPosture,
    providerPosture: admin?.providerPosture?.credentialPosture ?? [],
    scrydexCreditCategory: creditCategory,
    matrix: admin?.matrix ?? [],
    overlaps,
    blockers: uniqueBlockers,
    humanGates: uniqueHumanGates,
  };
}

export async function runStagingRefreshPreflight(options, dependencies = {}) {
  const run = dependencies.execFile ?? execFile;
  const fetchImpl = dependencies.fetch ?? fetch;
  const collectionErrors = [];
  let secretMetadata = [];
  let deployedSecretPosture = [];
  let runs = [];

  if (!options.skipGithubMetadata) {
    try {
      secretMetadata = await githubSecretMetadata(options, run);
    } catch {
      collectionErrors.push("github-secret-metadata-unavailable");
    }
  } else {
    secretMetadata = stagingRefreshRequiredSecrets
      .filter((secret) => Boolean(process.env[secret.name]))
      .map((secret) => ({ name: secret.name, updatedAt: null }));
  }
  if (!options.skipDoctl) {
    try {
      deployedSecretPosture = await digitalOceanDeployedSecrets(options, run);
    } catch {
      collectionErrors.push("digitalocean-deployed-credential-metadata-unavailable");
    }
  }
  if (!options.skipOverlapCheck) {
    try {
      runs = await githubActiveRuns(options, run);
    } catch {
      collectionErrors.push("github-run-overlap-unavailable");
    }
  }

  let admin = null;
  if (!options.skipAdminChecks && options.adminEmail && options.adminPassword) {
    try {
      admin = await inspectAdmin(options, fetchImpl);
      collectionErrors.push(...admin.errors);
    } catch (error) {
      collectionErrors.push(error instanceof Error ? error.message : "admin-preflight-failed");
    }
  }

  return reportFindings({
    secretPosture: evaluateStagingRefreshSecrets(secretMetadata),
    deployedSecretPosture,
    overlaps: activeStagingRefreshOverlaps(runs, options.currentRunId),
    admin,
    collectionErrors,
    options,
  });
}

async function main() {
  const options = parseStagingRefreshPreflightArgs(process.argv.slice(2));
  const report = await runStagingRefreshPreflight(options);
  const serialized = JSON.stringify(report, null, 2);
  if (options.outPath) {
    writeFileSync(options.outPath, `${serialized}\n`);
  }
  console.log(serialized);
  process.exitCode = report.result === "pass" ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
