import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { listContextManifests, repoRoot } from "../lib/repo.mjs";
import { validateGlossaryCoverage } from "./glossary-coverage.mjs";
import { syncWorkspaceMetadata } from "../sync-workspace-metadata.mjs";
import { findSchemaMigrationDdlSafetyViolationsInSource } from "./boot-schema-ddl-discipline.mjs";
import {
  requireSourceContextWakeRegistryEntry,
  sourceContextWakeRegistry,
  summarizeSourceContextWakeRegistry,
} from "../../infrastructure/platform-runtime/source-context-wake-registry.ts";
import {
  findTestSupportImportViolations,
  hasValidTestSupportDeclaration,
  isAllowedDeployableBoundedContextImport,
  isAllowedPublicExportName,
  walk,
} from "./run.mjs";
import { runImportBoundaryValidation } from "./phases.mjs";

const channelsRoot = path.join(repoRoot, "bounded-contexts/channels");
const manifestPath = path.join(channelsRoot, "context.json");
const packagePath = path.join(channelsRoot, "package.json");
const baselinePath = path.join(repoRoot, "scripts/check-structure/glossary-coverage-baseline.json");
const registryPaths = [
  "deployables/platform-api/src/generated/api-context-registry.ts",
  "deployables/platform-worker/src/generated/worker-context-registry.ts",
  "deployables/admin-web/app/generated/web-context-registry.ts",
  "deployables/marketplace/app/generated/web-context-registry.ts",
  "deployables/public-web/app/generated/web-context-registry.ts",
];
const requiredRootFiles = [
  "api.ts",
  "GLOSSARY.md",
  "README.md",
  "client.ts",
  "context.json",
  "index.ts",
  "package.json",
  "server.ts",
];
const requiredReadmeSections = [
  "## Purpose",
  "## Owns",
  "## Does Not Own",
  "## Ubiquitous Language",
  "## Core Aggregates and Process Managers",
  "## Incoming Dependencies",
  "## Outgoing Integration Events",
  "## Invariants",
];
const tempRoots = [];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeSource(root, relativePath, content) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function createTempRepo(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(root, absolute) : [path.relative(root, absolute).replaceAll("\\", "/")];
    })
    .sort();
}

function readRegistryBytes(root) {
  return Object.fromEntries(
    registryPaths.map((relativePath) => [relativePath, readFileSync(path.join(root, relativePath))]),
  );
}

