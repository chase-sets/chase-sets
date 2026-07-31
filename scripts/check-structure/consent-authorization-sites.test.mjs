import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  analyzeConsentAuthorizationSites,
  collectConsentAuthorizationRegistryViolations,
  consentAuthorizationConstructors,
  consentAuthorizationRequiredFamilies,
  enumerateConsentAuthorizationCorpus,
  isConsentAuthorizationTestSource,
  loadConsentAuthorizationRegistry,
  loadConsentAuthorizationRegistrySchema,
} from "./consent-authorization-sites.mjs";

const registry = loadConsentAuthorizationRegistry();
const schema = loadConsentAuthorizationRegistrySchema();
const fixtureRoot = path.join(repoRoot, "scripts/check-structure/fixtures/consent-authorization-sites");
const temporaryRoots = [];

const fixtureFiles = [
  [
    "consent-recording-authorization.ts",
    "bounded-contexts/identity/features/consents/domain/consent-recording-authorization.ts",
  ],
  ["terms-route.ts", "bounded-contexts/identity/features/consents/api/terms-route.ts"],
  ["route.ts", "bounded-contexts/identity/features/consents/api/route.ts"],
  ["api.ts", "bounded-contexts/identity/api.ts"],
  ["seed.ts", "bounded-contexts/identity/support/runtime-support/seed.ts"],
  ["admin-qa-actor-fixtures.ts", "bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts"],
];

function write(root, relativeFile, content) {
  const absolute = path.join(root, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createFixtureRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "consent-authorization-sites-"));
  temporaryRoots.push(root);
  git(root, ["init", "--quiet"]);
  write(root, ".gitignore", "generated/\n");
  for (const [fixture, target] of fixtureFiles) {
    write(root, target, readFileSync(path.join(fixtureRoot, fixture), "utf8"));
  }
  for (const family of consentAuthorizationRequiredFamilies.filter((value) => value !== "bounded-contexts")) {
    write(root, `${family}/corpus-probe.${family === "scripts" ? "mjs" : "ts"}`, "export const corpusProbe = true;\n");
  }
  git(root, ["add", "--all"]);
  return root;
}

function mutate(root, relativeFile, transform) {
  const absolute = path.join(root, relativeFile);
  writeFileSync(absolute, transform(readFileSync(absolute, "utf8")));
}

function analyzeFixture(root, options = {}) {
  return analyzeConsentAuthorizationSites({
    repoRoot: root,
    registry: structuredClone(registry),
    schema,
    ...options,
  });
}

function codes(result) {
  return result.violations.map((violation) => violation.code);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Consent authorization site registry", () => {
  it("is recursively closed and freezes the exact 2/1/3 semantic partition", () => {
    expect(collectConsentAuthorizationRegistryViolations(registry, schema)).toEqual([]);
    expect(registry.sites).toHaveLength(6);
    expect(
      registry.sites.reduce((counts, site) => ({ ...counts, [site.classification]: counts[site.classification] + 1 }), {
        actor: 0,
        "self-registration": 0,
        provisioning: 0,
      }),
    ).toEqual({ actor: 2, "self-registration": 1, provisioning: 3 });
    expect(
      registry.sites
        .filter((site) => site.classification === "provisioning")
        .every((site) => site.reason.includes("#6120")),
    ).toBe(true);
  });

  it("rejects unknown nested registry data and a mismatched constructor classification", () => {
    const unknown = structuredClone(registry);
    unknown.sites[0].line = 98;
    expect(collectConsentAuthorizationRegistryViolations(unknown, schema)).toContain(
      '<root>/sites[0]: unknown member "line"',
    );

    const reclassified = structuredClone(registry);
    reclassified.sites[3].classification = "actor";
    expect(collectConsentAuthorizationRegistryViolations(reclassified, schema)).toContain(
      "sites[3]: constructor and classification disagree",
    );
  });
});

