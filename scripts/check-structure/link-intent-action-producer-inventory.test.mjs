import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deriveOwnerLinkTypes } from "./generate-link-intents.mjs";
import { deriveActionProducers, verifyActionProducers } from "./link-intent-action-producer-inventory.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const registrations = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "link-intent-action-producers.json"), "utf8"),
);
const arbitrary = {
  path: "contracts/primitives/odd-sibling.ts",
  source:
    'import type { NotificationMessage as N } from "@chase-sets/outbound-messaging"; export const f = (): N => ({ messageType: "odd.added", criticality: "operational", title: "Synthetic notice", body: "Synthetic notice", ["actionHref"]: "/items/one", templateId: "synthetic_notice", templateVersion: 1, locale: "en", templateData: {}, channels: [{ channel: "web", recipient: {} }], idempotencyKey: "synthetic-1", correlationId: "synthetic-1", actor: { userId: null } });',
};
let rows;
let fixtureRoot;

beforeAll(() => {
  rows = deriveActionProducers();
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "cs-link-intents-"));
  const manifests = execFileSync("git", ["ls-files", "bounded-contexts/*/context.json"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
  const files = [
    ...new Set([...rows.map((row) => row.path), ...manifests, ...deriveOwnerLinkTypes(root).map((file) => file.path)]),
  ];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(fixtureRoot, file)), { recursive: true });
    writeFileSync(path.join(fixtureRoot, file), readFileSync(path.join(root, file)));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: fixtureRoot });
  execFileSync("git", ["add", "."], { cwd: fixtureRoot });
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

it("changed producer implementation fails even when inventoried fields remain unchanged", () => {
  const changed = { ...rows[0], sourceDigest: "synthetic-changed-implementation" };
  expect(verifyActionProducers([changed, ...rows.slice(1)])).toContain(`Stale producer implementation ${changed.id}`);
});

it("unclassified-producer candidate-versus-bypass mutant", async () => {
  const withSibling = deriveActionProducers({ extraSources: [arbitrary] });
  expect(withSibling.length).toBeGreaterThan(rows.length);
  expect(verifyActionProducers(withSibling)).not.toEqual([]);
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
    );
  const bypass = await import(`data:text/javascript;base64,${Buffer.from(bypassSource).toString("base64")}`);
  expect(bypass.verifyActionProducers(withSibling), "unclassified-producer-check-bypassed").toEqual([]);
});

it("real Git-tracked producer partition and arbitrary sibling addition", () => {
  const positive = deriveActionProducers({ repoRoot: fixtureRoot });
  expect(positive.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  expect(verifyActionProducers(positive, { registrations, repoRoot: fixtureRoot })).toEqual([]);
  for (const siblingPath of [arbitrary.path, arbitrary.path.replace(".ts", ".db.ts")]) {
    mkdirSync(path.dirname(path.join(fixtureRoot, siblingPath)), { recursive: true });
    writeFileSync(path.join(fixtureRoot, siblingPath), arbitrary.source);
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
