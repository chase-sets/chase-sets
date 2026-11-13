import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import { CONTEXT_REGISTRY_HOST_ARMS, contextManifestContributesToApiHost, repoRoot } from "../lib/repo.mjs";
import {
  CONTEXT_REGISTRIES,
  RETIRED_CONTEXT_REGISTRY_PATHS,
  validateContextRegistries,
} from "./context-registry-guard.mjs";

const apiPath = "deployables/platform-api/src/context-registry.ts";
const workerPath = "deployables/platform-worker/src/context-registry.ts";
const adminPath = "deployables/admin-web/app/context-registry.ts";
const marketplacePath = "deployables/marketplace/app/context-registry.ts";
const publicPath = "deployables/public-web/app/context-registry.ts";
const retiredMessage =
  "retired generated context registry must not exist; context registries are the five hand-authored context-registry.ts modules";

const tempRoots = [];

afterEach(() => {
  for (const rootDir of tempRoots.splice(0)) rmSync(rootDir, { recursive: true, force: true });
});

function tempRoot() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "chase-sets-context-registry-guard-"));
  tempRoots.push(rootDir);
  return rootDir;
}

function writeFiles(rootDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, ...relativePath.split("/"));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }
}

function replaceOnce(rootDir, relativePath, from, to) {
  const filePath = path.join(rootDir, ...relativePath.split("/"));
  const content = readFileSync(filePath, "utf8");
  expect(content.split(from).length - 1, `${relativePath} must contain the mutation anchor exactly once`).toBe(1);
  writeFileSync(
    filePath,
    content.replace(from, () => to),
    "utf8",
  );
}