function collectChannelsSurfaceViolations(candidate, relativeFiles) {
  const violations = [];
  const rootFiles = relativeFiles.filter((file) => !file.includes("/")).sort();
  if (JSON.stringify(rootFiles) !== JSON.stringify([...requiredRootFiles].sort())) violations.push("root-files");
  if (!relativeFiles.some((file) => file.startsWith("features/connections/"))) violations.push("connections-files");
  if (!relativeFiles.some((file) => file.startsWith("features/credentials/"))) violations.push("credentials-files");
  if (!relativeFiles.some((file) => file.startsWith("features/connector-client/"))) {
    violations.push("connector-client-files");
  }
  if (!relativeFiles.some((file) => file.startsWith("features/publication-port/"))) {
    violations.push("publication-port-files");
  }
  if (!relativeFiles.some((file) => file.startsWith("features/listing-composition/"))) {
    violations.push("listing-composition-files");
  }
  if (!relativeFiles.some((file) => file.startsWith("features/outbound-sync/"))) {
    violations.push("outbound-sync-files");
  }
  if (!relativeFiles.some((file) => file.startsWith("support/request-support/"))) {
    violations.push("request-support-files");
  }
  if (!relativeFiles.some((file) => file.startsWith("support/runtime-support/"))) {
    violations.push("runtime-support-files");
  }
  if (
    relativeFiles.some(
      (file) =>
        file.startsWith("features/connector-client/") &&
        !/^features\/connector-client\/(?:(?:domain|tests)\/|integrations\/raw-export-indexeddb\.ts$|integrations\/order-(?:authority|detection-pagination)-probe\/(?:package\.mjs|manifest\.json|worker\.js|helper\.js|capture\.html|capture\.test\.ts)$)/.test(
          file,
        ),
    )
  ) {
    violations.push("connector-client-buckets");
  }
  if (
    relativeFiles.some(
      (file) =>
        file.startsWith("features/connections/") &&
        !/^features\/connections\/(?:api|domain|integrations|read-model|tests|ui)\//.test(file),
    )
  ) {
    violations.push("connections-buckets");
  }
  if (
    relativeFiles.some(
      (file) =>
        file.startsWith("features/publication-port/") &&
        !/^features\/publication-port\/(?:api|domain|tests)\//.test(file),
    )
  ) {
    violations.push("publication-port-buckets");
  }
  if (
    relativeFiles.some(
      (file) =>
        file.startsWith("features/listing-composition/") &&
        !/^features\/listing-composition\/(?:api|domain|integrations|read-model|tests|ui)\//.test(file),
    )
  ) {
    violations.push("listing-composition-buckets");
  }
  if (
    relativeFiles.some(
      (file) =>
        file.startsWith("features/outbound-sync/") &&
        !/^features\/outbound-sync\/(?:api|domain|integrations|read-model|tests|ui)\//.test(file),
    )
  ) {
    violations.push("outbound-sync-buckets");
  }
  if (!relativeFiles.some((file) => file.startsWith("features/connection-health/")))
    violations.push("connection-health-files");
  if (!relativeFiles.some((file) => file.startsWith("features/connection-attention/")))
    violations.push("connection-attention-files");
  if (
    relativeFiles.some(
      (file) =>
        file.startsWith("features/manual-sync/") &&
        !/^features\/manual-sync\/(?:api|domain|read-model|ui)\//.test(file),
    )
  ) {
    violations.push("manual-sync-buckets");
  }
  const absentManifestFields = [
    "sourceRuntimeDeployables",
    "sourceRuntimeProfiles",
    "mcpCapabilities",
    "accountCapabilities",
  ];

  for (const field of absentManifestFields) {
    if (field in candidate) violations.push(field);
  }
  if (
    JSON.stringify((candidate.readAfterWriteRouteInventory ?? []).map((entry) => entry.id)) !==
    JSON.stringify(["channels.publication-settings-to-detail"])
  ) {
    violations.push("readAfterWriteRouteInventory");
  }
  if (
    JSON.stringify(candidate.allowedContextDependencies) !==
    JSON.stringify(["@chase-sets/marketplace", "@chase-sets/inventory", "@chase-sets/auth"])
  ) {
    violations.push("allowedContextDependencies");
  }
  if (JSON.stringify(candidate.seedRequirements) !== JSON.stringify(["inventory"])) {
    violations.push("seedRequirements");
  }
  if (
    JSON.stringify(candidate.hostPorts) !==
    JSON.stringify([
      {
        portName: "connectorOAuth",
        providedBy: "platform-api",
        purpose: "Use Auth's separate connection-bound connector grant mechanism without resolving agent authority.",
      },
      {
        portName: "marketplaceChannelInboundClamp",
        providedBy: "platform-api, platform-worker",
        purpose:
          "Ask Marketplace to pause every active account Listing represented by a genuine Channel Sync Run while inbound coverage is dark.",
      },
      {
        portName: "channelSaleRecorder",
        providedBy: "inventory",
        purpose:
          "Bind Inventory's typed account-scoped external Channel sale recorder for inline missed-sale reconciliation.",
      },
      {
        portName: "channelCredentialKeyring",
        providedBy: "platform-api, platform-worker",
        purpose:
          "Supply the shared parsed Channels credential keyring; absent configuration leaves custody unavailable.",
      },
    ])
  ) {
    violations.push("hostPorts");
  }
  if (
    JSON.stringify(candidate.slices) !==
    JSON.stringify([
      "connector-feed",
      "connections",
      "credentials",
      "connector-client",
      "publication-port",
      "listing-composition",
      "tcgplayer-csv",
      "tcgplayer-orders",
      "order-fulfillment-observations",
      "outbound-sync",
      "connection-health",
      "connection-attention",
      "manual-sync",
      "reconciliation",
    ])
  ) {
    violations.push("slices");
  }
  if (
    JSON.stringify(candidate.allowedSupportDirectories) !==
    JSON.stringify(["request-support", "runtime-support", "seed-support"])
  ) {
    violations.push("allowedSupportDirectories");
  }
  if (candidate.eventSubscriptions?.length !== 6) violations.push("eventSubscriptions");
  if (candidate.eventReactions?.length !== 6) violations.push("eventReactions");
  if (candidate.deployableContributions?.[0]?.routes?.length !== 5) violations.push("deployableContributions");
  if (candidate.shellContributions?.[0]?.requiredPermissions?.[0] !== "channels.view")
    violations.push("shellContributions");
  if (JSON.stringify(candidate.apiDeployables) !== JSON.stringify(["platform-api"])) violations.push("apiDeployables");
  if (JSON.stringify(candidate.runtimeDeployables) !== JSON.stringify(["platform-worker"])) {
    violations.push("runtimeDeployables");
  }
  if (JSON.stringify(candidate.apiRuntimeProfiles) !== JSON.stringify(["proof", "public"])) {
    violations.push("apiRuntimeProfiles");
  }
  if (JSON.stringify(candidate.workerRuntimeProfiles) !== JSON.stringify(["proof", "public"])) {
    violations.push("workerRuntimeProfiles");
  }
  if (candidate.apiRuntimeProfiles?.includes("landing") || candidate.workerRuntimeProfiles?.includes("landing")) {
    violations.push("landing");
  }

  return violations.sort();
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("channels-context-foundation", () => {
  it("enrols credential DB proofs and guards their boot/migration parity", () => {
    const scripts = readJson(packagePath).scripts;
    for (const name of ["store", "rotation", "schema"]) {
      const test = `features/credentials/tests/channel-credential-${name}.db.test.ts`;
      expect(scripts["test:db"].split(/\s+/).filter((argument) => argument === test)).toHaveLength(1);
      expect(scripts["test:unit"]).toContain(`--exclude ${test}`);
    }
    const source = readFileSync(path.join(channelsRoot, "features/credentials/read-model/schema.ts"), "utf8");
    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([]);
    expect(
      findSchemaMigrationDdlSafetyViolationsInSource(source.replaceAll("INDEX CONCURRENTLY IF", "INDEX IF")),
    ).toHaveLength(1);
    expect(
      collectChannelsSurfaceViolations(
        readJson(manifestPath),
        listFiles(channelsRoot).filter((file) => !file.startsWith("features/credentials/")),
      ),
    ).toEqual(["credentials-files"]);
  });
  it("proves actual attention migration indexes are concurrent and rejects their omission", () => {
    const source = readFileSync(path.join(channelsRoot, "features/connection-attention/read-model/schema.ts"), "utf8");
    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([]);
    expect(
      findSchemaMigrationDdlSafetyViolationsInSource(source.replaceAll("INDEX CONCURRENTLY IF", "INDEX IF")),
    ).toHaveLength(2);
  });
  it("enrols every attention DB proof and refuses a missing production slice", () => {
    const scripts = readJson(packagePath).scripts;
    for (const name of [
      "channel-attention-lifecycle",
      "channel-action-source-contract",
      "channel-attention-schema-upgrade",
    ]) {
      const test = `features/connection-attention/tests/${name}.db.test.ts`;
      expect(scripts["test:db"].split(/\s+/).filter((argument) => argument === test)).toHaveLength(1);
      expect(scripts["test:unit"]).toContain(`--exclude ${test}`);
    }
    expect(
      collectChannelsSurfaceViolations(
        readJson(manifestPath),
        listFiles(channelsRoot).filter((file) => !file.startsWith("features/connection-attention/")),
      ),
    ).toEqual(["connection-attention-files"]);
  });
  it("enrols all connection-health DB proofs and refuses a missing production slice", () => {
    const scripts = readJson(packagePath).scripts;
    for (const name of ["observation-idempotency", "policy-revision", "generation-interleavings"]) {
      const test = `features/connection-health/tests/channel-health-${name}.db.test.ts`;
      expect(scripts["test:db"].split(/\s+/).filter((argument) => argument === test)).toHaveLength(1);
      expect(scripts["test:unit"]).toContain(`--exclude ${test}`);
    }
    expect(
      collectChannelsSurfaceViolations(
        readJson(manifestPath),
        listFiles(channelsRoot).filter((file) => !file.startsWith("features/connection-health/")),
      ),
    ).toEqual(["connection-health-files"]);
  });
  it("enrols real service composition in the DB profile and excludes it from unit runs", () => {
    const scripts = readJson(packagePath).scripts;
    const test = "tests/channels-services-composition.db.test.ts";
    expect(scripts["test:db"].split(/\s+/).filter((argument) => argument === test)).toHaveLength(1);
    expect(scripts["test:unit"]).toContain(`--exclude ${test}`);
  });

  it("supersedes the foundation with the exact connection slice, module, finite tests, and README contract", () => {
    const manifest = readJson(manifestPath);
    expect(manifest).toMatchObject({
      contextName: "channels",
      packageName: "@chase-sets/channels",
      ownedNouns: expect.arrayContaining([
        "channel-connection",
        "channel-publication-facts",
        "channel-composition-profile",
        "channel-publication-settings",
        "channel-publication-eligibility",
        "channel-listing-desired-state",
        "channel-listing-reconciliation-run",
        "channel-inventory-snapshot",
        "channel-sync-run",
      ]),
      slices: [
        "connector-feed",
        "connections",
        "credentials",
        "connector-client",
        "publication-port",
        "listing-composition",
        "tcgplayer-csv",
        "tcgplayer-orders",
        "order-fulfillment-observations",
        "outbound-sync",
        "connection-health",
        "connection-attention",
        "manual-sync",
        "reconciliation",
      ],
      allowedSupportDirectories: ["request-support", "runtime-support", "seed-support"],
      publicExports: [".", "./client", "./context", "./server", "./test-support", "./routes/*", "./seed-support/*"],
      allowedContextDependencies: ["@chase-sets/marketplace", "@chase-sets/inventory", "@chase-sets/auth"],
      seedRequirements: ["inventory"],
      hostPorts: [
        {
          portName: "connectorOAuth",
          providedBy: "platform-api",
          purpose: "Use Auth's separate connection-bound connector grant mechanism without resolving agent authority.",
        },
        {
          portName: "marketplaceChannelInboundClamp",
          providedBy: "platform-api, platform-worker",
          purpose:
            "Ask Marketplace to pause every active account Listing represented by a genuine Channel Sync Run while inbound coverage is dark.",
        },
        {
          portName: "channelSaleRecorder",
          providedBy: "inventory",
          purpose:
            "Bind Inventory's typed account-scoped external Channel sale recorder for inline missed-sale reconciliation.",
        },
        {
          portName: "channelCredentialKeyring",
          providedBy: "platform-api, platform-worker",
          purpose:
            "Supply the shared parsed Channels credential keyring; absent configuration leaves custody unavailable.",
        },
      ],
    });
    expect(manifest.eventSubscriptions.map((entry) => entry.order)).toEqual([31, 10, 20, 30, 40, 50]);
    expect(manifest.eventSubscriptions.map((entry) => entry.sourceContextName)).toEqual([
      "inventory",
      "marketplace",
      "catalog",
      "inventory",
      "channels",
      "channels",
    ]);
    expect(manifest.eventReactions.map((entry) => entry.order)).toEqual([64, 65, 60, 61, 62, 63]);
    expect(manifest.deployableContributions[0].routes.map((route) => route.authorization.requiredPermissions)).toEqual([
      ["channels.view"],
      ["channels.view"],
      ["channels.view"],
      ["channels.manage"],
      ["channels.view"],
    ]);
    expect(manifest.shellContributions[0]).toMatchObject({
      key: "channels-publication",
      requiredPermissions: ["channels.view"],
    });
    expect(manifest).not.toEqual({
      contextName: "channels",
      packageName: "@chase-sets/channels",
      ownedNouns: ["channel-connection"],
      streamPrefix: "channels.",
      apiBasePath: "/api/channels",
      slices: ["connections", "publication-port", "outbound-sync"],
      allowedSupportDirectories: [],
      publicExports: [".", "./context", "./server", "./routes/*"],
      allowedContextDependencies: [],
      seedRequirements: [],
      hostPorts: [],
      projectionGroups: [
        {
          projectionName: "channel-connection-projection",
          sourceContextNames: ["channels"],
          ownedTables: ["channel_connections"],
          requiredDuringBootstrap: false,
          resetStrategy: "truncate-owned-tables",
        },
      ],
      apiDeployables: ["platform-api"],
      apiRuntimeProfiles: ["proof", "public"],
      apiMounts: [{ mountPath: "/api/channels", kind: "primary", requiresAuth: true }],
      workerRuntimeProfiles: ["proof", "public"],
      deployableContributions: [
        {
          deployable: "marketplace-web",
          routes: [
            {
              routeId: "account-channel-connection",
              routePath: "account/channels/:connectionId",
              fileExport: "./routes/marketplace/account-channel-connection",
              routeType: "route",
              sourceContext: "channels",
              delivery: "server-only",
              authorization: { kind: "authenticated", requiredPermissions: ["channels.view"] },
              canonicalLink: {
                kind: "not-applicable",
                reason: "Canonical-link publication is deferred with portable route extraction.",
              },
              availability: { web: true, mobile: false },
              pageComponentExport: "default",
              unsupportedMobile: {
                owner: "channels",
                followUp: "#7539",
                reason: "Portable connection detail operations have not been extracted.",
              },
            },
          ],
        },
      ],
      shellContributions: [],
      mutationConsistencyInventory: [
        {
          id: "channels.connection-command-snapshots",
          owner: "channels",
          risk: "important",
          strategy: "snapshot-return",
          surfaces: [
            "api-route:bounded-contexts/channels/features/connections/api/route.ts:POST /:id/pause",
            "api-route:bounded-contexts/channels/features/connections/api/route.ts:POST /:id/resume",
            "api-route:bounded-contexts/channels/features/connections/api/route.ts:POST /:id/disconnect",
          ],
          visibleDestination: {
            description:
              "Each public Channel Connection mutation returns the committed aggregate snapshot without waiting for or rereading the asynchronous projection.",
          },
          proof: {
            authoritativeResponse:
              "The route maps CommandExecutionResult.state directly to the closed public DTO for writes and accepted no-ops.",
            tests: [
              "bounded-contexts/channels/features/connections/tests/channel-connection-http-contract.test.ts",
              "bounded-contexts/channels/features/connections/tests/channel-connection-command-snapshot-responses.test.ts",
            ],
          },
        },
      ],
      directoryIntent: {
        connections: {
          classification: "slice",
          purpose: "Own the connections slice lifecycle, setup authority, HTTP contract, and projection.",
          expectedConsumers: ["Internal Channels module composition"],
        },
        "publication-port": {
          classification: "slice",
          purpose: "Own the Channels publication-port contract and immutable provider registry.",
          expectedConsumers: ["Internal Channels publication workflows and provider integrations"],
        },
        "outbound-sync": {
          classification: "slice",
          purpose:
            "Own Channels outbound-sync operations, execution admission, leases, and connection-scoped activity.",
          expectedConsumers: ["Internal Channels module composition", "Channel connector and manual claim workflows"],
        },
        "runtime-support": {
          classification: "support",
          purpose: "Own the context-level Channels runtime service composition contract.",
          expectedConsumers: ["credentials"],
        },
        routes: {
          classification: "routes",
          purpose: "Expose Channels-owned account route modules consumed by generated deployable adapters.",
          expectedConsumers: ["Generated deployable route adapters"],
        },
      },
      runtimeDeployables: ["platform-worker"],
      localeCatalogs: ["contracts/localization/locales/en/channels.ts"],
    });
    const packageJson = readJson(packagePath);
    expect(packageJson).toMatchObject({
      name: "@chase-sets/channels",
      chaseSets: { testProfile: "db" },
      exports: {
        ".": "./index.ts",
        "./client": "./client.ts",
        "./context": "./context.json",
        "./server": "./server.ts",
        "./routes/*": "./routes/*.tsx",
      },
      dependencies: {
        "@chase-sets/design-system": "workspace:*",
        "@chase-sets/http": "workspace:*",
        "@chase-sets/localization": "workspace:*",
        "@chase-sets/primitives": "workspace:*",
      },
    });
    expect(packageJson).not.toEqual({
      name: "@chase-sets/channels",
      version: "0.1.0",
      private: true,
      type: "module",
      chaseSets: { testProfile: "db" },
      scripts: {
        test: "vitest run --config ./tests/vitest.config.mjs",
        "test:db":
          "vitest run --config ./tests/vitest.config.mjs features/connections/tests/channel-connection-setup-activation.db.test.ts features/connections/tests/channel-connection-projection-concurrency.db.test.ts features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
        "test:unit":
          "vitest run --config ./tests/vitest.config.mjs --exclude features/connections/tests/channel-connection-setup-activation.db.test.ts --exclude features/connections/tests/channel-connection-projection-concurrency.db.test.ts --exclude features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
        "test:watch": "vitest --config ./tests/vitest.config.mjs",
      },
      exports: {
        ".": "./index.ts",
        "./context": "./context.json",
        "./server": "./server.ts",
        "./routes/*": "./routes/*.tsx",
      },
      types: "./index.ts",
      dependencies: {
        "@chase-sets/bounded-context-module": "workspace:*",
        "@chase-sets/bounded-context-runtime": "workspace:*",
        "@chase-sets/design-system": "workspace:*",
        "@chase-sets/event-core": "workspace:*",
        "@chase-sets/event-core-postgres": "workspace:*",
        "@chase-sets/localization": "workspace:*",
        "@chase-sets/platform-policy": "workspace:*",
        "@chase-sets/platform-runtime": "workspace:*",
        "@chase-sets/primitives": "workspace:*",
        hono: "^4.12.12",
      },
    });
    expect(readFileSync(path.join(channelsRoot, "index.ts"), "utf8")).toContain("export const module =");

    const files = listFiles(channelsRoot);
    expect(files.filter((file) => !file.includes("/")).sort()).toEqual([...requiredRootFiles].sort());
    expect(files).toEqual(
      expect.arrayContaining([
        "features/connections/domain/domain.ts",
        "features/connections/api/route.ts",
        "features/connector-client/domain/identity.ts",
        "features/connector-client/domain/derive-chrome-extension-id.ts",
        "features/connector-client/tests/connector-client-public-surface.test.ts",
        "features/publication-port/api/registry.ts",
        "features/publication-port/domain/contracts.ts",
        "features/publication-port/domain/validation.ts",
        "features/outbound-sync/api/runtime.ts",
        "features/outbound-sync/read-model/schema.ts",
        "features/outbound-sync/ui/operation-log-loader.ts",
        "routes/marketplace/account-channels-connection.tsx",
        "features/outbound-sync/integrations/listing-composition.ts",
        "features/listing-composition/domain/compose.ts",
        "features/listing-composition/api/runtime.ts",
        "features/listing-composition/read-model/schema.ts",
        "routes/marketplace/account-channels-publication.tsx",
        "support/request-support/api-client.ts",
        "features/manual-sync/api/runtime.ts",
        "features/manual-sync/read-model/schema.ts",
        "routes/marketplace/account-channel-connection-manual-sync-download.tsx",
        "tests/vitest.config.mjs",
      ]),
    );

    const readme = readFileSync(path.join(channelsRoot, "README.md"), "utf8");
    const sectionOffsets = requiredReadmeSections.map((section) => readme.indexOf(section));
    expect(sectionOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(sectionOffsets).toEqual([...sectionOffsets].sort((left, right) => left - right));
    expect(readme).toContain("pnpm --filter @chase-sets/channels run test:watch");
  });
});

describe("channels glossary alias evidence", () => {
  it("passes synthetic channels.connection.connected coverage and kills the alias-removed mutant", () => {
    const root = createTempRepo("channels-glossary-");
    const liveBaseline = readJson(baselinePath);
    const channelsAliases = liveBaseline.aliases.filter(
      (entry) => entry.contextName === "channels" && entry.noun === "connection",
    );
    expect(channelsAliases).toEqual([
      {
        contextName: "channels",
        noun: "connection",
        terms: ["Channel Connection"],
        reason:
          "Channels events use the bounded connection stream noun while the ubiquitous term is the qualified Channel Connection.",
      },
    ]);

    writeSource(
      root,
      "bounded-contexts/channels/GLOSSARY.md",
      readFileSync(path.join(channelsRoot, "GLOSSARY.md"), "utf8"),
    );
    writeSource(root, "docs/GLOSSARY.md", readFileSync(path.join(repoRoot, "docs/GLOSSARY.md"), "utf8"));
    const syntheticBaseline = {
      issue: "#7558",
      owner: "Channels",
      reviewBy: "2026-09-03",
      reason: "Synthetic Channels connection-event alias evidence.",
      aliases: channelsAliases,
      allowlist: [],
    };
    writeJson(path.join(root, "scripts/check-structure/glossary-coverage-baseline.json"), syntheticBaseline);

    const contextManifests = new Map([
      [
        "bounded-contexts/channels",
        {
          root: "bounded-contexts/channels",
          manifest: {
            contextName: "channels",
            packageName: "@chase-sets/channels",
            ownedNouns: ["channel-connection"],
            events: ["channels.connection.connected"],
          },
          packageName: "@chase-sets/channels",
        },
      ],
    ]);
    const validate = () => validateGlossaryCoverage({ repoRoot: root, contextManifests });

    expect(validate().violations).toEqual([]);

    writeJson(path.join(root, "scripts/check-structure/glossary-coverage-baseline.json"), {
      ...syntheticBaseline,
      aliases: [],
    });
    expect(validate().violations).toContain(
      "channels.connection event noun is referenced by channels (channels.connection.connected) but bounded-contexts/channels/GLOSSARY.md has no term heading for 'connection'; event noun segments must resolve to the source context glossary",
    );
  });
});

describe("channels-foundation-deployable-registration", () => {
  it("registers Channels in API, worker, and its marketplace route host while excluding unrelated hosts", () => {
    const root = createTempRepo("channels-metadata-");
    writeJson(path.join(root, "tsconfig.base.json"), { compilerOptions: { paths: {} } });
    const fixtureManifestPath = path.join(root, "bounded-contexts/channels/context.json");
    const manifest = readJson(manifestPath);
    const packageJson = readJson(packagePath);
    writeJson(fixtureManifestPath, manifest);
    const trackedLocaleFile = "contracts/localization/locales/en/channels.ts";
    writeSource(root, trackedLocaleFile, 'export const channels = { "channels.example": "Example" } as const;\n');

    const common = { rootDir: root, trackedLocaleFiles: [trackedLocaleFile] };
    syncWorkspaceMetadata({ ...common, workspaces: [] });
    const before = readRegistryBytes(root);
    const channelsWorkspace = {
      name: "@chase-sets/channels",
      dir: path.join(root, "bounded-contexts/channels"),
      dirName: "channels",
      root: "bounded-contexts",
      packageJson,
    };
    syncWorkspaceMetadata({ ...common, workspaces: [channelsWorkspace] });
    const candidate = readRegistryBytes(root);

    for (const relativePath of [registryPaths[0], registryPaths[1], registryPaths[3]]) {
      expect(candidate[relativePath]).not.toEqual(before[relativePath]);
      expect(candidate[relativePath].toString("utf8")).toContain("@chase-sets/channels");
    }
    for (const relativePath of [registryPaths[2], registryPaths[4]]) {
      expect(candidate[relativePath]).toEqual(before[relativePath]);
    }

    writeJson(fixtureManifestPath, {
      ...manifest,
      apiDeployables: [],
      apiRuntimeProfiles: [],
      runtimeDeployables: [],
      workerRuntimeProfiles: [],
      deployableContributions: [],
      shellContributions: [],
    });
    syncWorkspaceMetadata({ ...common, workspaces: [channelsWorkspace] });
    const mutant = readRegistryBytes(root);
    for (const relativePath of registryPaths) expect(mutant[relativePath]).toEqual(before[relativePath]);
  });
});

describe("channels-foundation-surface-fence", () => {
  it("admits exactly the ruled raw-export IndexedDB integration", () => {
    expect(
      collectChannelsSurfaceViolations(readJson(manifestPath), [
        ...listFiles(channelsRoot),
        "features/connector-client/integrations/raw-export-indexeddb.ts",
      ]),
    ).toEqual([]);
  });
  it.each(["package.mjs", "manifest.json", "worker.js", "helper.js", "capture.html", "capture.test.ts"])(
    "admits the exact order-authority probe path %s",
    (file) => {
      expect(
        collectChannelsSurfaceViolations(readJson(manifestPath), [
          ...listFiles(channelsRoot),
          `features/connector-client/integrations/order-authority-probe/${file}`,
        ]),
      ).toEqual([]);
    },
  );

  it.each([
    "integrations/synthetic-forbidden-sibling/worker.js",
    "integrations/raw-export-indexeddb.ts.backup",
    "integrations/raw-export-indexeddb.ts/extra.ts",
    "integrations/order-authority-probe/extra.js",
    "integrations/order-authority-probe/nested/worker.js",
    "integrations/order-authority-probe/worker.js/extra.js",
    "integrations/order-authority-probe/worker.js.backup",
    "integrations/order-detection-pagination-probe/extra.js",
    "integrations/order-detection-pagination-probe/nested/worker.js",
    "integrations/order-detection-pagination-probe/worker.js/extra.js",
    "integrations/order-detection-pagination-probe/worker.js.backup",
    ...["order-authority-probe", "order-detection-pagination-probe"].flatMap((probe) => [
      `integrations/prefix-${probe}/worker.js`,
      `integrations/${probe}-suffix/worker.js`,
      `integrations/${probe}extra/worker.js`,
      `integrations/${probe}/nested/${probe}/worker.js`,
    ]),
    "ui/synthetic-forbidden-sibling.ts",
    "synthetic-forbidden-sibling.ts",
  ])("rejects the forbidden connector-client sibling %s", (file) => {
    expect(
      collectChannelsSurfaceViolations(readJson(manifestPath), [
        ...listFiles(channelsRoot),
        `features/connector-client/${file}`,
      ]),
    ).toEqual(["connector-client-buckets"]);
  });

  it.each(["package.mjs", "manifest.json", "worker.js", "helper.js", "capture.html", "capture.test.ts"])(
    "admits the exact order-detection-pagination probe path %s",
    (file) => {
      expect(
        collectChannelsSurfaceViolations(readJson(manifestPath), [
          ...listFiles(channelsRoot),
          `features/connector-client/integrations/order-detection-pagination-probe/${file}`,
        ]),
      ).toEqual([]);
    },
  );

  it.each(["order-authority-probe", "order-detection-pagination-probe"])(
    "admits the complete six-file %s package alongside the real Channels inventory",
    (probe) => {
      const files = ["package.mjs", "manifest.json", "worker.js", "helper.js", "capture.html", "capture.test.ts"];
      expect(
        collectChannelsSurfaceViolations(readJson(manifestPath), [
          ...listFiles(channelsRoot),
          ...files.map((file) => `features/connector-client/integrations/${probe}/${file}`),
        ]),
      ).toEqual([]);
    },
  );

  it("accepts the desired-state slice while freezing forbidden context dependencies and excluding landing", () => {
    const manifest = readJson(manifestPath);
    const files = listFiles(channelsRoot);
    expect(collectChannelsSurfaceViolations(manifest, files)).toEqual([]);
    expect(
      collectChannelsSurfaceViolations(
        { ...manifest, allowedContextDependencies: [...manifest.allowedContextDependencies, "@chase-sets/identity"] },
        files,
      ),
    ).toEqual(["allowedContextDependencies"]);
    for (const dependency of manifest.allowedContextDependencies) {
      expect(
        collectChannelsSurfaceViolations(
          {
            ...manifest,
            allowedContextDependencies: manifest.allowedContextDependencies.filter((entry) => entry !== dependency),
          },
          files,
        ),
      ).toEqual(["allowedContextDependencies"]);
    }
    expect(
      collectChannelsSurfaceViolations(
        { ...manifest, hostPorts: manifest.hostPorts.filter((entry) => entry.portName !== "connectorOAuth") },
        files,
      ),
    ).toEqual(["hostPorts"]);
    expect(
      collectChannelsSurfaceViolations(
        { ...manifest, slices: manifest.slices.filter((entry) => entry !== "connector-feed") },
        files,
      ),
    ).toEqual(["slices"]);
    expect(
      collectChannelsSurfaceViolations(
        manifest,
        files.filter((file) => !file.startsWith("support/runtime-support/")),
      ),
    ).toEqual(["runtime-support-files"]);
    expect(
      collectChannelsSurfaceViolations({ ...manifest, allowedSupportDirectories: ["request-support"] }, files),
    ).toEqual(["allowedSupportDirectories"]);

    const landingMutant = { ...manifest, apiRuntimeProfiles: ["proof", "public", "landing"] };
    expect(collectChannelsSurfaceViolations(landingMutant, files)).toEqual(["apiRuntimeProfiles", "landing"]);
    expect(collectChannelsSurfaceViolations(manifest, [...files, "schema.ts"].sort())).toEqual(["root-files"]);
    expect(
      collectChannelsSurfaceViolations({ ...manifest, sourceRuntimeProfiles: ["neutral-profile"] }, files),
    ).toEqual(["sourceRuntimeProfiles"]);
  });
});

describe("channels-client-deployable-import-fence", () => {
  it("admits the exact client surface throughout the extension deployable", () => {
    expect(
      isAllowedDeployableBoundedContextImport(
        "deployables/tcgplayer-connector-extension/arbitrary/nested/composition-root.ts",
        "@chase-sets/channels/client",
      ),
    ).toBe(true);
  });

  it("kills an arbitrary-path sibling importer instead of relying on filename vocabulary", () => {
    expect(
      isAllowedDeployableBoundedContextImport(
        "deployables/synthetic-neutral-sibling/arbitrary/nested/connector-looking-file.ts",
        "@chase-sets/channels/client",
      ),
    ).toBe(false);
  });
});

describe("deployable-browser-test-support-import-fence", () => {
  const specifier = "@chase-sets/neutral-package/seed-support/neutral";
  const eligible = [
    "deployables/admin-web/e2e/access-api-keys.spec.ts",
    "deployables/marketplace/e2e/manual-sync-recovery.spec.ts",
    "deployables/marketplace/e2e/support/auth-trace-artifact.probe.spec.ts",
    "deployables/admin-web/e2e/arbitrary/nested/neutral.multi.spec.ts",
    "deployables/marketplace/e2e/neutral.spec.ts",
  ];
  const ineligible = [
    "deployables/admin-web/app/neutral.ts",
    "deployables/marketplace/server/neutral.ts",
    "deployables/platform-api/src/neutral.ts",
    "deployables/platform-worker/src/neutral.ts",
    "deployables/admin-web/e2e/support/neutral.ts",
    "deployables/marketplace/e2e/neutral.test.ts",
    "deployables/admin-web/e2e/neutral.spec.tsx",
    "deployables/admin-web/e2e/neutral.spec.js",
    "deployables/admin-web/arbitrary/neutral.spec.ts",
    "deployables/public-web/e2e/privacy-policy.spec.ts",
    "deployables/tcgplayer-connector-extension/e2e/chromium-authority.spec.ts",
    "deployables/synthetic-neutral-sibling/e2e/neutral.spec.ts",
    "deployables/admin-web/e2e//neutral.spec.ts",
    "deployables/admin-web/e2e/./neutral.spec.ts",
    "deployables/admin-web/e2e/../neutral.spec.ts",
    "/deployables/admin-web/e2e/neutral.spec.ts",
    "prefix/deployables/admin-web/e2e/neutral.spec.ts",
    "C:/deployables/admin-web/e2e/neutral.spec.ts",
  ];

  function declaredTarget() {
    const rootAbs = createTempRepo("browser-seed-support-");
    writeSource(rootAbs, "support/alternate-support/neutral.ts", "export const neutral = true;\n");
    return {
      rootAbs,
      packageName: "@chase-sets/neutral-package",
      manifest: {
        contextName: "neutral-context",
        packageName: "@chase-sets/neutral-package",
        publicExports: ["./seed-support/*"],
      },
      packageJson: {
        name: "@chase-sets/neutral-package",
        exports: { "./seed-support/*": "./support/alternate-support/*.ts" },
      },
    };
  }

  it.each(eligible)("admits declared support from %s with either path separator", (file) => {
    const target = declaredTarget();
    expect(isAllowedDeployableBoundedContextImport(file, specifier, target)).toBe(true);
    expect(isAllowedDeployableBoundedContextImport(file.replaceAll("/", "\\"), specifier, target)).toBe(true);
  });

  it.each(ineligible)("rejects declared support from %s with either path separator", (file) => {
    const target = declaredTarget();
    expect(isAllowedDeployableBoundedContextImport(file, specifier, target)).toBe(false);
    expect(isAllowedDeployableBoundedContextImport(file.replaceAll("/", "\\"), specifier, target)).toBe(false);
  });

  it.each([
    [
      "package export absent",
      (target) => {
        target.packageJson.exports = {};
      },
    ],
    [
      "manifest declaration absent",
      (target) => {
        target.manifest.publicExports = [];
      },
    ],
    [
      "another context's metadata",
      (target) => {
        target.packageName = target.manifest.packageName = target.packageJson.name = "@chase-sets/sibling";
      },
    ],
    [
      "package name disagrees",
      (target) => {
        target.packageJson.name = "@chase-sets/sibling";
      },
    ],
    [
      "manifest name disagrees",
      (target) => {
        target.manifest.packageName = "@chase-sets/sibling";
      },
    ],
    [
      "non-string export",
      (target) => {
        target.packageJson.exports["./seed-support/*"] = { default: "./support/alternate-support/*.ts" };
      },
    ],
    [
      "mapped target missing",
      (target) => {
        target.packageJson.exports["./seed-support/*"] = "./support/seed-support/*.ts";
      },
    ],
    [
      "mapped target traversal",
      (target) => {
        target.packageJson.exports["./seed-support/*"] = "./support/../support/alternate-support/*.ts";
      },
    ],
    [
      "target root absent",
      (target) => {
        delete target.rootAbs;
      },
    ],
  ])("rejects %s while keeping the other inputs valid", (_label, change) => {
    const target = declaredTarget();
    expect(isAllowedDeployableBoundedContextImport(eligible[0], specifier, target)).toBe(true);
    change(target);
    expect(isAllowedDeployableBoundedContextImport(eligible[0], specifier, target)).toBe(false);
  });

  it("rejects absent target metadata", () => {
    expect(isAllowedDeployableBoundedContextImport(eligible[0], specifier)).toBe(false);
  });

  it.each([
    "seed-support",
    "seed-support/",
    "seed-support/.",
    "seed-support/..",
    "seed-support/../neutral",
    "seed-support/./neutral",
    "seed-support//neutral",
    "seed-support/nested/../neutral",
    "seed-support/neutral/",
    "seed-support/missing",
    "seed-support/..\\neutral",
    "test-support/neutral",
    "support/alternate-support/neutral",
  ])("rejects the invalid package subpath %s", (subpath) => {
    expect(
      isAllowedDeployableBoundedContextImport(eligible[0], `@chase-sets/neutral-package/${subpath}`, declaredTarget()),
    ).toBe(false);
  });

  it("rejects a context-name lookalike and a relative deep import", () => {
    const target = declaredTarget();
    expect(
      isAllowedDeployableBoundedContextImport(eligible[0], "@chase-sets/neutral-context/seed-support/neutral", target),
    ).toBe(false);
    expect(
      isAllowedDeployableBoundedContextImport(
        eligible[0],
        "../../../bounded-contexts/neutral-context/support/alternate-support/neutral",
        target,
      ),
    ).toBe(false);
  });

  it.each([
    ["deployables/admin-web/app/neutral.ts", false, true],
    ["deployables/platform-api/src/neutral.ts", true, false],
    ["deployables/admin-web/tests/neutral.test.ts", true, true],
    ["deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts", false, true],
    ["deployables/admin-web/e2e/support/representative-catalog-evidence.ts", false, true],
  ])("retains public-entrypoint results for %s", (file, rootAllowed, webSurfacesAllowed) => {
    expect(isAllowedDeployableBoundedContextImport(file, "@chase-sets/catalog")).toBe(rootAllowed);
    expect(isAllowedDeployableBoundedContextImport(file, "@chase-sets/catalog/server")).toBe(true);
    for (const surface of ["context", "host-config", "web", "routes/neutral"]) {
      expect(isAllowedDeployableBoundedContextImport(file, `@chase-sets/catalog/${surface}`)).toBe(webSurfacesAllowed);
    }
    expect(isAllowedDeployableBoundedContextImport(file, "@chase-sets/catalog/private/neutral")).toBe(false);
  });
});

describe("declared-api-db-test-support", () => {
  const specifier = "@chase-sets/neutral-package/test-support";
  const witness = "deployables/platform-api/__tests__/connector-mount-gate-isolation.db.test.ts";
  const nested = "deployables/platform-api/__tests__/neutral/nested/neutral.db.test.ts";
  const mapping = "./features/neutral-slice/tests/neutral.ts";

  function declaredTarget() {
    const root = createTempRepo("api-db-support-");
    const rootAbs = path.join(root, "bounded-contexts/neutral-context");
    writeSource(rootAbs, mapping, "export const neutral = true;\n");
    return {
      rootAbs,
      packageName: "@chase-sets/neutral-package",
      manifest: {
        contextName: "neutral-context",
        packageName: "@chase-sets/neutral-package",
        publicExports: ["./test-support"],
      },
      packageJson: { name: "@chase-sets/neutral-package", exports: { "./test-support": mapping } },
    };
  }

  function check(file, target, imported = specifier) {
    return isAllowedDeployableBoundedContextImport(file, imported, target);
  }

  it("admits only the exact vocabulary entry and the actual declared Channels witness", () => {
    expect(isAllowedPublicExportName("./test-support")).toBe(true);
    expect(isAllowedPublicExportName("./test-support/*")).toBe(false);
    expect(isAllowedPublicExportName("./test-support/extra")).toBe(false);
    const target = {
      rootAbs: channelsRoot,
      packageName: "@chase-sets/channels",
      manifest: readJson(manifestPath),
      packageJson: readJson(packagePath),
    };
    expect(check(witness, target, "@chase-sets/channels/test-support")).toBe(true);
    expect(
      findTestSupportImportViolations(witness, readFileSync(path.join(repoRoot, witness), "utf8"), [target]),
    ).toEqual([]);
  });

  it.each([
    `import "${specifier}";`,
    `void import("${specifier}");`,
    `export * from "${specifier}";`,
    `const fixture = require("${specifier}");`,
  ])("discovers denied side effects, dynamic imports and re-exports: %s", (content) => {
    expect(
      findTestSupportImportViolations("bounded-contexts/channels/server.ts", content, [declaredTarget()]),
    ).toHaveLength(1);
  });

  async function discover(file, target, imported = specifier) {
    const root = createTempRepo("api-db-consumer-");
    writeSource(
      root,
      file,
      `import { neutral } from ${JSON.stringify(imported)};\nexport { neutral } from ${JSON.stringify(imported)};\n`,
    );
    const found = [];
    const violations = [];
    await runImportBoundaryValidation({
      roots: [root],
      walk,
      onDirectory() {},
      onFile(filePath) {
        const relative = path.relative(root, filePath).replaceAll("\\", "/");
        found.push(relative);
        violations.push(
          ...findTestSupportImportViolations(relative, readFileSync(filePath, "utf8"), [target].values()),
        );
      },
    });
    expect(found).toEqual([file]);
    return violations;
  }

  it.each([witness, nested])("admits %s by declaration, not context directory name", async (file) => {
    const target = declaredTarget();
    expect(hasValidTestSupportDeclaration(target)).toBe(true);
    expect(check(file, target)).toBe(true);
    expect(check(file.replaceAll("/", "\\"), target)).toBe(true);
    expect(await discover(file, target)).toEqual([]);
  });

  const deniedConsumers = [
    "deployables/platform-api/src/neutral.ts",
    "deployables/platform-api/server.ts",
    "deployables/platform-api/__tests__/neutral.test.ts",
    "deployables/platform-api/__tests__/neutral.db.spec.ts",
    "deployables/platform-api/__tests__/neutral.db.test.tsx",
    "deployables/platform-api/__tests__/neutral.db.test.js",
    "deployables/platform-api/__tests__/neutral.ts",
    "deployables/platform-api/neutral.db.test.ts",
    ...[
      "platform-worker",
      "admin-web",
      "marketplace",
      "public-web",
      "tcgplayer-operator-extension",
      "tcgplayer-connector-extension",
    ].map((name) => `deployables/${name}/__tests__/neutral.db.test.ts`),
    "bounded-contexts/neutral-context/features/neutral-slice/tests/neutral.db.test.ts",
    "bounded-contexts/other/features/neutral/tests/neutral.db.test.ts",
    "bounded-contexts/other/support/seed-support/neutral.ts",
    "bounded-contexts/other/seed.ts",
    "infrastructure/platform-runtime/tests/neutral.test.ts",
    "contracts/neutral/tests/neutral.test.ts",
    "packages/neutral/tests/neutral.test.ts",
    "scripts/neutral.test.mjs",
    "bounded-contexts/channels/server.ts",
  ];
  it.each(deniedConsumers)("refuses %s through predicate and real discovery", async (file) => {
    const target = declaredTarget();
    expect(check(witness, target)).toBe(true);
    expect(check(file, target)).toBe(false);
    expect(check(file.replaceAll("/", "\\"), target)).toBe(false);
    expect(await discover(file, target)).toHaveLength(2);
  });

  it.each([
    "deployables/platform-api/__tests__//neutral.db.test.ts",
    "deployables/platform-api/__tests__/./neutral.db.test.ts",
    "deployables/platform-api/__tests__/../neutral.db.test.ts",
    "/deployables/platform-api/__tests__/neutral.db.test.ts",
    "prefix/deployables/platform-api/__tests__/neutral.db.test.ts",
    "C:/deployables/platform-api/__tests__/neutral.db.test.ts",
    "deployables/platform-api/__tests__/C:/neutral.db.test.ts",
    `${witness}/`,
    `${witness}?query`,
    `${witness}#fragment`,
    "",
  ])("rejects unnormalized importer %s without collapsing it", (file) => {
    const target = declaredTarget();
    expect(check(file, target)).toBe(false);
    expect(check(file.replaceAll("/", "\\"), target)).toBe(false);
    expect(findTestSupportImportViolations(file, `import "${specifier}";`, [target])).toHaveLength(1);
  });

  const declarationMutations = [
    [
      "package declaration absent",
      (t) => {
        delete t.packageJson.exports["./test-support"];
      },
    ],
    [
      "context declaration absent",
      (t) => {
        t.manifest.publicExports = [];
      },
    ],
    [
      "package identity mismatch",
      (t) => {
        t.packageJson.name = "@chase-sets/other";
      },
    ],
    [
      "context identity mismatch",
      (t) => {
        t.manifest.packageName = "@chase-sets/other";
      },
    ],
    [
      "root absent",
      (t) => {
        delete t.rootAbs;
      },
    ],
    [
      "root missing",
      (t) => {
        t.rootAbs += "-missing";
      },
    ],
    [
      "conditional export",
      (t) => {
        t.packageJson.exports["./test-support"] = { default: mapping };
      },
    ],
    [
      "non-string export",
      (t) => {
        t.packageJson.exports["./test-support"] = [mapping];
      },
    ],
    ...[
      "./features/neutral-slice/tests/*.ts",
      "./features/neutral-slice/tests/missing.ts",
      "./features/neutral-slice/tests",
      "./features/neutral-slice/api/neutral.ts",
      "./features/neutral-slice/tests//neutral.ts",
      "./features/neutral-slice/tests/./neutral.ts",
      "./features/neutral-slice/tests/../tests/neutral.ts",
      "./features/neutral-slice/tests/..\\tests/neutral.ts",
      "/features/neutral-slice/tests/neutral.ts",
      "C:/features/neutral-slice/tests/neutral.ts",
      "./features/neutral-slice/tests/neutral.ts?query",
      "./features/neutral-slice/tests/neutral.ts#fragment",
      "features/neutral-slice/tests/neutral.ts",
      "./../features/neutral-slice/tests/neutral.ts",
    ].map((value) => [
      value,
      (t) => {
        t.packageJson.exports["./test-support"] = value;
      },
    ]),
  ];
  it.each(declarationMutations)("refuses %s with all other inputs fixed", async (_label, mutate) => {
    const target = declaredTarget();
    writeSource(target.rootAbs, "features/neutral-slice/api/neutral.ts", "export const neutral = true;");
    expect(check(witness, target)).toBe(true);
    mutate(target);
    expect(hasValidTestSupportDeclaration(target)).toBe(false);
    expect(check(witness, target)).toBe(false);
    expect(await discover(witness, target)).toHaveLength(2);
  });

  it("refuses absent metadata and a different actual target package", async () => {
    expect(check(witness, undefined)).toBe(false);
    const target = declaredTarget();
    const wrong = "@chase-sets/neutral-context/test-support";
    expect(check(witness, target, wrong)).toBe(false);
    target.packageName = target.packageJson.name = target.manifest.packageName = "@chase-sets/other";
    expect(check(witness, target)).toBe(false);
    expect(await discover(witness, target, "@chase-sets/other/test-support/extra")).toHaveLength(2);
  });

  it("rejects an existing directory and symlink escaping its owner tests tree", async () => {
    const target = declaredTarget();
    const outside = createTempRepo("outside-fixture-");
    writeSource(outside, "neutral.ts", "export const neutral = true;");
    const link = path.join(target.rootAbs, "features/neutral-slice/tests/link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    target.packageJson.exports["./test-support"] = "./features/neutral-slice/tests/link/neutral.ts";
    expect(check(witness, target)).toBe(false);
    expect(await discover(witness, target)).toHaveLength(2);
    mkdirSync(path.join(target.rootAbs, "features/neutral-slice/tests/directory.ts"));
    target.packageJson.exports["./test-support"] = "./features/neutral-slice/tests/directory.ts";
    expect(check(witness, target)).toBe(false);
    expect(await discover(witness, target)).toHaveLength(2);
  });

  it.each(["/extra", "/../server", "/./neutral", "//neutral", "/", "?query", "#fragment", "\\extra"])(
    "rejects malformed specifier suffix %s",
    async (suffix) => {
      const target = declaredTarget();
      expect(check(witness, target, `${specifier}${suffix}`)).toBe(false);
      expect(await discover(witness, target, `${specifier}${suffix}`)).toHaveLength(2);
    },
  );

  it("retains seed-support refusal and relative deep-import refusal for API DB witnesses", () => {
    const target = declaredTarget();
    target.manifest.publicExports.push("./seed-support/*");
    target.packageJson.exports["./seed-support/*"] = "./features/neutral-slice/tests/*.ts";
    expect(check(witness, target, "@chase-sets/neutral-package/seed-support/neutral")).toBe(false);
    expect(
      check(witness, target, "../../../bounded-contexts/neutral-context/features/neutral-slice/tests/neutral"),
    ).toBe(false);
    const source = readFileSync(path.join(repoRoot, "scripts/check-structure/run.mjs"), "utf8");
    expect(source).toContain("addViolation(file, `deployables must use package imports (${specifier})`)");
  });

  it("discriminates declaration-removal and consumer-broadening mutants independently", () => {
    const source = readFileSync(path.join(repoRoot, "scripts/check-structure/run.mjs"), "utf8");
    const start = source.indexOf("export function isAllowedDeployableBoundedContextImport(");
    const end = source.indexOf("\nfunction isAllowedContextImporter", start);
    const original = source.slice(start, end).replace("export ", "");
    const compile = (body) =>
      new Function(
        "hasValidTestSupportDeclaration",
        "hasSafePathSegments",
        `${body}; return isAllowedDeployableBoundedContextImport;`,
      )(hasValidTestSupportDeclaration, (value) =>
        value.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
      );
    const declarationRemoved = original.replace("hasValidTestSupportDeclaration(targetContext)", "true");
    expect(declarationRemoved).not.toBe(original);
    const target = declaredTarget();
    target.manifest.publicExports = [];
    expect(check(witness, target)).toBe(false);
    expect(compile(declarationRemoved)(witness, specifier, target)).toBe(true);
    const consumerBroadened = original.replace(
      "/^deployables\\/platform-api\\/__tests__\\/(?:[^/]+\\/)*[^/]+\\.db\\.test\\.ts$/",
      "/^deployables\\//",
    );
    expect(consumerBroadened).not.toBe(original);
    const valid = declaredTarget();
    expect(check(deniedConsumers[0], valid)).toBe(false);
    expect(compile(consumerBroadened)(deniedConsumers[0], specifier, valid)).toBe(true);
  });
});

describe.each([
  [
    "browser seed",
    "./seed-support/*",
    "./support/seed-support/*.ts",
    "seed-support/neutral",
    "support/seed-support/neutral.ts",
    ["deployables/admin-web/e2e/neutral.spec.ts", "deployables/marketplace/e2e/nested/neutral.probe.spec.ts"],
  ],
  [
    "API DB",
    "./test-support",
    "./features/neutral/tests/neutral.ts",
    "test-support",
    "features/neutral/tests/neutral.ts",
    [
      "deployables/platform-api/__tests__/neutral.db.test.ts",
      "deployables/platform-api/__tests__/nested/neutral.db.test.ts",
    ],
  ],
])("declared %s support resolution", (_label, exportKey, mapping, subpath, modulePath, specPaths) => {
  it("resolves both specs through generated package exports and loses resolution when only the export is removed", () => {
    const root = createTempRepo("browser-seed-resolution-");
    const contextRoot = "bounded-contexts/neutral-context";
    const target = `${contextRoot}/${modulePath}`;
    const specifier = `@chase-sets/neutral-package/${subpath}`;
    writeJson(path.join(root, "tsconfig.base.json"), {
      compilerOptions: { moduleResolution: "Bundler", module: "ESNext", paths: {} },
    });
    writeJson(path.join(root, contextRoot, "context.json"), {
      contextName: "neutral-context",
      packageName: "@chase-sets/neutral-package",
      publicExports: [exportKey],
    });
    const packageJson = {
      name: "@chase-sets/neutral-package",
      exports: { [exportKey]: mapping },
    };
    writeJson(path.join(root, contextRoot, "package.json"), packageJson);
    writeSource(root, target, "export const neutral = true;\n");
    for (const file of specPaths) writeSource(root, file, `import { neutral } from "${specifier}";\nvoid neutral;\n`);
    const workspace = {
      name: packageJson.name,
      dir: path.join(root, contextRoot),
      dirName: "neutral-context",
      root: "bounded-contexts",
      packageJson,
    };
    const trackedLocaleFile = "contracts/localization/locales/en/neutral.ts";
    writeSource(root, trackedLocaleFile, 'export const neutral = { "neutral.example": "Example" } as const;\n');
    const sync = () =>
      syncWorkspaceMetadata({ rootDir: root, workspaces: [workspace], trackedLocaleFiles: [trackedLocaleFile] });
    const readConfig = () => {
      const config = ts.readConfigFile(path.join(root, "tsconfig.base.json"), ts.sys.readFile);
      expect(config.error).toBeUndefined();
      return config.config;
    };
    const resolve = (file) => {
      const parsed = ts.parseJsonConfigFileContent(readConfig(), ts.sys, root);
      expect(parsed.errors).toEqual([]);
      return ts.resolveModuleName(specifier, path.join(root, file), parsed.options, ts.sys).resolvedModule;
    };

    sync();
    expect(readJson(path.join(root, contextRoot, "package.json")).exports[exportKey]).toBe(mapping);
    const alias = `@chase-sets/neutral-package/${exportKey.slice(2)}`;
    expect(readConfig().compilerOptions.paths[alias]).toEqual([`./${contextRoot}/${mapping.slice(2)}`]);
    for (const file of specPaths) expect(path.resolve(resolve(file).resolvedFileName)).toBe(path.join(root, target));

    delete packageJson.exports[exportKey];
    writeJson(path.join(root, contextRoot, "package.json"), packageJson);
    sync();
    expect(readConfig().compilerOptions.paths).not.toHaveProperty(alias);
    for (const file of specPaths) expect(resolve(file)).toBeUndefined();
  });
});

describe("channels-glossary-ownership", () => {
  const connectionTerms = [
    "Sales Channel",
    "Channel Connection",
    "BYO Channel",
    "Channel Account",
    "Channel Authorization",
    "Channel Credential",
    "Channel Webhook",
    "Channel Health",
    "Channel Mapping",
  ];
  const syncTerms = [
    "Channel Listing Link",
    "Channel Publication Facts",
    "Channel Composition Profile",
    "Channel Publication Settings",
    "Channel Publication Eligibility",
    "Channel Listing Desired State",
    "Channel Listing Reconciliation Run",
    "Channel Sync",
    "Channel Sync Run",
    "Channel Sync Error",
    "Channel Inventory Snapshot",
    "Channel Outbound Operation",
    "Outbound Operation Lane",
    "Outbound Operation Attempt",
    "Claimed Operation Reservation",
  ];
  const stockTerms = [
    "Channel Stock Allocation",
    "Channel Allocation Mode",
    "Channel Allocation",
    "Channel Reservation",
    "Channel Fulfillment Rule",
  ];
  const headings = (source) => [...source.matchAll(/^#{2,6}\s+(.+)$/gm)].map(([, term]) => term);
  const owners = (documents, term) =>
    documents.flatMap(({ name, source }) =>
      headings(source)
        .filter((heading) => heading === term)
        .map(() => name),
    );

  it("gives every transferred term one defining owner while retaining stock truth and prose pointers", () => {
    const documents = listContextManifests().map(({ dir, manifest }) => ({
      name: manifest.contextName,
      source: readFileSync(path.join(dir, "GLOSSARY.md"), "utf8"),
    }));
    for (const term of [...connectionTerms, ...syncTerms]) expect(owners(documents, term), term).toEqual(["channels"]);
    for (const term of stockTerms) expect(owners(documents, term), term).toEqual(["inventory"]);
    for (const name of ["identity", "inventory"]) {
      expect(documents.find((document) => document.name === name).source).toContain(
        "[Channels glossary](../channels/GLOSSARY.md)",
      );
    }
    const master = readFileSync(path.join(repoRoot, "docs/GLOSSARY.md"), "utf8");
    const channelsRow = master.split("\n").find((line) => line.startsWith("| m116-m121 sales channels |"));
    expect(channelsRow).toContain("[Channels](../bounded-contexts/channels/GLOSSARY.md)");
    for (const term of [...connectionTerms, ...syncTerms]) expect(channelsRow).toContain(term);
    expect(master.split("\n").find((line) => line.startsWith("| Channel family |"))).toContain("[Channels]");
    const duplicate = [
      ...documents,
      { name: "neutral-sibling", source: "## Channel Connection\n\nA duplicate definition.\n" },
    ];
    expect(owners(duplicate, "Channel Connection")).toEqual(["channels", "neutral-sibling"]);
    expect(owners(duplicate, "Channel Connection")).not.toEqual(["channels"]);
    expect(
      owners(
        documents.filter((document) => document.name !== "channels"),
        "Channel Connection",
      ),
    ).toEqual([]);
  });
});

describe("channels-wake-registry-derivation", () => {
  function derive(manifests) {
    return {
      affectedProjectionNames: manifests
        .flatMap((manifest) =>
          (manifest.projectionGroups ?? [])
            .filter((group) => group.projectionName && group.sourceContextNames?.includes("channels"))
            .map((group) => `${manifest.contextName}:${group.projectionName}`),
        )
        .sort(),
      routeDependencyIds: manifests
        .filter((manifest) => manifest.contextName === "channels")
        .flatMap((manifest) => (manifest.readAfterWriteRouteInventory ?? []).map((route) => route.id))
        .sort(),
    };
  }

  it("derives the pinned projection and route lists from every manifest and exposes new consumers", () => {
    const manifests = listContextManifests().map(({ manifest }) => manifest);
    const entry = requireSourceContextWakeRegistryEntry("channels");
    expect(sourceContextWakeRegistry.filter((value) => value.sourceContextName === "channels")).toEqual([entry]);
    expect(entry).toMatchObject({
      sourceContextName: "channels",
      owner: "Channels",
      rolloutState: "not-eligible",
      phase: "phase-3-expansion",
      rolloutWave: "wave-4-deferred-or-not-eligible",
      priorityLane: "bulk",
      expectedEventVolume: "low",
      wakeStoreLoadEstimate: "none",
      enablement: { eventStoreWakeNotifications: false, relayFanOut: false },
      ...derive(manifests),
    });
    expect(derive(manifests)).toEqual({
      affectedProjectionNames: [
        "channels:channel-connection-projection",
        "channels:channel-fulfillment-observation-retry",
        "channels:channel-listing-desired-state-reaction",
        "channels:channel-owned-publication-state",
        "channels:platform-policy-document-projection",
        "channels:tcgplayer-csv-projection",
      ],
      routeDependencyIds: ["channels.publication-settings-to-detail"],
    });
    expect(summarizeSourceContextWakeRegistry()).toMatchObject({
      entryCount: manifests.length,
      activeEntryCount: 11,
      enabledEventStoreWakeContextCount: 11,
      enabledRelayFanOutContextCount: 11,
    });
    const projectionMutant = derive([
      ...manifests,
      {
        contextName: "neutral-consumer",
        projectionGroups: [{ projectionName: "connection-view", sourceContextNames: ["channels"] }],
      },
    ]);
    expect(projectionMutant.affectedProjectionNames).toEqual([
      "channels:channel-connection-projection",
      "channels:channel-fulfillment-observation-retry",
      "channels:channel-listing-desired-state-reaction",
      "channels:channel-owned-publication-state",
      "channels:platform-policy-document-projection",
      "channels:tcgplayer-csv-projection",
      "neutral-consumer:connection-view",
    ]);
    expect(projectionMutant.affectedProjectionNames).not.toEqual(entry.affectedProjectionNames);
    const routeMutant = derive(
      manifests.map((manifest) =>
        manifest.contextName === "channels"
          ? { ...manifest, readAfterWriteRouteInventory: [{ id: "neutral-route" }] }
          : manifest,
      ),
    );
    expect(routeMutant.routeDependencyIds).toEqual(["neutral-route"]);
    expect(routeMutant.routeDependencyIds).not.toEqual(entry.routeDependencyIds);
  });
});
