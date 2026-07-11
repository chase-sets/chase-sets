#!/usr/bin/env node
// Renders per-component .env files for the CI compose boot+smoke job:
// containerized platform-api + platform-worker + the three web
// deployables, against real compose Postgres, using the SAME production
// image, command, and env-var *names* the Helm chart deploys to
// preview/staging/production (buildPlatformHelmValues). Only the *values*
// differ: every `secret: true` entry gets a safe, non-functional
// placeholder (or the compose Postgres URL for anything DB-shaped) instead
// of a real provider credential, so this job needs no cloud secrets at all
// and is safe to run on every app-code PR, including forks.
//
// This intentionally reuses buildPlatformHelmValues instead of hand-writing
// a docker-compose environment block: that function is the single source of
// truth for "what env vars does each component need," and hand-copying ~90
// entries per component into YAML would drift the moment the Helm chart's
// env list changes.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readOption } from "./lib/cli-options.mjs";
import { buildPlatformHelmValues } from "./render-platform-helm-values.mjs";

// `sslmode=disable` is required, not cosmetic: infrastructure/event-core-postgres/pool.ts
// only skips SSL for a literal localhost/127.0.0.1/::1 hostname, and
// defaults to verifying SSL for anything else (matching managed Postgres in
// preview/staging/production). The compose Postgres service is reached by
// its compose service name ("postgres"), which fails that check, so without
// this parameter every component's pg pool tries -- and fails -- a TLS
// handshake against a plain compose Postgres container.
export const composeSmokePostgresUrl = "postgresql://postgres:postgres@postgres:5432/chase_sets?sslmode=disable";
export const composeSmokeInternalAuthSecret = "compose-smoke-internal-auth-secret";
export const composeSmokeAdminEmail = "compose-smoke@chasesets.test";
export const composeSmokeAdminPassword = "compose-smoke-not-a-real-secret";
export const composeSmokePlatformApiOrigin = "http://platform-api:8080";
// Deliberately narrower than preview's
// "critical-bootstrap,catalog-integration-bootstrap": the admin identity
// platform-smoke.mjs signs in with is seeded unconditionally in
// bootstrap.ts (bootstrapPlatformAdminIdentity/-Password run outside the
// data-profile step), so critical-bootstrap alone is enough to boot and
// smoke-check. catalog-integration-bootstrap seeds a large enough catalog
// dataset that, with the wake signal disabled below, platform-worker's
// round-robin projection catch-up can take several minutes to cycle back to
// unrelated contexts (public-presence) this job's read-after-write waitlist
// check needs -- adding minutes of flakiness-prone wait for a data profile
// this job's assertions never exercise.
export const composeSmokeDataProfiles = "critical-bootstrap";

const defaultOrigins = {
  landingOrigin: "http://localhost:18180",
  marketplaceOrigin: "http://localhost:18181",
  adminOrigin: "http://localhost:18182",
};

// Values a change here would flip from "not configured" to "looks
// configured but is fake," which risks a component attempting a real
// outbound call with a placeholder credential. Every one of these is
// already tolerated empty by the real preview deploy (see the optional
// `TF_VAR_*_key: secrets.X || ''` fallbacks in platform-pr.yml), so leaving
// them empty here matches proven preview behavior instead of inventing new
// untested fallback paths.
const emptySecretNames = new Set([
  "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "CATALOG_ASSET_S3_ACCESS_KEY_ID",
  "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
  "VOYAGE_API_KEY",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_ID",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET",
  "FACEBOOK_SOCIAL_LOGIN_CLIENT_ID",
  "FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET",
  "SES_AWS_ACCESS_KEY_ID",
  "SES_AWS_SECRET_ACCESS_KEY",
  "SES_SOURCE_ARN",
  "TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE",
  "SCRYDEX_API_KEY",
  "SCRYDEX_TEAM_ID",
]);

// Every one of these IS required for the real app to boot (unlike the
// optional providers above), so it needs a present-but-fake value rather
// than an empty one.
const placeholderSecretValues = {
  PLATFORM_INTERNAL_AUTH_SECRET: composeSmokeInternalAuthSecret,
  PLATFORM_ADMIN_EMAIL: composeSmokeAdminEmail,
  PLATFORM_ADMIN_PASSWORD: composeSmokeAdminPassword,
  STRIPE_SECRET_KEY: "sk_test_compose_smoke_placeholder",
  STRIPE_PUBLISHABLE_KEY: "pk_test_compose_smoke_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_compose_smoke_placeholder",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_compose_smoke_placeholder",
  EASYPOST_API_KEY: "EZTK_compose_smoke_placeholder",
  CHASE_SETS_DISCORD_INVITE_URL: "https://discord.gg/compose-smoke-placeholder",
};