// Fixture registries are written out by hand-shaped templates; the guard never
// receives them, it re-derives membership from the fixture's own manifests.
function alias(contextName) {
  return contextName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function nodeRegistry(exportName, rows) {
  const imports = rows.map(
    (row) =>
      `import { contextManifest as ${alias(row.contextName)}Manifest, module as ${alias(row.contextName)}Module } from "${row.packageName}";`,
  );
  const entries = rows.map((row) =>
    [
      "  {",
      `    contextName: "${row.contextName}",`,
      `    packageName: "${row.packageName}",`,
      `    manifest: ${alias(row.contextName)}Manifest,`,
      `    module: ${alias(row.contextName)}Module,`,
      "  },",
    ].join("\n"),
  );
  return `${imports.join("\n")}\n\nexport const ${exportName} = [\n${entries.join("\n")}\n] as const;\n`;
}

function webRegistry(rows) {
  const imports = rows.map((row) => `import ${alias(row.contextName)}Manifest from "${row.packageName}/context";`);
  const entries = rows.map((row) =>
    [
      "  {",
      `    contextName: "${row.contextName}",`,
      `    packageName: "${row.packageName}",`,
      `    manifest: ${alias(row.contextName)}Manifest as WebContextRegistry[number]["manifest"],`,
      "  },",
    ].join("\n"),
  );
  return [
    'import type { WebContextRegistry } from "@chase-sets/platform-runtime/web";',
    "",
    ...imports,
    "",
    `export const webContextRegistry = [\n${entries.join("\n")}\n] as const satisfies WebContextRegistry;`,
    "",
  ].join("\n");
}

function contextFiles(rows) {
  return Object.fromEntries(
    rows.flatMap((row) => [
      [`bounded-contexts/${row.dir}/package.json`, `${JSON.stringify({ name: row.packageName })}\n`],
      [
        `bounded-contexts/${row.dir}/context.json`,
        `${JSON.stringify({ contextName: row.contextName, ...row.fields })}\n`,
      ],
    ]),
  );
}

function syntheticTree(rows, registries) {
  const rootDir = tempRoot();
  writeFiles(rootDir, {
    ...contextFiles(rows),
    [apiPath]: nodeRegistry("apiContextRegistry", registries.api ?? []),
    [workerPath]: nodeRegistry("workerContextRegistry", registries.worker ?? []),
    [adminPath]: webRegistry(registries.admin ?? []),
    [marketplacePath]: webRegistry(registries.marketplace ?? []),
    [publicPath]: webRegistry(registries.public ?? []),
  });
  return rootDir;
}

// One row per host-admission arm: each row reaches its registry through exactly
// one arm, so deleting that arm turns exactly that row into an extra entry.
const row = (dir, contextName, fields) => ({ dir, contextName, packageName: `@fixture/${dir}-package`, fields });
const armRows = {
  apiHost: row("row-api-host", "api-host", { apiDeployables: ["platform-api"] }),
  apiSource: row("row-api-source", "api-source", { sourceRuntimeDeployables: ["platform-api"] }),
  profiled: row("row-profiled", "profiled", { sourceRuntimeProfiles: ["public"] }),
  workerHost: row("row-worker-host", "worker-host", { runtimeDeployables: ["platform-worker"] }),
  workerSource: row("row-worker-source", "worker-source", { sourceRuntimeDeployables: ["platform-worker"] }),
  webDeployable: row("row-web-deployable", "web-deployable", {
    deployableContributions: [{ deployable: "marketplace-web" }],
  }),
  webShell: row("row-web-shell", "web-shell", {
    shellContributions: [{ deployable: "marketplace-web", slot: "navigation", key: "web-shell" }],
  }),
  noHost: row("row-no-host", "no-host", {}),
  absentHosts: row("row-absent-hosts", "absent-hosts", {
    apiDeployables: ["other-api"],
    runtimeDeployables: ["other-worker"],
    sourceRuntimeDeployables: ["other-host"],
    sourceRuntimeProfiles: [],
    deployableContributions: [{ deployable: "marketplace" }],
    shellContributions: [{ deployable: "marketplace", slot: "navigation", key: "absent-hosts" }],
  }),
};
const allArmRows = Object.values(armRows);
const conformingArmRegistries = {
  api: [armRows.apiHost, armRows.apiSource, armRows.profiled],
  worker: [armRows.profiled, armRows.workerHost, armRows.workerSource],
  marketplace: [armRows.webDeployable, armRows.webShell],
};

function armTree(registries = conformingArmRegistries, rows = allArmRows) {
  const rootDir = syntheticTree(rows, registries);
  // A manifest fragment without a workspace package.json is never admitted.
  writeFiles(rootDir, {
    "bounded-contexts/fragment/context.json": '{"contextName":"fragment","apiDeployables":["platform-api"]}\n',
  });
  return rootDir;
}

function copyRealTree() {
  const rootDir = tempRoot();
  const contextsRoot = path.join(repoRoot, "bounded-contexts");
  for (const entry of readdirSync(contextsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of ["package.json", "context.json", "context.source.mjs"]) {
      const source = path.join(contextsRoot, entry.name, file);
      if (existsSync(source))
        writeFiles(rootDir, { [`bounded-contexts/${entry.name}/${file}`]: readFileSync(source, "utf8") });
    }
  }
  for (const registry of CONTEXT_REGISTRIES) {
    writeFiles(rootDir, { [registry.path]: readFileSync(path.join(repoRoot, registry.path), "utf8") });
  }
  return rootDir;
}

function violationsFor(rootDir, options = {}) {
  return validateContextRegistries({ repoRoot: rootDir, ...options }).violations;
}

describe("context registry guard on the real tree", () => {
  it("binds all five registries to admitted discovery with no violation", () => {
    const result = validateContextRegistries();

    expect(result.violations).toEqual([]);
    expect(result.registries.map(({ path: registryPath, hostName }) => [registryPath, hostName])).toEqual([
      [apiPath, "platform-api"],
      [workerPath, "platform-worker"],
      [adminPath, "admin-web"],
      [marketplacePath, "marketplace-web"],
      [publicPath, "public-web"],
    ]);
    for (const registry of result.registries) {
      expect(registry.expected.length, registry.path).toBeGreaterThan(0);
      expect(registry.actual, registry.path).toEqual(registry.expected);
    }
  });

  it("keeps every retired registry path untracked", () => {
    const tracked = execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "ls-files",
        "--",
        "deployables/*/src/generated/*context-registry*",
        "deployables/*/app/generated/*context-registry*",
        "infrastructure/platform-runtime/*context-registry*",
        ...RETIRED_CONTEXT_REGISTRY_PATHS,
      ],
      { encoding: "utf8", maxBuffer: GIT_LISTING_MAX_BUFFER },
    );

    expect(tracked).toBe("");
    expect(RETIRED_CONTEXT_REGISTRY_PATHS.filter((file) => existsSync(path.join(repoRoot, file)))).toEqual([]);
  });
});

