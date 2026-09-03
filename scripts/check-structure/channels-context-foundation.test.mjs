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
const requiredFiles = [
  "GLOSSARY.md",
  "README.md",
  "context.json",
  "index.ts",
  "package.json",
  "tests/vitest.config.mjs",
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

function collectFoundationSurfaceViolations(candidate, relativeFiles) {
  const violations = [];
  if (JSON.stringify(relativeFiles) !== JSON.stringify(requiredFiles)) violations.push("files");
  const emptyArrayFields = [
    "slices",
    "allowedSupportDirectories",
    "allowedContextDependencies",
    "seedRequirements",
    "hostPorts",
    "apiDeployables",
    "apiRuntimeProfiles",
    "apiMounts",
    "workerRuntimeProfiles",
    "deployableContributions",
    "shellContributions",
  ];
  const absentManifestFields = [
    "runtimeDeployables",
    "sourceRuntimeDeployables",
    "sourceRuntimeProfiles",
    "eventSubscriptions",
    "eventReactions",
    "projectionGroups",
    "mcpCapabilities",
    "accountCapabilities",
    "mutationConsistencyInventory",
    "readAfterWriteRouteInventory",
    "localeCatalogs",
  ];

  for (const field of emptyArrayFields) {
    if (!Array.isArray(candidate[field]) || candidate[field].length !== 0) violations.push(field);
  }
  for (const field of absentManifestFields) {
    if (field in candidate) violations.push(field);
  }
  for (const relativeFile of relativeFiles) {
    if (/^(?:deployables|features|routes|support)\//.test(relativeFile)) violations.push(`file:${relativeFile}`);
    if (/^(?:api|client|ids|server|web)\.(?:ts|tsx)$/.test(relativeFile)) violations.push(`file:${relativeFile}`);
  }

  return violations.sort();
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("channels-context-foundation", () => {
  it("declares the exact behavior-free context, package, root export, README contract, and required files", () => {
    expect(readJson(manifestPath)).toEqual({
      contextName: "channels",
      packageName: "@chase-sets/channels",
      ownedNouns: [],
      streamPrefix: "channels.",
      apiBasePath: "/api/channels",
      slices: [],
      allowedSupportDirectories: [],
      publicExports: [".", "./context"],
      allowedContextDependencies: [],
      seedRequirements: [],
      hostPorts: [],
      apiDeployables: [],
      apiRuntimeProfiles: [],
      apiMounts: [],
      workerRuntimeProfiles: [],
      deployableContributions: [],
      shellContributions: [],
      directoryIntent: {
        routes: {
          classification: "routes",
          purpose: "Reserve Channels route metadata until behavior-backed Channels routes exist.",
          expectedConsumers: ["Future behavior-backed Channels route contributions"],
        },
      },
    });
    expect(readJson(packagePath)).toEqual({
      name: "@chase-sets/channels",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { "test:watch": "vitest --config ./tests/vitest.config.mjs" },
      exports: { ".": "./index.ts", "./context": "./context.json" },
      types: "./index.ts",
    });
    expect(readFileSync(path.join(channelsRoot, "index.ts"), "utf8").trim()).toBe(
      'export { default as contextManifest } from "./context.json" with { type: "json" };',
    );

    const files = listFiles(channelsRoot);
    expect(files).toEqual(requiredFiles);

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
    const channelsAliases = liveBaseline.aliases.filter((entry) => entry.contextName === "channels");
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
            ownedNouns: [],
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
  it("keeps all five generated registries byte-identical and proves the API-host mutant would register", () => {
    const root = createTempRepo("channels-metadata-");
    writeJson(path.join(root, "tsconfig.base.json"), { compilerOptions: { paths: {} } });
    const fixtureManifestPath = path.join(root, "bounded-contexts/channels/context.json");
    const manifest = readJson(manifestPath);
    const packageJson = readJson(packagePath);
    writeJson(fixtureManifestPath, manifest);
    const trackedLocaleFile = "contracts/localization/locales/en/example.ts";
    writeSource(root, trackedLocaleFile, 'export const example = { "example.key": "Example" } as const;\n');

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

    for (const relativePath of registryPaths) expect(candidate[relativePath]).toEqual(before[relativePath]);

    writeJson(fixtureManifestPath, { ...manifest, apiDeployables: ["platform-api"] });
    syncWorkspaceMetadata({ ...common, workspaces: [channelsWorkspace] });
    const mutant = readRegistryBytes(root);
    expect(mutant[registryPaths[0]]).not.toEqual(candidate[registryPaths[0]]);
    expect(mutant[registryPaths[0]].toString("utf8")).toContain("@chase-sets/channels");
    for (const relativePath of registryPaths.slice(1)) {
      expect(mutant[relativePath]).toEqual(candidate[relativePath]);
    }
  });
});

describe("channels-foundation-surface-fence", () => {
  it("accepts the behavior-free source shape and rejects the API-deployable mutant", () => {
    const manifest = readJson(manifestPath);
    const files = listFiles(channelsRoot);
    expect(collectFoundationSurfaceViolations(manifest, files)).toEqual([]);

    const apiDeployableMutant = { ...manifest, apiDeployables: ["platform-api"] };
    expect(collectFoundationSurfaceViolations(apiDeployableMutant, files)).toEqual(["apiDeployables"]);
    expect(collectFoundationSurfaceViolations(manifest, [...files, "schema.ts"].sort())).toEqual(["files"]);
    expect(
      collectFoundationSurfaceViolations({ ...manifest, sourceRuntimeProfiles: ["neutral-profile"] }, files),
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
    "Channel Sync",
    "Channel Sync Run",
    "Channel Sync Error",
    "Channel Inventory Snapshot",
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
    expect(derive(manifests)).toEqual({ affectedProjectionNames: [], routeDependencyIds: [] });
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
    expect(projectionMutant.affectedProjectionNames).toEqual(["neutral-consumer:connection-view"]);
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