function composeSmokeSecretValue(name) {
  if (name.includes("DATABASE_URL")) {
    return composeSmokePostgresUrl;
  }
  if (name in placeholderSecretValues) {
    return placeholderSecretValues[name];
  }
  if (emptySecretNames.has(name)) {
    return "";
  }
  // Unrecognized secret: default to empty rather than a fake non-empty
  // value, so an unexercised provider stays visibly "not configured"
  // instead of silently attempting a real call with garbage credentials.
  return "";
}

function valueOverridesFor(origins) {
  return {
    CHASE_SETS_INTERNAL_API_ORIGIN: composeSmokePlatformApiOrigin,
    CHASE_SETS_PUBLIC_ORIGIN: origins.landingOrigin,
    CHASE_SETS_MARKETPLACE_ORIGIN: origins.marketplaceOrigin,
    CATALOG_ASSET_STORAGE_KIND: "filesystem",
    CATALOG_ASSET_PUBLIC_BASE_URL: `${origins.landingOrigin}/catalog-assets`,
  };
}

// Present in preview's runtime-env overrides at deploy time
// (platform-kubernetes-deployment.mjs), not in the base Helm values, so
// they must be added rather than substituted.
const additionalEnvByComponent = {
  "platform-bootstrap": [{ name: "PLATFORM_DATA_PROFILES", value: composeSmokeDataProfiles }],
};

export function buildComposeSmokeValues(options = {}) {
  const values = structuredClone(options.values ?? buildPlatformHelmValues({ repoRoot: options.repoRoot }));
  const origins = { ...defaultOrigins, ...options.origins };
  const overrides = valueOverridesFor(origins);

  for (const [name, component] of Object.entries(values.components ?? {})) {
    const rendered = (component.env ?? []).map((entry) => toComposeSmokeEnvEntry(entry, overrides));
    for (const extra of additionalEnvByComponent[name] ?? []) {
      rendered.push(extra);
    }
    component.env = rendered;
  }

  return values;
}

function toComposeSmokeEnvEntry(entry, overrides) {
  if (entry.name in overrides) {
    return { name: entry.name, value: overrides[entry.name] };
  }
  if (!entry.secret) {
    return entry;
  }
  return { name: entry.name, value: composeSmokeSecretValue(entry.name) };
}

export function renderComposeSmokeEnvFile(componentName, options = {}) {
  const values = options.values ?? buildComposeSmokeValues(options);
  const component = values.components?.[componentName];
  if (!component) {
    throw new Error(`Unknown platform Helm component: ${componentName}`);
  }
  const lines = component.env.map((entry) => `${entry.name}=${entry.value ?? ""}`);
  return `${lines.join("\n")}\n`;
}

export function composeSmokeComponentNames(options = {}) {
  const values = options.values ?? buildComposeSmokeValues(options);
  return Object.keys(values.components ?? {});
}

function parseArgs(argv) {
  const command = argv[0];
  const component = readOption(argv, "--component");
  const outPath = readOption(argv, "--out");
  const outDir = readOption(argv, "--out-dir");
  const landingOrigin = readOption(argv, "--landing-origin") ?? defaultOrigins.landingOrigin;
  const marketplaceOrigin = readOption(argv, "--marketplace-origin") ?? defaultOrigins.marketplaceOrigin;
  const adminOrigin = readOption(argv, "--admin-origin") ?? defaultOrigins.adminOrigin;

  return {
    command,
    component,
    outPath,
    outDir,
    origins: { landingOrigin, marketplaceOrigin, adminOrigin },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const values = buildComposeSmokeValues({ origins: options.origins });

  if (options.command === "render-env") {
    if (!options.component || !options.outPath) {
      throw new Error("Usage: node ./scripts/platform-compose-smoke.mjs render-env --component <name> --out <path>");
    }
    const rendered = renderComposeSmokeEnvFile(options.component, { values });
    mkdirSync(path.dirname(options.outPath), { recursive: true });
    writeFileSync(options.outPath, rendered);
    console.log(`Wrote ${options.component} compose-smoke env to ${options.outPath}.`);
    return;
  }

  if (options.command === "render-env-all") {
    if (!options.outDir) {
      throw new Error("Usage: node ./scripts/platform-compose-smoke.mjs render-env-all --out-dir <dir>");
    }
    mkdirSync(options.outDir, { recursive: true });
    for (const componentName of composeSmokeComponentNames({ values })) {
      const rendered = renderComposeSmokeEnvFile(componentName, { values });
      const outPath = path.join(options.outDir, `${componentName}.env`);
      writeFileSync(outPath, rendered);
      console.log(`Wrote ${componentName} compose-smoke env to ${outPath}.`);
    }
    return;
  }

  throw new Error(
    "Usage: node ./scripts/platform-compose-smoke.mjs <render-env|render-env-all> [--component <name>] [--out <path>] [--out-dir <dir>] [--landing-origin <url>] [--marketplace-origin <url>] [--admin-origin <url>]",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