describe("host admission arm table", () => {
  it("is the exported ordered production table shared with sandbox ownership", () => {
    expect(CONTEXT_REGISTRY_HOST_ARMS).toEqual([
      { registryKind: "api", field: "apiDeployables", match: "host" },
      { registryKind: "api", field: "sourceRuntimeDeployables", match: "host" },
      { registryKind: "api", field: "sourceRuntimeProfiles", match: "profile" },
      { registryKind: "worker", field: "runtimeDeployables", match: "host" },
      { registryKind: "worker", field: "sourceRuntimeDeployables", match: "host" },
      { registryKind: "worker", field: "sourceRuntimeProfiles", match: "profile" },
      { registryKind: "web", field: "deployableContributions", match: "contribution" },
      { registryKind: "web", field: "shellContributions", match: "contribution" },
    ]);
    expect(Object.isFrozen(CONTEXT_REGISTRY_HOST_ARMS)).toBe(true);
    expect(CONTEXT_REGISTRY_HOST_ARMS.every((arm) => Object.isFrozen(arm))).toBe(true);
    expect(
      allArmRows.filter((candidate) => contextManifestContributesToApiHost(candidate.fields, "platform-api")),
    ).toEqual(conformingArmRegistries.api);
  });

  it("accepts the isolating rows under the default and the explicit production table", () => {
    const rootDir = armTree();

    expect(violationsFor(rootDir)).toEqual([]);
    expect(violationsFor(rootDir, { hostArms: CONTEXT_REGISTRY_HOST_ARMS })).toEqual([]);
  });

  it.each([
    [0, apiPath, "api-host", "platform-api"],
    [1, apiPath, "api-source", "platform-api"],
    [2, apiPath, "profiled", "platform-api"],
    [3, workerPath, "worker-host", "platform-worker"],
    [4, workerPath, "worker-source", "platform-worker"],
    [5, workerPath, "profiled", "platform-worker"],
    [6, marketplacePath, "web-deployable", "marketplace-web"],
    [7, marketplacePath, "web-shell", "marketplace-web"],
  ])("rejects only the isolated row when arm %i is removed", (index, registryPath, contextName, hostName) => {
    const mutant = CONTEXT_REGISTRY_HOST_ARMS.filter((_arm, armIndex) => armIndex !== index);

    expect(mutant).toHaveLength(7);
    expect(violationsFor(armTree(), { hostArms: mutant })).toEqual([
      `${registryPath}: "${contextName}" is not admitted to ${hostName} by its context manifest`,
    ]);
  });

  it.each([
    ["no-fields", armRows.noHost, "api", apiPath, "platform-api"],
    ["no-fields", armRows.noHost, "worker", workerPath, "platform-worker"],
    ["all-hosts-absent", armRows.absentHosts, "api", apiPath, "platform-api"],
    ["all-hosts-absent", armRows.absentHosts, "worker", workerPath, "platform-worker"],
    ["all-hosts-absent", armRows.absentHosts, "marketplace", marketplacePath, "marketplace-web"],
    ["all-hosts-absent", armRows.absentHosts, "admin", adminPath, "admin-web"],
    ["marketplace-web-only", armRows.webDeployable, "public", publicPath, "public-web"],
  ])("rejects the %s row listed in the %s registry", (_label, extraRow, registry, registryPath, hostName) => {
    const registries = { ...conformingArmRegistries };
    registries[registry] = [...(registries[registry] ?? []), extraRow].sort((left, right) =>
      left.contextName.localeCompare(right.contextName, "en"),
    );

    expect(violationsFor(armTree(registries))).toEqual([
      `${registryPath}: "${extraRow.contextName}" is not admitted to ${hostName} by its context manifest`,
    ]);
  });

  it("rejects manifest drift in both directions", () => {
    const admitted = armTree();
    writeFiles(admitted, {
      "bounded-contexts/row-no-host/context.json": '{"contextName":"no-host","apiDeployables":["platform-api"]}\n',
    });
    expect(violationsFor(admitted)).toEqual([
      `${apiPath}: "no-host" is admitted to platform-api by its context manifest but has no entry`,
    ]);

    const withdrawn = armTree();
    writeFiles(withdrawn, {
      "bounded-contexts/row-api-host/context.json": '{"contextName":"api-host","apiDeployables":[]}\n',
    });
    expect(violationsFor(withdrawn)).toEqual([
      `${apiPath}: "api-host" is not admitted to platform-api by its context manifest`,
    ]);
  });

  it("excludes manifest fragments and unknown contexts from membership", () => {
    const fragment = row("fragment", "fragment", {});
    const bogus = row("row-bogus", "bogus", {});
    const registries = {
      ...conformingArmRegistries,
      api: [...conformingArmRegistries.api, { ...bogus }, { ...fragment, packageName: "@fixture/fragment" }],
    };

    expect(violationsFor(armTree(registries))).toEqual([
      `${apiPath}: "bogus" is not an admitted bounded context`,
      `${apiPath}: "fragment" is not an admitted bounded context`,
    ]);
  });
});

