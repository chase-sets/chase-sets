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
// marketplace-web's cart, search and item-detail route modules left with that deployable, and Discovery's
// item-detail action left with them; the Corten marketplace's cart, bulk-add and item add-to-cart forms post
// to the owner routes above.
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
  // Seed reconciles from the authoritative stream by line id; boot-twice proof in cart-attempt.db.test.ts.
  {
    path: "bounded-contexts/checkout/support/runtime-support/seed.ts",
    classification: "exempt",
    shapes: ["direct cart aggregate write"],
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

/**
 * Every code shape that opens a Checkout Session (#9994). Like the cart shapes,
 * a shape is an entry whatever file it appears in.
 */
const ENTRY_WRITE_SHAPES: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
  { name: "client entry", pattern: /\.createCheckoutSession\(/g },
  { name: "session entry service", pattern: /\.(?:createFromCart|createBuyNow|createOfferIntent)\(/g },
  { name: "buy-now preparation", pattern: /(?<!function )\bprepareBuyNowCheckout\(/g },
  { name: "direct session start", pattern: /commandHandler\(\{[\s\S]{0,300}?type:\s*"StartCheckoutSession"/g },
];

/**
 * The entry census: each tracked caller and why it is safe. Attempt-producing
 * callers send one caller-created key per deliberate submission; the seed is
 * exempt because it starts one fixed Session id only when none exists.
 */
const EXPECTED_ENTRY_PARTITION: readonly CallerRow[] = [
  {
    path: "bounded-contexts/checkout/features/sessions/api/buy-now-preparation.ts",
    classification: "attempt-producing",
    shapes: ["session entry service"],
  },
  {
    path: "bounded-contexts/checkout/features/sessions/api/route.ts",
    classification: "attempt-producing",
    shapes: ["session entry service", "buy-now preparation"],
  },
  {
    path: "bounded-contexts/checkout/support/route-support/buy-checkout-readiness/checkout-start-entry.ts",
    classification: "attempt-producing",
    shapes: ["client entry"],
  },
  // Seed starts checkoutSeedIds.sessions.startedCart only when loadSeedSessionState reads it absent.
  {
    path: "bounded-contexts/checkout/support/runtime-support/seed.ts",
    classification: "exempt",
    shapes: ["direct session start"],
  },
  {
    path: "bounded-contexts/checkout/support/ucp-support/checkout.ts",
    classification: "attempt-producing",
    shapes: ["buy-now preparation"],
  },
];

/** A key computed from what is being bought, rather than created once per deliberate submission. */
const CONTENT_DERIVED_ENTRY_KEY =
  /\b(?:entryAttemptKey|attemptId)\s*[:=]\s*(?:`|JSON\.stringify|[\w.]+\s*\+|createHash\("sha256"\)\.update\((?!meta\.retryKey\)))/;

/** The text of one call's balanced argument list, starting at the shape's opening parenthesis. */
function callArguments(content: string, openIndex: number) {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const character = content[index];
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return content.slice(openIndex, index + 1);
  }
  return content.slice(openIndex);
}

/**
 * Classifies every file that opens a Session. A server-side entry call must
 * carry the `entryAttempt` in its own arguments; a client entry file must send
 * `entryAttemptKey` and validate it (`checkoutEntryAttemptKey` or
 * `isCheckoutCommandAttemptId`); a content-derived key fails anywhere.
 */
function partitionEntryCallers(files: readonly SourceFile[]) {
  const rows: CallerRow[] = [];
  const unclassified: string[] = [];
  for (const file of files) {
    if (file.path.endsWith("features/sessions/api/session-entry.ts")) continue;
    const calls = ENTRY_WRITE_SHAPES.flatMap((shape) =>
      [...file.content.matchAll(shape.pattern)].map((match) => ({
        shape: shape.name,
        args: callArguments(file.content, (match.index ?? 0) + match[0].lastIndexOf("(")),
      })),
    );
    if (calls.length === 0) continue;
    const shapes = ENTRY_WRITE_SHAPES.map((shape) => shape.name).filter((name) =>
      calls.some((call) => call.shape === name),
    );
    const expected = EXPECTED_ENTRY_PARTITION.find((row) => row.path === file.path);
    const sendsValidatedClientKey =
      /\b(?:checkoutEntryAttemptKey|isCheckoutCommandAttemptId)\(/.test(file.content) &&
      /\bentryAttemptKey\b/.test(file.content);
    const keyless = calls.some((call) => {
      if (call.shape === "client entry") return !sendsValidatedClientKey;
      return call.shape !== "direct session start" && !/\bentryAttempt\b/.test(call.args);
    });
    const contentDerived = CONTENT_DERIVED_ENTRY_KEY.test(file.content);
    const exemptMismatch =
      expected?.classification === "exempt" && shapes.some((shape) => shape !== "direct session start");
    if (
      !expected ||
      (expected.classification === "attempt-producing" && keyless) ||
      contentDerived ||
      exemptMismatch ||
      expected.shapes.join() !== shapes.join()
    ) {
      unclassified.push(`${file.path}: ${shapes.join(", ")}`);
      continue;
    }
    rows.push({ path: file.path, classification: expected.classification, shapes });
  }
  return { rows, unclassified };
}

let trackedSourcesCache: readonly SourceFile[] | null = null;

const SELL_LIST_CALLERS = [
  "bounded-contexts/checkout/features/command-attempts/api/sell-list-submission.ts",
  "bounded-contexts/checkout/features/sell-list/api/route.ts",
  "bounded-contexts/checkout/features/sell-list/api/runtime.ts",
  "bounded-contexts/checkout/support/runtime-support/seed.ts",
];

function partitionSellListCallers(files: readonly SourceFile[]) {
  const write =
    /\.(?:addSellListLine|addGuestSellListLine|removeSellListLine|removeGuestSellListLine|removeSellListLines|executeSellListAttempt)\(|(?<!function )\b(?:submitCheckoutSellListAdd|saveSellListLine|saveGuestSelectedOfferToSellList)\(/g;
  const unclassified: string[] = [];
  for (const file of files) {
    const calls = [...file.content.matchAll(write)];
    const direct = /commandHandler\(\{[\s\S]{0,200}?checkout\.sell-list-/.test(file.content);
    if (!calls.length && !direct) continue;
    const exempt = file.path.endsWith("/sell-list/api/runtime.ts") || file.path.endsWith("/runtime-support/seed.ts");
    if (
      !SELL_LIST_CALLERS.includes(file.path) ||
      (!exempt &&
        calls.some((match) => {
          const args = callArguments(file.content, match.index! + match[0].lastIndexOf("("));
          return !/\battemptId\b|\bbody\b|\bsellListLine\b/.test(args);
        })) ||
      (!exempt &&
        !/\b(?:submitCheckoutCartAttempt|submitCheckoutSellListAdd|executeSellListAttempt|saveSellListLine)\(/.test(
          file.content,
        ))
    )
      unclassified.push(file.path);
  }
  return unclassified;
}

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
    "classifies every tracked Sell List caller, including Discovery action-helpers",
    { timeout: TREE_SCAN_TIMEOUT_MS },
    () => {
      expect(partitionSellListCallers(trackedSources())).toEqual([]);
    },
  );
  it(
    "rejects a planted tracked Sell List caller and an unkeyed known caller",
    { timeout: TREE_SCAN_TIMEOUT_MS },
    () => {
      expect(
        partitionSellListCallers([
          { path: "bounded-contexts/planted/caller.ts", content: "api.removeSellListLine(lineId)" },
        ]),
      ).toHaveLength(1);
      expect(
        partitionSellListCallers([
          {
            path: "bounded-contexts/checkout/features/sell-list/api/route.ts",
            content: "api.addGuestSellListLine(owner, line)",
          },
        ]),
      ).toHaveLength(1);
    },
  );
  it("names Sell List line, batch and confirmation stream, lookup and replay contracts in the census", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "bounded-contexts/checkout/context.json"), "utf8"));
    const row = manifest.mutationConsistencyInventory.find(
      (entry: { id: string }) => entry.id === "checkout.sell-list-api-command-snapshots",
    ).commandAttempt;
    expect(row.writes.map((write: { kind: string }) => write.kind)).toEqual([
      "sell-list-line",
      "sell-list-line",
      "sell-list-batch",
      "confirmationIdForSession",
      "sell-list-handoff-prepared",
    ]);
    expect(row.stream).toContain("checkout.sell-list-");
    expect(row.lookup).toContain("command-attempts/");
    expect(row.lookup).toContain("confirmations/");
    expect(row.replay).toContain("checkout_confirmation_changed");
  });
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
    "classifies every tracked Session entry caller as keyed or a proved exemption",
    { timeout: TREE_SCAN_TIMEOUT_MS },
    () => {
      const { rows, unclassified } = partitionEntryCallers(trackedSources());

      expect(unclassified).toEqual([]);
      expect(rows.map((row) => `${row.path} ${row.classification}`).sort()).toEqual(
        EXPECTED_ENTRY_PARTITION.map((row) => `${row.path} ${row.classification}`).sort(),
      );
    },
  );

  it.each([
    [
      "a content-derived client key",
      'import { isCheckoutCommandAttemptId } from "x";\nawait checkoutApi.createCheckoutSession({ entryAttemptKey: `${listingId}:${quantity}`, source });',
    ],
    [
      "a content-hashed server key",
      'await prepareBuyNowCheckout({ listing, entryAttempt: { attemptId: createHash("sha256").update(listing.listingId).digest("base64url"), requestHash } });',
    ],
    ["a keyless client form", "await checkoutApi.createCheckoutSession({ source });"],
    ["a keyless server entry", "await services.createBuyNow({ accountId, listingId, quantity }, context);"],
  ])("fails a planted tracked entry caller: %s", { timeout: TREE_SCAN_TIMEOUT_MS }, (_label, line) => {
    const planted = [
      ...trackedSources(),
      { path: "bounded-contexts/planted/features/synthetic/api/entry.ts", content: line },
    ];

    expect(partitionEntryCallers(planted).unclassified).toEqual([
      expect.stringContaining("bounded-contexts/planted/features/synthetic/api/entry.ts"),
    ]);
  });

  it(
    "fails a listed entry caller once its key is dropped or derived from content",
    { timeout: TREE_SCAN_TIMEOUT_MS },
    () => {
      const ucpPath = "bounded-contexts/checkout/support/ucp-support/checkout.ts";
      const routePath = "bounded-contexts/checkout/features/sessions/api/route.ts";
      const mutate = (target: string, edit: (content: string) => string) =>
        trackedSources().map((file) => (file.path === target ? { ...file, content: edit(file.content) } : file));

      const listingOnlyKey = mutate(ucpPath, (content) =>
        content.replace("update(meta.retryKey)", "update(line.listingId)"),
      );
      const keylessRoute = mutate(routePath, (content) => content.replace(/\n\s*entryAttempt,\n/g, "\n"));

      expect(partitionEntryCallers(listingOnlyKey).unclassified).toEqual([expect.stringContaining(ucpPath)]);
      expect(partitionEntryCallers(keylessRoute).unclassified).toEqual([expect.stringContaining(routePath)]);
    },
  );

  it(
    "never lets ignored generated output with identical bytes join the partition",
    { timeout: TREE_SCAN_TIMEOUT_MS },
    () => {
      const tracked = gitLsFiles();
      const generatedCopy = "deployables/marketplace/build/server/assets/item-detail-synthetic.js";
      const contents = new Map(trackedSources().map((source) => [source.path, source.content]));
      // An unkeyed built copy that exists on disk but is not tracked: the read
      // function would serve it, yet the enumeration never asks for it.
      const builtCopy =
        "export async function addToCart(checkout) {\n  return checkout.addCartLine({ quantity: 1 });\n}\n";
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
        return (row.writes as readonly { surface: string; kind: string }[])
          .filter((write) => write.kind.startsWith("cart."))
          .map((write) => `${write.surface} ${write.kind}`);
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
          "session-order-cart-cleanup cart.session-cleanup",
        ].sort(),
      );
    },
  );

  it("names every Session entry write and its keyless-cart exemption in the Checkout manifest", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "bounded-contexts/checkout/context.json"), "utf8"),
    ) as {
      mutationConsistencyInventory?: readonly { entryAttempt?: Record<string, unknown> }[];
    };
    const entryRows = (manifest.mutationConsistencyInventory ?? []).flatMap((entry) =>
      entry.entryAttempt ? [entry.entryAttempt] : [],
    );

    expect(entryRows).toHaveLength(1);
    const row = entryRows[0]!;
    for (const field of ["key", "stream", "lookup", "replay", "confirmation"]) {
      expect(typeof row[field] === "string" && (row[field] as string).length > 0, field).toBe(true);
    }
    expect(
      (row.writes as readonly { surface: string; kind: string; target: string }[])
        .map((write) => `${write.surface} ${write.kind} ${write.target}`)
        .sort(),
    ).toEqual(
      [
        "POST /checkout-sessions checkout-entry session",
        "route-action:checkout-start checkout-entry session",
        "route-action:checkout-start guest checkout-entry session",
        "ucp:create_checkout checkout-entry session",
      ].sort(),
    );
    expect((row.exempt as readonly { surface: string }[]).map((exemption) => exemption.surface)).toEqual([
      "post-form:cart-page Checkout to /checkout/buy/readiness",
    ]);
  });
});