describe("Consent authorization source discovery", () => {
  it("uses the exact NUL-delimited tracked-plus-untracked-nonignored Git authority", () => {
    let captured;
    const corpus = enumerateConsentAuthorizationCorpus({
      repoRoot,
      execGit(args) {
        captured = args;
        return "bounded-contexts/example.ts\0scripts/example.test.mjs\0README.md\0";
      },
    });
    expect(captured).toEqual(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    expect(corpus.candidates).toEqual(["bounded-contexts/example.ts"]);
    expect(corpus.surface).toEqual({ scanned: 1, total: 1 });
  });

  it("defines the non-test exclusions without excluding unrelated fixture paths", () => {
    for (const file of [
      "module.test.ts",
      "module.db.test.ts",
      "bounded-contexts/identity/tests/module.ts",
      "deployables/marketplace/e2e/module.tsx",
      "scripts/check-structure/fixtures/arbitrary/module.mjs",
    ]) {
      expect(isConsentAuthorizationTestSource(file), file).toBe(true);
    }
    expect(isConsentAuthorizationTestSource("bounded-contexts/identity/fixtures/runtime.ts")).toBe(false);
    expect(isConsentAuthorizationTestSource("bounded-contexts/identity/module.ts")).toBe(false);
  });

  it("includes a genuine untracked nonignored source and discriminates removal of --others", () => {
    const root = createFixtureRepository();
    const clean = analyzeFixture(root);
    write(
      root,
      "arbitrary/new-authorization-home.ts",
      [
        'import { authorizeConsentForActor } from "../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";',
        "export function unexpectedOwner(context: unknown) {",
        "  return authorizeConsentForActor(context);",
        "}",
        "",
      ].join("\n"),
    );

    const discovered = analyzeFixture(root);
    expect(discovered.surface).toEqual({ scanned: clean.surface.scanned + 1, total: clean.surface.total + 1 });
    expect(codes(discovered)).toContain("consent-authorization-site-unregistered");

    const trackedOnly = analyzeFixture(root, {
      execGit: (args) =>
        git(
          root,
          args.filter((argument) => argument !== "--others"),
        ),
    });
    expect(trackedOnly.surface).toEqual(clean.surface);
    expect(trackedOnly.violations).toEqual([]);
  });

  it("excludes ignored generated source and discriminates removal of --exclude-standard", () => {
    const root = createFixtureRepository();
    const clean = analyzeFixture(root);
    write(
      root,
      "generated/authorization-output.ts",
      "export function generated(context: unknown) { return authorizeConsentForActor(context); }\n",
    );

    const ignored = analyzeFixture(root);
    expect(ignored.surface).toEqual(clean.surface);
    expect(ignored.partitionDigest).toBe(clean.partitionDigest);
    expect(ignored.violations).toEqual([]);

    const withoutIgnoreAwareness = analyzeFixture(root, {
      execGit: (args) =>
        git(
          root,
          args.filter((argument) => argument !== "--exclude-standard"),
        ),
    });
    expect(withoutIgnoreAwareness.surface.total).toBe(clean.surface.total + 1);
    expect(codes(withoutIgnoreAwareness)).toContain("consent-authorization-site-unregistered");
  });

  it("excludes test and e2e lookalikes from both the partition and scanned/total", () => {
    const root = createFixtureRepository();
    const clean = analyzeFixture(root);
    const lookalike = "export function lookalike(context: unknown) { return authorizeConsentForActor(context); }\n";
    write(root, "arbitrary/lookalike.db.test.ts", lookalike);
    write(root, "arbitrary/e2e/lookalike.ts", lookalike);
    const result = analyzeFixture(root);
    expect(result.surface).toEqual(clean.surface);
    expect(result.partitionDigest).toBe(clean.partitionDigest);
    expect(result.violations).toEqual([]);
  });

  it("fails a discovery mutant narrowed to bounded-contexts", () => {
    const root = createFixtureRepository();
    const narrowed = analyzeFixture(root, {
      execGit: (args) =>
        `${git(root, args)
          .split("\0")
          .filter((file) => file.startsWith("bounded-contexts/"))
          .join("\0")}\0`,
    });
    expect(codes(narrowed)).toContain("consent-authorization-corpus-narrowed");
    expect(narrowed.corpus.families).toEqual(["bounded-contexts"]);
  });
});

describe("Consent authorization AST partition", () => {
  it("reconciles the real tree with three declarations, five owning imports, and six sites", () => {
    const result = analyzeConsentAuthorizationSites();
    expect(result.violations).toEqual([]);
    expect(result.surface.scanned).toBe(result.surface.total);
    expect(result.corpus.families).toEqual(consentAuthorizationRequiredFamilies);
    expect(result.partition.declarations).toHaveLength(3);
    expect(result.partition.imports).toHaveLength(5);
    expect(result.partition.consumptions).toHaveLength(6);
    expect(result.partition.counts).toEqual({ actor: 2, "self-registration": 1, provisioning: 3 });
    expect(result.partition.consumptions.map((site) => site.owner).sort()).toEqual(
      registry.sites.map((site) => site.owner).sort(),
    );
  });

  it("keeps line-only movement in one owner green with an identical digest", () => {
    const root = createFixtureRepository();
    const clean = analyzeFixture(root);
    mutate(root, "bounded-contexts/identity/api.ts", (source) =>
      source.replace("async function", "\n\n\nasync function"),
    );
    const shifted = analyzeFixture(root);
    expect(shifted.violations).toEqual([]);
    expect(shifted.partitionDigest).toBe(clean.partitionDigest);
  });

  it("fails deletion of a registered site", () => {
    const root = createFixtureRepository();
    mutate(root, "bounded-contexts/identity/api.ts", (source) =>
      source.replace("authorizeConsentForSelfRegistration(userId, accountId)", "{ userId, accountId }"),
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-site-missing");
  });

  it("fails moving a site across its semantic owner", () => {
    const root = createFixtureRepository();
    mutate(root, "bounded-contexts/identity/api.ts", (source) =>
      source.replace("planPersonalIdentityRegistration", "movedRegistrationOwner"),
    );
    const resultCodes = codes(analyzeFixture(root));
    expect(resultCodes).toContain("consent-authorization-site-unregistered");
    expect(resultCodes).toContain("consent-authorization-site-missing");
  });

  it("fails reclassifying a provisioning site as actor", () => {
    const root = createFixtureRepository();
    mutate(root, "bounded-contexts/identity/support/runtime-support/seed.ts", (source) =>
      source.replace(
        "async function reconcileRepresentativeConsent(userId: unknown, accountId: unknown) {\n  return authorizeConsentForProvisioning",
        "async function reconcileRepresentativeConsent(userId: unknown, accountId: unknown) {\n  return authorizeConsentForActor",
      ),
    );
    const resultCodes = codes(analyzeFixture(root));
    expect(resultCodes).toContain("consent-authorization-site-unregistered");
    expect(resultCodes).toContain("consent-authorization-site-missing");
  });

  it("fails changing an exported constructor declaration", () => {
    const root = createFixtureRepository();
    mutate(root, "bounded-contexts/identity/features/consents/domain/consent-recording-authorization.ts", (source) =>
      source.replace("export function authorizeConsentForActor", "function authorizeConsentForActor"),
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-declaration-invalid");
  });

  it("fails a renamed import alias", () => {
    const root = createFixtureRepository();
    mutate(root, "bounded-contexts/identity/features/consents/api/terms-route.ts", (source) =>
      source
        .replace("import { authorizeConsentForActor }", "import { authorizeConsentForActor as actorAuthorization }")
        .replace("authorizeConsentForActor(context)", "actorAuthorization(context)"),
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-import-invalid");
  });

  it("fails an escaped identifier alias without narrowing the source prefilter", () => {
    const root = createFixtureRepository();
    mutate(
      root,
      "bounded-contexts/identity/features/consents/api/terms-route.ts",
      (source) =>
        `${source}\nconst escapedAuthorizationAlias = \\u0061uthorizeConsentForActor;\nvoid escapedAuthorizationAlias;\n`,
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-reference-unclassified");
  });

  it("fails an owning import redirected to a same-named non-canonical module", () => {
    const root = createFixtureRepository();
    mutate(root, "bounded-contexts/identity/features/consents/api/terms-route.ts", (source) =>
      source.replace(
        'from "../domain/consent-recording-authorization"',
        'from "../../../../../other/consent-recording-authorization"',
      ),
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-import-invalid");
  });

  it("fails a non-owning import binding", () => {
    const root = createFixtureRepository();
    mutate(
      root,
      "contracts/corpus-probe.ts",
      (source) =>
        `import { authorizeConsentForActor } from "../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";\n${source}`,
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-import-invalid");
  });

  it("fails an alias assignment while preserving the registered call", () => {
    const root = createFixtureRepository();
    mutate(
      root,
      "bounded-contexts/identity/features/consents/api/terms-route.ts",
      (source) => `${source}\nconst authorizationAlias = authorizeConsentForActor;\nvoid authorizationAlias;\n`,
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-reference-unclassified");
  });

  it("fails a local wrapper while preserving the registered call", () => {
    const root = createFixtureRepository();
    mutate(
      root,
      "bounded-contexts/identity/features/consents/api/terms-route.ts",
      (source) =>
        `${source}\nfunction localAuthorizationWrapper(context: unknown) {\n  return authorizeConsentForActor(context);\n}\nvoid localAuthorizationWrapper;\n`,
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-site-unregistered");
  });

  it("fails a re-export", () => {
    const root = createFixtureRepository();
    mutate(
      root,
      "contracts/corpus-probe.ts",
      (source) =>
        `${source}\nexport { authorizeConsentForActor } from "../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";\n`,
    );
    expect(codes(analyzeFixture(root))).toContain("consent-authorization-reference-unclassified");
  });

  it("fails either side of one-for-one source and registry reconciliation", () => {
    const root = createFixtureRepository();
    const missingRegistryEntry = structuredClone(registry);
    missingRegistryEntry.sites.shift();
    expect(codes(analyzeFixture(root, { registry: missingRegistryEntry }))).toContain(
      "consent-authorization-site-unregistered",
    );

    const extraRegistryEntry = structuredClone(registry);
    extraRegistryEntry.sites.push({
      ...extraRegistryEntry.sites[0],
      owner: "nonexistentOwner",
      reason: "Synthetic missing-source control.",
    });
    expect(codes(analyzeFixture(root, { registry: extraRegistryEntry }))).toContain(
      "consent-authorization-site-missing",
    );
  });

  it("recognizes only the three fixed constructor identifiers", () => {
    expect(consentAuthorizationConstructors).toEqual([
      "authorizeConsentForActor",
      "authorizeConsentForSelfRegistration",
      "authorizeConsentForProvisioning",
    ]);
  });
});
