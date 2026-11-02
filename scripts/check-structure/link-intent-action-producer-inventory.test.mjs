import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { deriveLinkIntentOrigins, deriveOwnerLinkTypes } from "./generate-link-intents.mjs";
import { deriveActionProducers, verifyActionProducers } from "./link-intent-action-producer-inventory.mjs";
import { findLinkIntentExportViolation, isAllowedPublicExportName } from "./run.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const registrations = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "link-intent-action-producers.json"), "utf8"),
);
const arbitrary = {
  path: "contracts/primitives/odd-sibling.ts",
  source:
    'import type { NotificationMessage as N } from "@chase-sets/outbound-messaging"; export const f = (): N => ({ messageType: "odd.added", criticality: "operational", title: "Synthetic notice", body: "Synthetic notice", ["actionHref"]: "/items/one", templateId: "synthetic_notice", templateVersion: 1, locale: "en", templateData: {}, channels: [{ channel: "web", recipient: {} }], idempotencyKey: "synthetic-1", correlationId: "synthetic-1", actor: { userId: null } });',
};
const methodSiblings = [
  {
    ...arbitrary,
    source:
      'export const mappers = { build(): NotificationMessage { return { messageType: "odd.added", actionHref: "/items/one" }; } };',
  },
  {
    ...arbitrary,
    source:
      'export class Mapper { map(): NotificationMessage { return { messageType: "odd.added", actionHref: "/items/one" }; } }',
  },
];
let rows;
let fixtureRoot;

it("admits only the exact generated owner link-intent integration surface", () => {
  expect(isAllowedPublicExportName("./integration/link-intents")).toBe(true);
  for (const surface of [
    "./integration/*",
    "./integration/link-intents/*",
    "./integration/arbitrary",
    "./integration/link-intents/extra",
  ])
    expect(isAllowedPublicExportName(surface)).toBe(false);
  for (const generated of deriveOwnerLinkTypes(root))
    expect(generated.path).toMatch(/\/support\/runtime-support\/link-intents\.ts$/);
  const manifest = JSON.parse(readFileSync(path.join(root, "bounded-contexts/discovery/context.json"), "utf8"));
  expect(findLinkIntentExportViolation(manifest, "./support/runtime-support/link-intents.ts")).toBeNull();
  expect(findLinkIntentExportViolation(manifest, "./server.ts")).toMatch(/generated runtime-support builder/);
  expect(
    findLinkIntentExportViolation({ deployableContributions: [] }, "./support/runtime-support/link-intents.ts"),
  ).toMatch(/owner-published canonical route metadata/);
});

beforeAll(() => {
  rows = deriveActionProducers();
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "cs-link-intents-"));
  const manifests = execFileSync("git", ["ls-files", "bounded-contexts/*/context.json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .trim()
    .split(/\r?\n/);
  const files = [
    ...new Set([
      ...rows.map((row) => row.path),
      ...manifests,
      ...deriveOwnerLinkTypes(root).map((file) => file.path),
      "scripts/environment-hosts.json",
      deriveLinkIntentOrigins(root).path,
    ]),
  ];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(fixtureRoot, file)), { recursive: true });
    writeFileSync(path.join(fixtureRoot, file), readFileSync(path.join(root, file)));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: fixtureRoot });
  execFileSync("git", ["add", "."], { cwd: fixtureRoot });
});

