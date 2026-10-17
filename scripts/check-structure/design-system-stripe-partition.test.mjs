import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDesignSystemComponentIndex } from "../generate-design-system-component-index.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const prefix = "packages/design-system/";
const layout = `${prefix}src/primitives/layout.tsx`;
const primitive = `${prefix}src/__tests__/primitive-gaps.test.tsx`;
const schema = `${prefix}src/theme/__fixtures__/ink-foil-candidate-tokens.schema.json`;
const index = `${prefix}COMPONENT_INDEX.md`;
const callers = new Set([
  "bounded-contexts/payments/features/payments/ui/account-payment/stripe-confirmation-card.tsx",
  "bounded-contexts/payments/features/payments/ui/account-payment/stripe-setup-card.tsx",
  "bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx",
  "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-notification-banner.tsx",
]);
const tags = ["stripe-connect-account-management", "stripe-connect-account-onboarding"];
const count = (text) => [...text.matchAll(/stripe/gi)].length;
const read = (path) => readFileSync(join(root, path), "utf8");

function trackedPaths() {
  return execFileSync("git", ["ls-files", "-z", "--", prefix], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

export function partitionFailures(paths, contents, generated) {
  const problems = [];
  const permitted = new Set([layout, primitive, schema, index]);
  for (const path of paths) {
    if (/stripe/i.test(path)) problems.push(`matching path: ${path}`);
    const source = contents[path] ?? "";
    if (count(source) && !permitted.has(path)) problems.push(`unexpected content: ${path}`);
  }
  const layoutSource = contents[layout] ?? "";
  for (const tag of tags) if (layoutSource.split(tag).length - 1 !== 5) problems.push(`layout tag count: ${tag}`);
  if (count(layoutSource) !== 10) problems.push("layout lexical count");
  const primitiveSource = contents[primitive] ?? "";
  if (
    count(primitiveSource) !== 3 ||
    !primitiveSource.includes('aria-label="Stripe payment"') ||
    tags.some((tag) => primitiveSource.split(tag).length - 1 !== 1)
  )
    problems.push("primitive role/count");
  const schemaSource = contents[schema] ?? "";
  if (count(schemaSource) !== 1 || !String(JSON.parse(schemaSource).description).includes("Stripe"))
    problems.push("schema /description");
  const actualIndex = contents[index] ?? "";
  if (actualIndex !== generated.content) problems.push("stale generated index");
  const expectedCount = generated.rows.filter(
    (row) => callers.has(row.exampleConsumer) && /stripe/i.test(row.exampleConsumer),
  ).length;
  let observedCount = 0;
  for (const line of actualIndex.split(/\r?\n/)) {
    if (!/stripe/i.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/g, ""));
    if (
      cells.length !== 4 ||
      cells.slice(0, 3).some((cell) => /stripe/i.test(cell)) ||
      !callers.has(cells[3]) ||
      count(cells[3]) !== 1
    )
      problems.push(`invalid index role/cell: ${line.slice(0, 100)}`);
    observedCount += count(line);
  }
  if (observedCount !== expectedCount || count(actualIndex) !== expectedCount) problems.push("index caller count");
  if (count(layoutSource) + count(primitiveSource) + count(schemaSource) !== 14) problems.push("hand-owned count");
  return problems;
}

export function selectorFailures(source) {
  const problems = [];
  for (const match of source.matchAll(/\[&>(stripe-connect-[\w-]+)\]/g)) {
    if (!tags.includes(match[1])) problems.push(`unexpected tag: ${match[1]}`);
  }
  for (const tag of tags) {
    for (const [size, base, responsive] of [
      ["md", 36, 44],
      ["lg", 44, 52],
    ]) {
      const block = source.match(new RegExp(`\\b${size}: cx\\(([\\s\\S]*?)\\n  \\),`))?.[1] ?? "";
      if (!block.includes(`[&>${tag}]:min-h-[${base}rem]`) || !block.includes(`md:[&>${tag}]:min-h-[${responsive}rem]`))
        problems.push(`${tag}/${size}`);
    }
    if (!source.includes(`[&>${tag}]:block`)) problems.push(`${tag}/block`);
  }
  return problems;
}

describe("closed tracked design-system provider partition", () => {
  it("is red on the unchanged dispatch predecessor's 13-file/122-token census", async () => {
    const base = "be97a105ae14a39571d5231c52b3883dcaeffb92";
    const matches = execFileSync("git", ["grep", "-il", "stripe", base, "--", prefix], { cwd: root, encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .map((line) => line.slice(base.length + 1));
    const contents = Object.fromEntries(
      matches.map((path) => [path, execFileSync("git", ["show", `${base}:${path}`], { cwd: root, encoding: "utf8" })]),
    );
    expect(matches).toHaveLength(13);
    expect(Object.values(contents).reduce((total, source) => total + count(source), 0)).toBe(122);
    const generated = await buildDesignSystemComponentIndex({ repoRoot: root });
    expect(partitionFailures(matches, contents, generated)).not.toEqual([]);
  });

  it("scans every tracked path/content and generator-owned caller cell", async () => {
    const paths = trackedPaths();
    const contents = Object.fromEntries(
      paths.filter((path) => existsSync(join(root, path))).map((path) => [path, read(path)]),
    );
    const generated = await buildDesignSystemComponentIndex({ repoRoot: root });
    expect(partitionFailures(paths, contents, generated)).toEqual([]);
    expect(trackedPaths()).toEqual(paths);
  });

  it("rejects unexpected identifiers, non-caller index cells and a bypassed refusal", async () => {
    const paths = trackedPaths();
    const contents = Object.fromEntries(
      paths.filter((path) => existsSync(join(root, path))).map((path) => [path, read(path)]),
    );
    const generated = await buildDesignSystemComponentIndex({ repoRoot: root });
    expect(
      partitionFailures(
        paths,
        { ...contents, [`${prefix}src/index.ts`]: `${contents[`${prefix}src/index.ts`]}\nconst stripeLeak = 1;` },
        generated,
      ),
    ).not.toEqual([]);
    const indexMutant = (contents[index] ?? "").replace("| Module |", "| stripeLeak Module |");
    expect(partitionFailures(paths, { ...contents, [index]: indexMutant }, generated)).not.toEqual([]);
    expect(partitionFailures([...paths, `${prefix}src/stripe-leak.ts`], contents, generated)).not.toEqual([]);
    const failures = partitionFailures(paths, { ...contents, [layout]: `${contents[layout]}\nstripeLeak` }, generated);
    expect(failures.length).toBeGreaterThan(0);
    expect(() => {
      if (failures.length) throw new Error(failures.join("; "));
    }).toThrow();
  });

  it("preserves the EmbeddedProviderSurface provider-tag selectors", () => {
    const source = read(layout);
    expect(selectorFailures(source)).toEqual([]);
    for (const tag of tags) {
      for (const fragment of [
        `[&>${tag}]:min-h-[36rem]`,
        `md:[&>${tag}]:min-h-[44rem]`,
        `[&>${tag}]:min-h-[44rem]`,
        `md:[&>${tag}]:min-h-[52rem]`,
        `[&>${tag}]:block`,
      ])
        expect(selectorFailures(source.replace(fragment, "removed"))).not.toEqual([]);
    }
    expect(selectorFailures(`${source}\n[&>stripe-connect-third]:block`)).not.toEqual([]);
    for (const mutation of [
      source.replace(
        "[&>stripe-connect-account-management]:min-h-[36rem]",
        "[&>Stripe-connect-account-management]:min-h-[36rem]",
      ),
      source.replace(
        "[&>stripe-connect-account-management]:min-h-[36rem]",
        "[&>stripe-connect-account-management]:min-h-[35rem]",
      ),
      source.replace("[&>stripe-connect-account-onboarding]:block", "[&>stripe-connect-account-onboarding]:hidden"),
    ])
      expect(selectorFailures(mutation)).not.toEqual([]);
  });
});
