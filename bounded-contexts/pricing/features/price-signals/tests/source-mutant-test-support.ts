import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Test-only negative controls: loads a price-signals entry module from a
// transient copy of its in-feature import closure with exact one-site source
// mutations applied. Product files are never written; the copy lives under the
// gitignored tests/.cache/ directory and every copied file carries the
// tsconfig-excluded `.tmp.` infix. Imports that leave the feature resolve to the
// original files, so shared modules keep a single identity.

const featureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = path.join(featureRoot, "tests");
const cacheRoot = path.join(testsRoot, ".cache", "source-mutants");
const importPattern = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

export type SourceMutation = Readonly<{ file: string; find: string; replace: string }>;
export type SourceMutant = Readonly<{ id: string; defect: string; mutations: readonly SourceMutation[] }>;

export async function importSourceMutant<Module>(
  mutant: SourceMutant,
  entry: string,
): Promise<Readonly<{ module: Module; dispose: () => void }>> {
  const directory = path.join(cacheRoot, `${mutant.id}-${process.pid}-${randomUUID().slice(0, 8)}`);
  const pending = new Map<string, SourceMutation[]>();
  for (const mutation of mutant.mutations) {
    const file = path.join(featureRoot, mutation.file);
    pending.set(file, [...(pending.get(file) ?? []), mutation]);
  }
  const copies = new Map<string, string>();
  const queue = [path.join(featureRoot, entry)];
  const copyPath = (original: string) => {
    const relative = path.relative(featureRoot, original);
    const extension = path.extname(relative);
    return path.join(directory, `${relative.slice(0, -extension.length)}.tmp${extension}`);
  };
  try {
    while (queue.length > 0) {
      const original = queue.shift()!;
      if (copies.has(original)) continue;
      copies.set(original, copyPath(original));
      let source = readFileSync(original, "utf8").replace(/\r\n/g, "\n");
      for (const mutation of pending.get(original) ?? []) {
        const matches = source.split(mutation.find).length - 1;
        if (matches !== 1) {
          throw new Error(`source mutant ${mutant.id}: ${mutation.file} anchor matched ${matches} times`);
        }
        source = source.replace(mutation.find, () => mutation.replace);
      }
      pending.delete(original);
      source = source.replace(importPattern, (_match, prefix: string, quote: string, specifier: string) => {
        const resolved = resolveImport(original, specifier);
        const inClosure = isFeatureSource(resolved);
        if (inClosure) queue.push(resolved);
        const target = inClosure ? copyPath(resolved) : resolved;
        let relative = path
          .relative(path.dirname(copyPath(original)), target)
          .split(path.sep)
          .join("/");
        if (!relative.startsWith(".")) relative = `./${relative}`;
        return `${prefix}${quote}${relative}${quote}`;
      });
      mkdirSync(path.dirname(copies.get(original)!), { recursive: true });
      writeFileSync(copies.get(original)!, source);
    }
    if (pending.size > 0) {
      throw new Error(
        `source mutant ${mutant.id}: ${[...pending.values()].flat().map((m) => m.file)} not in ${entry} closure`,
      );
    }
    const module = (await import(pathToFileURL(copies.get(path.join(featureRoot, entry))!).href)) as Module;
    return { module, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

// Runs a scenario against a mutant and requires it to fail on one of the named
// assertion labels; a green scenario, or a failure outside those labels, is a
// surviving mutant. The NEGATIVE_RED line is the hosted-log receipt.
export async function expectMutantRed(
  mutant: SourceMutant,
  labels: readonly string[],
  scenario: () => Promise<unknown>,
): Promise<string> {
  let failure: unknown;
  try {
    await scenario();
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) {
    throw new Error(`NEGATIVE_SURVIVED ${mutant.id}: scenario passed against ${mutant.defect}`);
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  const label = labels.find((candidate) => message.includes(`${candidate}:`));
  if (!label) {
    throw new Error(`NEGATIVE_WRONG_FAILURE ${mutant.id}: expected one of [${labels.join(", ")}], got ${message}`, {
      cause: failure,
    });
  }
  const firstLine = message.split("\n")[0]!.replace(/\s+/g, " ").slice(0, 240);
  console.log(`NEGATIVE_RED ${mutant.id} [${label}] ${firstLine}`);
  return label;
}

// Loads the mutant, runs the scenario against its entry module, and always
// removes the transient copy.
export async function expectSourceMutantRed<Module>(
  mutant: SourceMutant,
  entry: string,
  labels: readonly string[],
  scenario: (module: Module) => Promise<unknown>,
): Promise<string> {
  const loaded = await importSourceMutant<Module>(mutant, entry);
  try {
    return await expectMutantRed(mutant, labels, () => scenario(loaded.module));
  } finally {
    loaded.dispose();
  }
}

// Settles a run so a rejected mutant still fails on the labelled assertion.
export async function settled<Value>(promise: Promise<Value>): Promise<Value | { rejected: string }> {
  try {
    return await promise;
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : String(error) };
  }
}

function resolveImport(importer: string, specifier: string): string {
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`source mutant: cannot resolve ${specifier} from ${importer}`);
}

function isFeatureSource(file: string): boolean {
  const relative = path.relative(featureRoot, file);
  return (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !file.startsWith(testsRoot + path.sep) &&
    /\.tsx?$/.test(file)
  );
}

const lines = (...text: readonly string[]) => text.join("\n");
const runtime = "api/market-capture.ts";
const writes = "read-model/provider-observation-writes.ts";
const mapper = "domain/provider-observation-mapper.ts";
const client = "integrations/tcgplayer/market-client.ts";
const decoders = "integrations/tcgplayer/response-decoders.ts";
const queries = "read-model/provider-observation-queries.ts";

const signalLoopStart = "    const perProductCounts = new Map<string, { recorded: number; unresolved: number }>();";
const captureAuthority = lines(
  "    // Exactly one post-signal instant freezes every authority for the capture arm.",
  "    const captureStartedAt = now();",
  "    let observationPolicy: ProviderObservationPolicyRevision | null = null;",
  "    let statHygienePolicy: Readonly<{ revisionId: string }> | null = null;",
  '    let invalidReason: "observation-policy-invalid" | "stat-hygiene-policy-invalid" | null = null;',
  "    try {",
  "      observationPolicy = await resolveObservation(captureStartedAt);",
  '      if (!observationPolicy) invalidReason = "observation-policy-invalid";',
  "    } catch {",
  '      invalidReason = "observation-policy-invalid";',
  "    }",
  "",
);
const statAuthority = lines(
  "    if (!invalidReason) {",
  "      try {",
  "        statHygienePolicy = await resolveStat(captureStartedAt);",
  '        if (!statHygienePolicy) invalidReason = "stat-hygiene-policy-invalid";',
  "      } catch {",
  '        invalidReason = "stat-hygiene-policy-invalid";',
  "      }",
  "    }",
  "",
);
const cursorUpsert = lines(
  "    await db.query(",
  "      `INSERT INTO pricing_external_market_capture_cursors (provider_key, after_external_key, generation, updated_at)",
);
const cursorUpsertStatement = lines(
  cursorUpsert,
  "       VALUES ($1,$2,$3,$4)",
  "       ON CONFLICT (provider_key) DO UPDATE SET",
  "         after_external_key = EXCLUDED.after_external_key,",
  "         generation = EXCLUDED.generation,",
  "         updated_at = EXCLUDED.updated_at`,",
  "      [providerKey, work.nextCursor.afterExternalKey, work.nextCursor.generation, capture.header.captureCompletedAt],",
  "    );",
);
const commitEnd = lines('    return "committed";', "  });", "}");
const groupOrder = "     ORDER BY d.provider_condition, d.delivered_amount, d.anonymous_capture_seller_ordinal";

// Every named negative control from the #8219 r2 review. Each mutation is an
// exact, single-occurrence text substitution in a transient copy.
export const captureSourceMutants = {
  earlyPolicy: {
    id: "F1a-early-policy",
    defect: "capture instant, observation and stat authority resolved before the signal loop",
    mutations: [
      { file: runtime, find: captureAuthority + statAuthority, replace: "" },
      { file: runtime, find: signalLoopStart, replace: captureAuthority + statAuthority + signalLoopStart },
    ],
  },
  earlyStat: {
    id: "F1a-early-stat",
    defect: "stat authority alone resolved before the signal loop at signalPassStartedAt, with no extra now() tick",
    mutations: [
      {
        file: runtime,
        find: "    let statHygienePolicy: Readonly<{ revisionId: string }> | null = null;\n",
        replace: "",
      },
      {
        file: runtime,
        find: signalLoopStart,
        replace: lines(
          "    let statHygienePolicy: Readonly<{ revisionId: string }> | null = null;",
          "    let earlyStatInvalid = false;",
          "    try {",
          "      statHygienePolicy = await resolveStat(signalPassStartedAt);",
          "      if (!statHygienePolicy) earlyStatInvalid = true;",
          "    } catch {",
          "      earlyStatInvalid = true;",
          "    }",
          signalLoopStart,
        ),
      },
      {
        file: runtime,
        find: statAuthority,
        replace: lines(
          '    if (!invalidReason && earlyStatInvalid) invalidReason = "stat-hygiene-policy-invalid";',
          "    if (invalidReason) statHygienePolicy = null;",
          "",
        ),
      },
    ],
  },
  floatingWrite: {
    id: "F1b-floating-write",
    defect: "signal write not awaited",
    mutations: [
      {
        file: runtime,
        find: "          const recorded = await deps.recordTcgplayerPriceSignal({",
        replace: "          const recorded = deps.recordTcgplayerPriceSignal({",
      },
    ],
  },
  continueAfterWriteFailure: {
    id: "F1c-continue-after-write-failure",
    defect: "valid capture write failure continues to the next product instead of retryable-abort",
    mutations: [
      {
        file: runtime,
        find: lines(
          "      } catch {",
          "        return {",
          '          status: "retryable-abort",',
          '          reason: "capture-write-failed",',
          "          signalWorkCount: work.length,",
          "          signalsRecorded,",
          "          signalsUnresolved,",
          "          capturesCommitted,",
          "        };",
        ),
        replace: lines("      } catch {", "        continue;"),
      },
    ],
  },
  advanceBeforeCommit: {
    id: "F1d-advance-before-commit",
    defect: "cursor advanced in its own transaction before the header and children transaction",
    mutations: [
      {
        file: writes,
        find: "    const headerDisposition = await insertCaptureHeader(db, capture);",
        replace: lines(
          cursorUpsertStatement,
          '    return "advanced";',
          '  }).then((advanced) => advanced !== "advanced" ? advanced : withPgTransaction(pool, async (db) => {',
          "    const headerDisposition = await insertCaptureHeader(db, capture);",
        ),
      },
      { file: writes, find: commitEnd, replace: lines('    return "committed";', "  }));", "}") },
    ],
  },
  validOnlyAdvance: {
    id: "F6-valid-only-advance",
    defect: "cursor not advanced for configuration-invalid captures",
    mutations: [
      {
        file: writes,
        find: cursorUpsert,
        replace: lines('    if (capture.header.outcomeKind !== "configuration-invalid")', cursorUpsert),
      },
    ],
  },
  reusedCaptureId: {
    id: "F6-reused-capture-id",
    defect: "providerCaptureId ignores captureStartedAt, so a later day reuses the first-day ID",
    mutations: [
      {
        file: mapper,
        find: '.update([providerKey, catalogItemId, productExternalKey, captureStartedAt].join("\\u001f"))',
        replace: '.update([providerKey, catalogItemId, productExternalKey].join("\\u001f"))',
      },
    ],
  },
  lostCurrency: {
    id: "F2-lost-currency",
    defect: "header currency mapped from constant usd instead of the observation policy",
    mutations: [
      {
        file: mapper,
        find: "      currency: input.observationPolicy.value.currency,",
        replace: '      currency: "usd",',
      },
    ],
  },
  ignoredCeiling: {
    id: "F2-ignored-ceiling",
    defect: "delivered-ceiling page stop disabled",
    mutations: [
      {
        file: client,
        find: "      ceilingReached = decoded.results.some((row) => row.price + row.sellerShippingPrice > ceiling);",
        replace: "      ceilingReached = false;",
      },
    ],
  },
  receiptLeak: {
    id: "F2-client-to-receipt-leak",
    defect: "history failure copies the thrown error message into the receipt diagnostics",
    mutations: [
      {
        file: client,
        find: "    return { observation: unavailableHistory(requestedAt, statusClass(error)), responseSummary, failurePhase };",
        replace: lines(
          "    return {",
          "      observation: unavailableHistory(requestedAt, statusClass(error)),",
          "      responseSummary: { diagnostic: String((error as Error).message) },",
          "      failurePhase,",
          "    };",
        ),
      },
    ],
  },
  selectorOmitsMapping: {
    id: "F4-selector-omits-target-mapping",
    defect: "selectMarketCaptureSignalWork returns catalogProductKey null for every selected SKU",
    mutations: [
      {
        file: writes,
        find: "    product.skus.push({ skuId, catalogProductKey: row.catalog_product_key });",
        replace: "    product.skus.push({ skuId, catalogProductKey: null });",
      },
    ],
  },
  mapperIgnoresMapping: {
    id: "F4-runtime-ignores-sku-map",
    defect: "runtime passes an empty catalogProductKeysBySku map to the mapper",
    mutations: [
      {
        file: runtime,
        find: "        catalogProductKeysBySku: new Map(item.skus.map((sku) => [sku.skuId, sku.catalogProductKey])),",
        replace: "        catalogProductKeysBySku: new Map(),",
      },
    ],
  },
  decoderBypass: {
    id: "F5-sales-decoder-bypass",
    defect: "sales envelope array check and strict sale-item decoding accept input unchanged",
    mutations: [
      {
        file: decoders,
        find: '  if (!Array.isArray(envelope.data)) throw new Error("sales-envelope-invalid");\n',
        replace: "",
      },
      {
        file: decoders,
        find: '      const row = exactRecord(item, SALE_KEYS, "sale-item-invalid");',
        replace: lines(
          "      data.push(item);",
          "      continue;",
          '      const row = exactRecord(item, SALE_KEYS, "sale-item-invalid");',
        ),
      },
    ],
  },
  outcomeBypass: {
    id: "F5-outcome-bypass",
    defect: "outcome_kind recorded even when rows were rejected",
    mutations: [{ file: mapper, find: '        ? "recorded-with-rejections"', replace: '        ? "recorded"' }],
  },
  appendOnReplay: {
    id: "F5-append-on-replay",
    defect: "replayed header path inserts child rows instead of skipping them",
    mutations: [
      {
        file: writes,
        find: '    if (headerDisposition === "existing") return "replayed";',
        replace: '    const replayedHeader = headerDisposition === "existing";',
      },
      { file: writes, find: cursorUpsert, replace: lines("    if (!replayedHeader)", cursorUpsert) },
      {
        file: writes,
        find: commitEnd,
        replace: lines('    return replayedHeader ? "replayed" : "committed";', "  });", "}"),
      },
    ],
  },
  groupOrderAmountFirst: {
    id: "F7a-group-order-amount-first",
    defect: "ask groups ordered by amount, condition, ordinal",
    mutations: [
      {
        file: queries,
        find: groupOrder,
        replace: "     ORDER BY d.delivered_amount, d.provider_condition, d.anonymous_capture_seller_ordinal",
      },
    ],
  },
  groupOrderOrdinalFirst: {
    id: "F7a-group-order-ordinal-first",
    defect: "ask groups ordered by ordinal, condition, amount",
    mutations: [
      {
        file: queries,
        find: groupOrder,
        replace: "     ORDER BY d.anonymous_capture_seller_ordinal, d.provider_condition, d.delivered_amount",
      },
    ],
  },
  weeklyOrderReversed: {
    id: "F7b-weekly-order-reversed",
    defect: "weekly buckets ordered by week_start before external_key",
    mutations: [
      {
        file: queries,
        find: "     ORDER BY external_key, week_start`,",
        replace: "     ORDER BY week_start, external_key`,",
      },
    ],
  },
  snapshotOrderReversed: {
    id: "F7b-snapshot-order-reversed",
    defect: "listing snapshots ordered by language before variant",
    mutations: [
      {
        file: queries,
        find: "     ORDER BY s.observed_on, s.provider_variant, s.provider_language, s.provider_condition`,",
        replace: "     ORDER BY s.observed_on, s.provider_language, s.provider_variant, s.provider_condition`,",
      },
    ],
  },
  captureFilterRemoved: {
    id: "F7c-capture-filter-removed",
    defect: "ask evidence no longer filtered to the requested capture",
    mutations: [{ file: queries, find: "AND d.capture_id = $3", replace: "AND $3::text IS NOT NULL" }],
  },
  competingCountRows: {
    id: "F7d-competing-count-rows",
    defect: "competing sellers counted as rows instead of distinct capture ordinals",
    mutations: [
      {
        file: queries,
        find: "    count: new Set(eligible.map((row) => row.anonymous_capture_seller_ordinal)).size,",
        replace: "    count: eligible.length,",
      },
    ],
  },
  productHistogramRows: {
    id: "F7d-product-histogram-rows",
    defect: "product histogram counts rows instead of distinct capture ordinals",
    mutations: [
      {
        file: queries,
        find: lines(
          "        cumulativeSellerCount: new Set(",
          "          rows",
          "            .filter((row) => Number(row.delivered_amount) <= amount)",
          "            .map((row) => row.anonymous_capture_seller_ordinal),",
          "        ).size,",
        ),
        replace: "        cumulativeSellerCount: rows.filter((row) => Number(row.delivered_amount) <= amount).length,",
      },
    ],
  },
} as const satisfies Record<string, SourceMutant>;
