import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

type SourceFile = Readonly<{ path: string; content: string }>;
type CallerRow = Readonly<{ path: string; classification: "attempt-producing" | "exempt"; shapes: readonly string[] }>;

/**
 * Every code shape that writes a Buy Cart. A shape is a write whatever file or
 * folder it appears in -- the partition never decides by path vocabulary.
 */
const CART_WRITE_SHAPES: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
  { name: "owner attempt", pattern: /\.executeCartAttempt\(/ },
  {
    name: "client cart write",
    pattern:
      /\.(?:addCartLine|addGuestCartLine|addCartLines|addGuestCartLines|submitCartCommands|submitGuestCartCommands|updateCartLineQuantity|updateGuestCartLineQuantity|updateCartLineFulfillment|updateGuestCartLineFulfillment|removeCartLine|removeGuestCartLine)\(/,
  },
  {
    name: "unkeyed cart service write",
    pattern: /\bcart\.(?:addLine|addLines|setLineQuantity|setLineFulfillment|removeLine|checkout)\(/,
  },
  { name: "direct cart aggregate write", pattern: /commandHandler\(\{[\s\S]{0,200}?checkout(?:\.cart-|CartStreamId)/ },
  { name: "ordered unkeyed writes", pattern: /writeCartCommandsInOrder/ },
];

/**
 * The census: each tracked caller and why it is safe. Attempt-producing
 * callers route every write through one Cart attempt; exemptions are proved
 * idempotent elsewhere (decision 7).
 */
const EXPECTED_PARTITION: readonly CallerRow[] = [
  {
    path: "bounded-contexts/checkout/features/cart/api/mcp.ts",
    classification: "attempt-producing",
    shapes: ["owner attempt"],
  },
  {
    path: "bounded-contexts/checkout/features/cart/api/route.ts",
    classification: "attempt-producing",
    shapes: ["owner attempt"],
  },
  // Cart Claim merge and claimCart write the aggregate directly: idempotent by line id / claim state.
  {
    path: "bounded-contexts/checkout/features/cart/api/runtime.ts",
    classification: "exempt",
    shapes: ["direct cart aggregate write"],
  },
  {
    path: "bounded-contexts/checkout/features/sessions/api/session-cleanup.ts",
    classification: "attempt-producing",
    shapes: ["owner attempt"],
  },
  {
    path: "bounded-contexts/checkout/routes/account-cart.tsx",
    classification: "attempt-producing",
    shapes: ["client cart write"],
  },
  // Seed reconciles from the authoritative stream by line id; boot-twice proof in cart-attempt.db.test.ts.
  {
    path: "bounded-contexts/checkout/support/runtime-support/seed.ts",
    classification: "exempt",
    shapes: ["direct cart aggregate write"],
  },
  {
    path: "bounded-contexts/discovery/routes/search.tsx",
    classification: "attempt-producing",
    shapes: ["client cart write"],
  },
  {
    path: "bounded-contexts/discovery/support/route-support/item-detail/action.ts",
    classification: "attempt-producing",
    shapes: ["client cart write"],
  },
];

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/;
const TEST_SOURCE = /(?:\.test\.|\.spec\.|\.browser\.|(?:^|\/)tests?\/|(?:^|\/)__tests__\/|test-support)/;

/**
 * Tracked sources only: the list comes from `git ls-files`, never a
 * working-tree walk, so ignored generated output (build trees, bundles) can
 * never join the partition however identical its bytes are.
 */
function listTrackedProductionSources(listTracked: () => readonly string[], read: (file: string) => string) {
  return listTracked()
    .filter((file) => SOURCE_EXTENSION.test(file) && !TEST_SOURCE.test(file))
    .map((file) => ({ path: file, content: read(file) }));
}

function gitLsFiles() {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--", "bounded-contexts", "deployables", "infrastructure", "contracts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
}

/**
 * Classifies every file that holds a cart-write shape. A client write counts as
 * attempt-producing only when the same file resolves it through
 * `submitCheckoutCartAttempt`; unkeyed service writes and ordered unkeyed
 * writes are never classifiable.
 */
function partitionCartWriteCallers(files: readonly SourceFile[]) {
  const rows: CallerRow[] = [];
  const unclassified: string[] = [];
  for (const file of files) {
    const shapes = CART_WRITE_SHAPES.filter((shape) => shape.pattern.test(file.content)).map((shape) => shape.name);
    if (shapes.length === 0 || file.path.endsWith("features/command-attempts/api/cart-attempt.ts")) {
      continue;
    }
    const expected = EXPECTED_PARTITION.find((row) => row.path === file.path);
    const forbidden = shapes.some(
      (shape) => shape === "unkeyed cart service write" || shape === "ordered unkeyed writes",
    );
    const clientWithoutAttempt =
      shapes.includes("client cart write") && !/\bsubmitCheckoutCartAttempt\(/.test(file.content);
    if (!expected || forbidden || clientWithoutAttempt || expected.shapes.join() !== shapes.join()) {
      unclassified.push(`${file.path}: ${shapes.join(", ")}`);
      continue;
    }
    rows.push({ path: file.path, classification: expected.classification, shapes });
  }
  return { rows, unclassified };
}

let trackedSourcesCache: readonly SourceFile[] | null = null;

/** The tracked production sources, read once per test file. */
function trackedSources() {
  trackedSourcesCache ??= listTrackedProductionSources(gitLsFiles, (file) =>
    readFileSync(path.join(repoRoot, file), "utf8"),
  );
  return trackedSourcesCache;
}

/** A tracked-tree scan reads thousands of files; give it room on a loaded host. */
const TREE_SCAN_TIMEOUT_MS = 180_000;

describe("checkout attempt caller partition", () => {
  it(
    "classifies every tracked cart-write caller as attempt-producing or a proved exemption",
    { timeout: TREE_SCAN_TIMEOUT_MS },
    () => {
      const { rows, unclassified } = partitionCartWriteCallers(trackedSources());

      expect(unclassified).toEqual([]);
      expect(rows.map((row) => `${row.path} ${row.classification}`).sort()).toEqual(
        EXPECTED_PARTITION.map((row) => `${row.path} ${row.classification}`).sort(),
      );
    },
  );

  it.each([
    ["a server-side removeLine", "await deps.cart.removeLine({ accountId, lineId }, context);"],
    ["an unkeyed client add", "await checkoutApi.addCartLine(cartLine);"],
    ["ordered unkeyed writes", "await writeCartCommandsInOrder(writes);"],
    [
      "a direct aggregate write",
      "await cart.commandHandler({ streamId: `checkout.cart-${owner}`, command, context });",
    ],
  ])("fails a planted tracked caller: %s", { timeout: TREE_SCAN_TIMEOUT_MS }, (_label, line) => {
    const planted = [
      ...trackedSources(),
      { path: "bounded-contexts/planted/features/synthetic/api/caller.ts", content: line },
    ];

    expect(partitionCartWriteCallers(planted).unclassified).toEqual([
      expect.stringContaining("bounded-contexts/planted/features/synthetic/api/caller.ts"),
    ]);
  });

  it(
    "never lets ignored generated output with identical bytes join the partition",
    { timeout: TREE_SCAN_TIMEOUT_MS },
    () => {
      const tracked = gitLsFiles();
      const generatedCopy = "deployables/marketplace/build/server/assets/search-synthetic.js";
      const contents = new Map(trackedSources().map((source) => [source.path, source.content]));
      // An unkeyed built copy that exists on disk but is not tracked: the read
      // function would serve it, yet the enumeration never asks for it.
      const builtCopy = contents
        .get("bounded-contexts/discovery/routes/search.tsx")!
        .replace(/submitCheckoutCartAttempt/g, "x");
      const readWithBuiltCopy = (file: string) => (file === generatedCopy ? builtCopy : (contents.get(file) ?? ""));

      const sources = listTrackedProductionSources(() => tracked, readWithBuiltCopy);

      expect(tracked).not.toContain(generatedCopy);
      expect(sources.map((source) => source.path)).not.toContain(generatedCopy);
      expect(partitionCartWriteCallers(sources).unclassified).toEqual([]);
      // Control: the same bytes, once tracked, are refused.
      expect(partitionCartWriteCallers([...sources, { path: generatedCopy, content: builtCopy }]).unclassified).toEqual(
        [expect.stringContaining(generatedCopy)],
      );
    },
  );

  it(
    "keeps zero references to writeCartCommandsInOrder and names every cart write in the context manifests",
    { timeout: TREE_SCAN_TIMEOUT_MS },
    () => {
      const tracked = trackedSources();
      expect(
        tracked.filter((file) => file.content.includes("writeCartCommandsInOrder")).map((file) => file.path),
      ).toEqual([]);

      const attemptRows = ["bounded-contexts/checkout/context.json", "bounded-contexts/discovery/context.json"].flatMap(
        (manifestPath) => {
          const manifest = JSON.parse(readFileSync(path.join(repoRoot, manifestPath), "utf8")) as {
            mutationConsistencyInventory?: readonly { commandAttempt?: Record<string, unknown> }[];
          };
          return (manifest.mutationConsistencyInventory ?? []).flatMap((entry) =>
            entry.commandAttempt ? [entry.commandAttempt] : [],
          );
        },
      );
      const writes = attemptRows.flatMap((row) => {
        for (const field of ["stream", "lookup", "replay"]) {
          expect(typeof row[field] === "string" && (row[field] as string).length > 0, field).toBe(true);
        }
        return (row.writes as readonly { surface: string; kind: string }[]).map(
          (write) => `${write.surface} ${write.kind}`,
        );
      });

      expect(writes.sort()).toEqual(
        [
          "POST /cart cart.add-line",
          "POST /cart/:lineId/fulfillment cart.set-fulfillment",
          "POST /cart/:lineId/quantity cart.set-quantity",
          "POST /cart/:lineId/remove cart.remove-line",
          "POST /cart/bulk cart.add-lines",
          "POST /cart/commands cart.commands",
          "mcp:checkout.add-cart-line cart.add-line",
          "mcp:checkout.remove-cart-line cart.remove-line",
          "mcp:checkout.update-cart-line cart.update-line",
          "route-action:account-cart cart.commands",
          "route-action:item-detail add-to-cart cart.add-line",
          "route-action:item-detail buy-best-match cart.add-line",
          "route-action:search commit-bulk-add cart.add-lines",
          "session-order-cart-cleanup cart.session-cleanup",
        ].sort(),
      );
    },
  );
});