function findCheckoutOnlyScriptImports(repoRoot) {
  const files = execFileSync("git", ["ls-files", "-z", "infrastructure", "bounded-contexts", "contracts", "packages"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split("\0")
    .filter(
      (file) =>
        /\.[cm]?[jt]sx?$/.test(file) &&
        !/\.(?:test|spec)\.|(?:^|\/)(?:tests?|e2e|fixtures?)\/|(?:^|\/)(?:vitest|vite|react-router)\.config\./.test(
          file,
        ),
    );
  const violations = [];
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    // Escaped specifiers can spell scripts without that literal substring.
    if (!source.includes("scripts") && !source.includes("\\")) continue;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require")
            ? node.arguments[0]
            : null;
      if (
        specifier &&
        ts.isStringLiteralLike(specifier) &&
        specifier.text.startsWith(".") &&
        path.resolve(repoRoot, path.dirname(file), specifier.text).startsWith(path.join(repoRoot, "scripts") + path.sep)
      )
        violations.push(`${file}: ${specifier.text}`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return violations;
}

it("shipped runtime sources never import checkout-only scripts", () => {
  expect(findCheckoutOnlyScriptImports(root)).toEqual([]);
});

it("reports a Git-tracked shipped source importing checkout-only scripts", () => {
  const file = "contracts/primitives/synthetic-checkout-import.ts";
  const filename = path.join(fixtureRoot, file);
  const specifier = "../../scripts/synthetic-checkout-only.mjs";
  const sources = [
    `import value from "${specifier}";`,
    `export { value } from "${specifier}";`,
    `export * from "${specifier}";`,
    `import("${specifier}");`,
    `require("${specifier}");`,
    'import("../../scr\\u0069pts/synthetic-checkout-only.mjs");',
    'require("../../scr\\ipts/synthetic-checkout-only.mjs");',
    `import(\`${specifier}\`);`,
  ];
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, sources[0]);
  execFileSync("git", ["add", file], { cwd: fixtureRoot });
  try {
    for (const source of sources) {
      writeFileSync(filename, source);
      expect(findCheckoutOnlyScriptImports(fixtureRoot), source).toEqual([`${file}: ${specifier}`]);
    }
    writeFileSync(
      filename,
      [
        '// import("../../scripts/comment-only.mjs");',
        'const documentation = "../../scripts/string-only.mjs";',
        'import allowed from "./scripts/not-checkout-only.mjs";',
        'import packageName from "scripts/not-a-relative-import";',
        'import("../../scripts/" + filename);',
        'loader.require("../../scripts/not-a-bare-require.mjs");',
      ].join("\n"),
    );
    expect(findCheckoutOnlyScriptImports(fixtureRoot)).toEqual([]);
  } finally {
    execFileSync("git", ["add", file], { cwd: fixtureRoot });
    execFileSync("git", ["rm", "--cached", file], { cwd: fixtureRoot });
    rmSync(filename);
  }
});

it("runtime image inventory includes generated origins but not the host authority", () => {
  const runtime = readFileSync(path.join(root, "Dockerfile"), "utf8").split(" AS runtime")[1];
  expect(runtime).toContain("COPY --chown=node:node infrastructure ./infrastructure");
  expect(runtime).not.toContain("COPY --chown=node:node scripts/environment-hosts.json");
  expect(runtime).toContain("Only population assets may ship under scripts");
  expect(readFileSync(path.join(root, deriveLinkIntentOrigins(root).path), "utf8").replaceAll("\r\n", "\n")).toBe(
    deriveLinkIntentOrigins(root).source,
  );
});

it("generated runtime origins fail closed on indeterminate authority and stale output", () => {
  const authorityPath = path.join(fixtureRoot, "scripts/environment-hosts.json");
  const authoritySource = readFileSync(authorityPath, "utf8");
  const generatedPath = path.join(fixtureRoot, deriveLinkIntentOrigins(root).path);
  const generatedSource = readFileSync(generatedPath, "utf8");
  try {
    writeFileSync(generatedPath, generatedSource + "// synthetic stale output\n");
    expect(verifyActionProducers(rows, { registrations, repoRoot: fixtureRoot })).toContain(
      `Stale generated link intents ${deriveLinkIntentOrigins(root).path}`,
    );
    const authority = JSON.parse(authoritySource);
    const removed = authority.hosts.find(
      (row) => row.class === "application" && row.environment === "production" && !row.templated,
    );
    authority.hosts = authority.hosts.filter((row) => row !== removed);
    writeFileSync(authorityPath, JSON.stringify(authority));
    expect(() => deriveLinkIntentOrigins(fixtureRoot)).toThrow(/Indeterminate canonical origin/);
  } finally {
    writeFileSync(authorityPath, authoritySource);
    writeFileSync(generatedPath, generatedSource);
  }
});

afterAll(() => {
  if (!fixtureRoot) return;
  if (!path.resolve(fixtureRoot).startsWith(`${path.resolve(tmpdir())}${path.sep}cs-link-intents-`))
    throw new Error("Unsafe fixture cleanup path");
  rmSync(fixtureRoot, { recursive: true, force: true });
});

it("link-intent-action-producer-inventory", () => {
  expect(rows.length).toBeGreaterThan(30);
  expect(rows.find((row) => row.function === "mapWaitlistAdmissionToTransactionalEmail").fields).toContainEqual(
    expect.objectContaining({ field: "registrationPath" }),
  );
  expect(verifyActionProducers(rows)).toEqual([]);
  expect(verifyActionProducers(rows.slice(1))).not.toEqual([]);
  expect(verifyActionProducers([...rows, { ...rows[0], id: "stale-row" }])).not.toEqual([]);
});

it("producer digests and fields are independent of checkout line endings", () => {
  const source = arbitrary.source.replaceAll("; ", ";\n").replaceAll(", ", ",\n");
  const lf = deriveActionProducers({ extraSources: [{ ...arbitrary, source }] });
  const crlf = deriveActionProducers({ extraSources: [{ ...arbitrary, source: source.replaceAll("\n", "\r\n") }] });
  expect(crlf).toEqual(lf);
});

it("discovers aliased email constructors and typed message values without literal message types", () => {
  const source = `import { createTransactionalEmailNotificationMessage as email } from "@chase-sets/outbound-messaging";
import type { NotificationMessage as N } from "@chase-sets/outbound-messaging";
export const makeEmail = () => email({ messageType: input.type, templateData: { registrationPath: input.path } });
export const makeNotice = () => { const result: N = { messageType: input.type, actionHref: input.href }; return result; };`;
  const added = deriveActionProducers({ extraSources: [{ ...arbitrary, source }] }).filter(
    (row) => row.path === arbitrary.path,
  );
  expect(added.map((row) => row.function)).toEqual(["makeEmail", "makeNotice"]);
  expect(added.map((row) => row.fields.map((field) => field.field))).toEqual([["registrationPath"], ["actionHref"]]);
});

it("discovers accessor and constructor producer scopes without attributing nested methods to their caller", () => {
  const source = `export class Mapper {
    constructor() { const notice = { messageType: "odd.constructor", actionHref: "/items/one" }; }
    get notice(): NotificationMessage { return { messageType: "odd.getter", actionHref: "/items/one" }; }
    set notice(value: NotificationMessage) { const notice = { messageType: "odd.setter", actionHref: "/items/one" }; }
  }
  export function factory() { return { build(): NotificationMessage { return { messageType: "odd.method", actionHref: "/items/one" }; } }; }`;
  const added = deriveActionProducers({ repoRoot: fixtureRoot, extraSources: [{ ...arbitrary, source }] }).filter(
    (row) => row.path === arbitrary.path,
  );
  expect(added).toHaveLength(4);
  expect(added.map((row) => row.function)).toContain("Mapper.constructor");
  expect(added.some((row) => row.function === "factory")).toBe(false);
  expect(added.every((row) => row.fields.length === 1)).toBe(true);
});

it("owner-builder proof follows object and class method helpers and rejects raw helper returns", () => {
  for (const declaration of [
    'export const mappers = { href() { return links("item-detail", { path: { id: "one" } }).href; }, build(): NotificationMessage { return { messageType: "odd.method", actionHref: mappers.href() }; } };',
    'export class Mapper { href() { return links("item-detail", { path: { id: "one" } }).href; } map(): NotificationMessage { return { messageType: "odd.method", actionHref: this.href() }; } }',
  ]) {
    const source = 'import { links } from "@chase-sets/discovery/integration/link-intents";\n' + declaration;
    const filename = path.join(fixtureRoot, arbitrary.path);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, source);
    const added = deriveActionProducers({ repoRoot: fixtureRoot, extraSources: [{ ...arbitrary, source }] }).filter(
      (row) => row.path === arbitrary.path,
    );
    const classified = [
      ...registrations,
      ...added.map((row) => ({
        ...row,
        fields: row.fields.map(({ field, expression }) => ({ field, expression })),
        classification: "business-navigation",
        reason: "Synthetic method-helper control",
        intentIds: ["discovery.item-detail"],
      })),
    ];
    try {
      expect(verifyActionProducers([...rows, ...added], { registrations: classified, repoRoot: fixtureRoot })).toEqual(
        [],
      );
      writeFileSync(filename, source.replace('links("item-detail", { path: { id: "one" } }).href', '"/items/one"'));
      expect(
        verifyActionProducers([...rows, ...added], { registrations: classified, repoRoot: fixtureRoot }),
      ).toContainEqual(expect.stringContaining("Unproved owner builder"));
    } finally {
      rmSync(filename);
    }
  }
});

it("changed producer implementation fails even when inventoried fields remain unchanged", () => {
  const changed = { ...rows[0], sourceDigest: "synthetic-changed-implementation" };
  expect(verifyActionProducers([changed, ...rows.slice(1)])).toContain(`Stale producer implementation ${changed.id}`);
});

it("unclassified-producer candidate-versus-bypass mutant", async () => {
  const source = readFileSync(path.join(import.meta.dirname, "link-intent-action-producer-inventory.mjs"), "utf8");
  const guard =
    /if \(!registration\) \{\s*violations.push\(`Unclassified action producer \$\{row.id\}`\);\s*continue;\s*\}/;
  expect(source.match(guard)).not.toBeNull();
  const bypassSource = source
    .replace(guard, "if (!registration) continue;")
    .replace('path.resolve(import.meta.dirname, "../..")', JSON.stringify(root))
    .replace(
      /path.join\(import.meta.dirname,\s*"link-intent-action-producers.json",?\s*\)/,
      JSON.stringify(path.join(import.meta.dirname, "link-intent-action-producers.json")),
    )
    .replace(
      '"@chase-sets/typescript-compiler-api"',
      JSON.stringify(import.meta.resolve("@chase-sets/typescript-compiler-api")),
    )
    .replace(
      '"./generate-link-intents.mjs"',
      JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "generate-link-intents.mjs")).href),
    )
    .replace(
      '"../lib/git-listing.mjs"',
      JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "../lib/git-listing.mjs")).href),
    );
  const bypass = await import(`data:text/javascript;base64,${Buffer.from(bypassSource).toString("base64")}`);
  for (const sibling of [arbitrary, ...methodSiblings]) {
    const withSibling = deriveActionProducers({ extraSources: [sibling] });
    expect(withSibling.length, sibling.source).toBeGreaterThan(rows.length);
    expect(verifyActionProducers(withSibling)).toContainEqual(expect.stringContaining("Unclassified action producer"));
    expect(bypass.verifyActionProducers(withSibling), "unclassified-producer-check-bypassed").toEqual([]);
  }
});