describe("context-name order", () => {
  // O1: directory order and context-name order disagree; only context-name order is accepted.
  const zulu = {
    dir: "a-first",
    contextName: "zulu",
    packageName: "@fixture/a-first",
    fields: { apiDeployables: ["platform-api"] },
  };
  const alpha = {
    dir: "z-last",
    contextName: "alpha",
    packageName: "@fixture/z-last",
    fields: { apiDeployables: ["platform-api"] },
  };

  it("accepts admitted context-name order", () => {
    expect(violationsFor(syntheticTree([zulu, alpha], { api: [alpha, zulu] }))).toEqual([]);
  });

  it("rejects directory order", () => {
    expect(violationsFor(syntheticTree([zulu, alpha], { api: [zulu, alpha] }))).toEqual([
      `${apiPath}: "zulu" is out of admitted context-name order; expected "alpha", "zulu"`,
    ]);
  });
});

describe("structural mutants of the real registries", () => {
  const catalogEntry = [
    "  {",
    '    contextName: "catalog",',
    '    packageName: "@chase-sets/catalog",',
    "    manifest: catalogManifest,",
    "    module: catalogModule,",
    "  },",
  ].join("\n");

  it("accepts the unmodified copy", () => {
    expect(violationsFor(copyRealTree())).toEqual([]);
  });

  it("S1 rejects a deleted entry left behind as a decoy comment", () => {
    const rootDir = copyRealTree();
    replaceOnce(
      rootDir,
      apiPath,
      catalogEntry,
      catalogEntry
        .split("\n")
        .map((line) => `  // ${line.trimStart()}`)
        .join("\n"),
    );

    expect(violationsFor(rootDir)).toEqual([
      `${apiPath}: "catalog" is admitted to platform-api by its context manifest but has no entry`,
      `${apiPath}: import catalogManifest from "@chase-sets/catalog" is used by 0 entries; each import belongs to exactly one entry`,
      `${apiPath}: import catalogModule from "@chase-sets/catalog" is used by 0 entries; each import belongs to exactly one entry`,
    ]);
  });

  it("S2 rejects a changed packageName", () => {
    const rootDir = copyRealTree();
    replaceOnce(
      rootDir,
      apiPath,
      'packageName: "@chase-sets/catalog",',
      'packageName: "@chase-sets/catalog-registry",',
    );

    expect(violationsFor(rootDir)).toEqual([
      `${apiPath}: "catalog" declares packageName "@chase-sets/catalog-registry" but its workspace package is "@chase-sets/catalog"`,
    ]);
  });

  it("S3 rejects another context's import alias", () => {
    const rootDir = copyRealTree();
    replaceOnce(rootDir, workerPath, "    manifest: catalogManifest,\n", "    manifest: channelsManifest,\n");

    expect(violationsFor(rootDir)).toEqual([
      `${workerPath}: "catalog" manifest channelsManifest is contextManifest from "@chase-sets/channels", not contextManifest from "@chase-sets/catalog"`,
      `${workerPath}: import catalogManifest from "@chase-sets/catalog" is used by 0 entries; each import belongs to exactly one entry`,
      `${workerPath}: import channelsManifest from "@chase-sets/channels" is used by 2 entries; each import belongs to exactly one entry`,
    ]);
  });

  it.each([
    ["API without as const", apiPath, "] as const;", "];", "export const apiContextRegistry = [...] as const;"],
    [
      "worker declared with let",
      workerPath,
      "export const workerContextRegistry",
      "export let workerContextRegistry",
      "export const workerContextRegistry = [...] as const;",
    ],
    [
      "web without as const",
      publicPath,
      "] as const satisfies WebContextRegistry;",
      "] satisfies WebContextRegistry;",
      "export const webContextRegistry = [...] as const satisfies WebContextRegistry;",
    ],
    [
      "web with a widening annotation",
      adminPath,
      "export const webContextRegistry = [",
      "export const webContextRegistry: WebContextRegistry = [",
      "export const webContextRegistry = [...] as const satisfies WebContextRegistry;",
    ],
  ])("S4 rejects the %s export shape while membership stays green", (_label, registryPath, from, to, expected) => {
    const rootDir = copyRealTree();
    replaceOnce(rootDir, registryPath, from, to);

    expect(violationsFor(rootDir)).toEqual([`${registryPath}: registry export must be exactly \`${expected}\``]);
  });

  it.each([
    ["root", "@chase-sets/pricing"],
    ["server", "@chase-sets/pricing/server"],
  ])("S5 rejects a %s web import", (_label, specifier) => {
    const rootDir = copyRealTree();
    replaceOnce(
      rootDir,
      marketplacePath,
      'import pricingManifest from "@chase-sets/pricing/context";',
      `import pricingManifest from "${specifier}";`,
    );

    expect(violationsFor(rootDir)).toEqual([
      `${marketplacePath}: web registries import only "<package>/context" manifests; "${specifier}" is forbidden`,
      `${marketplacePath}: "pricing" manifest pricingManifest is not an imported binding`,
    ]);
  });

  it("S5 rejects a dynamic web import", () => {
    const rootDir = copyRealTree();
    replaceOnce(
      rootDir,
      marketplacePath,
      'import pricingManifest from "@chase-sets/pricing/context";',
      'const pricingManifest = (await import("@chase-sets/pricing/context")).default;',
    );

    expect(violationsFor(rootDir)).toEqual([
      `${marketplacePath}: dynamic import of "@chase-sets/pricing/context" is forbidden`,
      `${marketplacePath}: unsupported top-level statement \`const pricingManifest = (await import("@chase-sets/pricing/context")).default;\``,
      `${marketplacePath}: "pricing" manifest pricingManifest is not an imported binding`,
    ]);
  });

  it("rejects duplicate, spread and unsupported entries", () => {
    const duplicate = copyRealTree();
    replaceOnce(duplicate, apiPath, catalogEntry, `${catalogEntry}\n${catalogEntry}`);
    expect(violationsFor(duplicate)).toEqual([
      `${apiPath}: "catalog" has a duplicate entry`,
      `${apiPath}: import catalogManifest from "@chase-sets/catalog" is used by 2 entries; each import belongs to exactly one entry`,
      `${apiPath}: import catalogModule from "@chase-sets/catalog" is used by 2 entries; each import belongs to exactly one entry`,
    ]);

    const spread = copyRealTree();
    replaceOnce(spread, apiPath, "] as const;", "  ...[],\n] as const;");
    expect(violationsFor(spread)).toEqual([`${apiPath}: entry 21 is a spread; entries must be written out`]);

    const shorthand = copyRealTree();
    replaceOnce(shorthand, apiPath, "    module: catalogModule,\n", "    catalogModule,\n");
    expect(violationsFor(shorthand)).toEqual([
      `${apiPath}: "catalog" (entry 3) has an unsupported property form`,
      `${apiPath}: "catalog" is admitted to platform-api by its context manifest but has no entry`,
      `${apiPath}: import catalogManifest from "@chase-sets/catalog" is used by 0 entries; each import belongs to exactly one entry`,
      `${apiPath}: import catalogModule from "@chase-sets/catalog" is used by 0 entries; each import belongs to exactly one entry`,
    ]);
  });
});

