import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listContextManifests, repoRoot } from "../lib/repo.mjs";
import { validateGlossaryCoverage } from "./glossary-coverage.mjs";
import { syncWorkspaceMetadata } from "../sync-workspace-metadata.mjs";
import {
  requireSourceContextWakeRegistryEntry,
  sourceContextWakeRegistry,
  summarizeSourceContextWakeRegistry,
} from "../../infrastructure/platform-runtime/source-context-wake-registry.ts";

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
  const emptyArrayFields = ["allowedContextDependencies", "seedRequirements", "hostPorts"];
  const absentManifestFields = [
    "sourceRuntimeDeployables",
    "sourceRuntimeProfiles",
    "mcpCapabilities",
    "accountCapabilities",
    "readAfterWriteRouteInventory",
  ];

  for (const field of emptyArrayFields) {
    if (!Array.isArray(candidate[field]) || candidate[field].length !== 0) violations.push(field);
  }
  for (const field of absentManifestFields) {
    if (field in candidate) violations.push(field);
  }
  if (
    JSON.stringify(candidate.slices) !==
    JSON.stringify(["connections", "publication-port", "listing-composition", "tcgplayer-csv", "outbound-sync"])
  ) {
    violations.push("slices");
  }
  if (
    JSON.stringify(candidate.allowedSupportDirectories) !== JSON.stringify(["request-support", "runtime-support"])
  ) {
    violations.push("allowedSupportDirectories");
  }
  if (candidate.eventSubscriptions?.length !== 5) violations.push("eventSubscriptions");
  if (candidate.eventReactions?.length !== 5) violations.push("eventReactions");
  if (candidate.deployableContributions?.[0]?.routes?.length !== 4) violations.push("deployableContributions");
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
      ]),
      slices: ["connections", "publication-port", "listing-composition", "tcgplayer-csv", "outbound-sync"],
      allowedSupportDirectories: ["request-support", "runtime-support"],
      publicExports: [".", "./context", "./server", "./routes/*"],
      allowedContextDependencies: [],
      hostPorts: [],
    });
    expect(manifest.eventSubscriptions.map((entry) => entry.order)).toEqual([10, 20, 30, 40, 50]);
    expect(manifest.eventSubscriptions.map((entry) => entry.sourceContextName)).toEqual([
      "marketplace",
      "catalog",
      "inventory",
      "channels",
      "channels",
    ]);
    expect(manifest.eventReactions.map((entry) => entry.order)).toEqual([60, 61, 62, 63, 64]);
    expect(manifest.deployableContributions[0].routes.map((route) => route.authorization.requiredPermissions)).toEqual([
      ["channels.view"],
      ["channels.view"],
      ["channels.view"],
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
          expectedConsumers: ["Root Channels module and API composition"],
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

describe("channels-foundation-no-deployable-registration", () => {
  it("registers Channels in API, worker, and contributed marketplace-web registries and kills the behavior-free mutant", () => {
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
  it("accepts the desired-state slice while freezing forbidden context dependencies and excluding landing", () => {
    const manifest = readJson(manifestPath);
    const files = listFiles(channelsRoot);
    expect(collectChannelsSurfaceViolations(manifest, files)).toEqual([]);

    const landingMutant = { ...manifest, apiRuntimeProfiles: ["proof", "public", "landing"] };
    expect(collectChannelsSurfaceViolations(landingMutant, files)).toEqual(["apiRuntimeProfiles", "landing"]);
    expect(collectChannelsSurfaceViolations(manifest, [...files, "schema.ts"].sort())).toEqual(["root-files"]);
    expect(
      collectChannelsSurfaceViolations({ ...manifest, sourceRuntimeProfiles: ["neutral-profile"] }, files),
    ).toEqual(["sourceRuntimeProfiles"]);
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

  it("derives both empty lists from every manifest and exposes new projection or route consumers", () => {
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
        "channels:channel-listing-desired-state-reaction",
        "channels:channel-outbound-operation-enqueue",
        "channels:channel-owned-publication-state",
        "channels:platform-policy-document-projection",
        "channels:tcgplayer-csv-projection",
      ],
      routeDependencyIds: [],
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
      "channels:channel-listing-desired-state-reaction",
      "channels:channel-outbound-operation-enqueue",
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