it("real Git-tracked producer partition and arbitrary sibling addition", () => {
  const positive = deriveActionProducers({ repoRoot: fixtureRoot });
  expect(positive.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  expect(verifyActionProducers(positive, { registrations, repoRoot: fixtureRoot })).toEqual([]);
  for (const sibling of [
    arbitrary,
    { ...arbitrary, path: arbitrary.path.replace(".ts", ".db.ts") },
    ...methodSiblings,
  ]) {
    const siblingPath = sibling.path;
    mkdirSync(path.dirname(path.join(fixtureRoot, siblingPath)), { recursive: true });
    writeFileSync(path.join(fixtureRoot, siblingPath), sibling.source);
    execFileSync("git", ["add", siblingPath], { cwd: fixtureRoot });
    try {
      const added = deriveActionProducers({ repoRoot: fixtureRoot });
      expect(
        verifyActionProducers(added, { registrations, repoRoot: fixtureRoot }).some((error) =>
          error.includes("Unclassified action producer"),
        ),
        siblingPath,
      ).toBe(true);
    } finally {
      execFileSync("git", ["rm", "--cached", siblingPath], { cwd: fixtureRoot });
    }
  }
});

it("real Git-tracked producer omission", () => {
  const omitted = rows[0].path;
  execFileSync("git", ["rm", "--cached", omitted], { cwd: fixtureRoot });
  try {
    expect(
      verifyActionProducers(deriveActionProducers({ repoRoot: fixtureRoot }), {
        registrations,
        repoRoot: fixtureRoot,
      }).some((error) => error.includes("Missing action producer")),
    ).toBe(true);
  } finally {
    execFileSync("git", ["add", omitted], { cwd: fixtureRoot });
  }
});

it("real producer stale binding fails even with unchanged sink fields and a retained owner import", () => {
  const business = rows.find((row) => row.function === "mapRepricingDigestToNotification");
  const businessPath = path.join(fixtureRoot, business.path);
  const source = readFileSync(businessPath, "utf8");
  writeFileSync(
    businessPath,
    source.replace('links("account-desk-repricing", { path: {} }).href', '"/account/desk/repricing"'),
  );
  try {
    expect(
      verifyActionProducers(deriveActionProducers({ repoRoot: fixtureRoot }), {
        registrations,
        repoRoot: fixtureRoot,
      }).some((error) => error.includes("Unproved owner builder")),
    ).toBe(true);
  } finally {
    writeFileSync(businessPath, source);
  }
});