describe("retired registry paths", () => {
  const [retiredApi] = RETIRED_CONTEXT_REGISTRY_PATHS;
  const retiredInfrastructure = RETIRED_CONTEXT_REGISTRY_PATHS.slice(5);

  it("names the seven retired paths exactly", () => {
    expect(RETIRED_CONTEXT_REGISTRY_PATHS).toEqual([
      "deployables/platform-api/src/generated/api-context-registry.ts",
      "deployables/platform-worker/src/generated/worker-context-registry.ts",
      "deployables/admin-web/app/generated/web-context-registry.ts",
      "deployables/marketplace/app/generated/web-context-registry.ts",
      "deployables/public-web/app/generated/web-context-registry.ts",
      "infrastructure/platform-runtime/api-context-registry.generated.ts",
      "infrastructure/platform-runtime/web-context-registry.generated.ts",
    ]);
  });

  it("reports the old API file planted beside all five new modules without deleting it", () => {
    const rootDir = copyRealTree();
    writeFiles(rootDir, { [retiredApi]: "// legacy\n" });

    expect(CONTEXT_REGISTRIES.every((registry) => existsSync(path.join(rootDir, registry.path)))).toBe(true);
    expect(violationsFor(rootDir)).toEqual([`${retiredApi}: ${retiredMessage}`]);
    expect(readFileSync(path.join(rootDir, retiredApi), "utf8")).toBe("// legacy\n");
  });

  it.each(retiredInfrastructure)("reports %s independently without deleting it", (retiredPath) => {
    const rootDir = copyRealTree();
    writeFiles(rootDir, { [retiredPath]: "// legacy\n" });

    expect(violationsFor(rootDir)).toEqual([`${retiredPath}: ${retiredMessage}`]);
    expect(readFileSync(path.join(rootDir, retiredPath), "utf8")).toBe("// legacy\n");
  });

  it("reports both infrastructure files together with both diagnostics", () => {
    const rootDir = copyRealTree();
    writeFiles(rootDir, Object.fromEntries(retiredInfrastructure.map((file) => [file, "// legacy\n"])));

    expect(violationsFor(rootDir)).toEqual(retiredInfrastructure.map((file) => `${file}: ${retiredMessage}`));
  });

  it("reports every surviving retired path and a missing new module", () => {
    const rootDir = copyRealTree();
    writeFiles(rootDir, Object.fromEntries(RETIRED_CONTEXT_REGISTRY_PATHS.map((file) => [file, "// legacy\n"])));
    rmSync(path.join(rootDir, publicPath));

    expect(violationsFor(rootDir)).toEqual([
      ...RETIRED_CONTEXT_REGISTRY_PATHS.map((file) => `${file}: ${retiredMessage}`),
      `${publicPath}: context registry is missing`,
    ]);
  });
});
