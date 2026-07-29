import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectEventStreamReadSites,
  validateAuthoritativeStreamReadInventory,
} from "./authoritative-stream-read-inventory.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const CONSUMER = "bounded-contexts/example/features/orders/api/runtime.ts";
const CONSUMER_ID = `${CONSUMER}:readStream#1`;
const BOUND_TEST = "bounded-contexts/example/features/orders/api/runtime.test.ts";

async function fixture(files, registry) {
  const root = await mkdtemp(path.join(os.tmpdir(), "authoritative-stream-read-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
  if (registry) {
    const registryPath = path.join(root, "scripts/check-structure/authoritative-stream-read-registry.json");
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }
  return root;
}

function validate(repoRoot) {
  return validateAuthoritativeStreamReadInventory({ repoRoot, writeArtifact: false });
}

const BOUNDED_PREFIX_ENTRY = {
  id: CONSUMER_ID,
  file: CONSUMER,
  classification: "bounded-prefix",
  bound: "1",
  reason: "The stream holds exactly one immutable fact, so version 1 is the whole answer.",
  boundTest: BOUND_TEST,
};

describe("authoritative stream read inventory", () => {
  it("rejects a new authoritative fold over one default-capped readStream call (negative control)", async () => {
    const root = await fixture({
      [CONSUMER]: `export async function loadOrder(deps, orderId) {
  const events = await deps.eventStore.readStream({ streamId: \`commerce.order-\${orderId}\` });
  return events.reduce(fold, initialState);
}
`,
    });

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("cannot prove it saw a complete history")]),
    });
  });

  it("rejects an explicit limit that merely restates the page cap", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function loadOrder(deps, orderId) {
  // event-stream-read: bounded-prefix -- five hundred events is surely enough for anyone
  const events = await deps.eventStore.readStream({ streamId: orderId, limit: 500 });
  return events.reduce(fold, initialState);
}
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      { entries: [{ ...BOUNDED_PREFIX_ENTRY, bound: "500" }] },
    );

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.stringContaining("must be an integer literal below the 500-event page cap"),
      ]),
    });
  });

  it("rejects a bounded-prefix annotation that passes no limit at all", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function loadOrder(deps, orderId) {
  // event-stream-read: bounded-prefix -- only the first event matters here, honestly
  const events = await deps.eventStore.readStream({ streamId: orderId });
  return events[0] ?? null;
}
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      { entries: [BOUNDED_PREFIX_ENTRY] },
    );

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("must pass an explicit limit")]),
    });
  });

  it("rejects an annotation with no registry entry naming the test that consumes the bound", async () => {
    const root = await fixture({
      [CONSUMER]: `export async function loadOrder(deps, orderId) {
  // event-stream-read: bounded-prefix -- only the first event matters here, honestly
  const events = await deps.eventStore.readStream({ streamId: orderId, limit: 1 });
  return events[0] ?? null;
}
`,
    });

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.stringContaining("no registry entry naming the test that consumes its bound"),
      ]),
    });
  });

  it("rejects a registry entry whose bound test does not name the site", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function loadOrder(deps, orderId) {
  // event-stream-read: bounded-prefix -- only the first event matters here, honestly
  const events = await deps.eventStore.readStream({ streamId: orderId, limit: 1 });
  return events[0] ?? null;
}
`,
        [BOUND_TEST]: `it("does something unrelated", () => {});\n`,
      },
      { entries: [BOUNDED_PREFIX_ENTRY] },
    );

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("does not name this site")]),
    });
  });

  it("rejects a registry entry whose declared bound disagrees with the call", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function loadOrder(deps, orderId) {
  // event-stream-read: bounded-prefix -- only the first event matters here, honestly
  const events = await deps.eventStore.readStream({ streamId: orderId, limit: 5 });
  return events[0] ?? null;
}
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      { entries: [BOUNDED_PREFIX_ENTRY] },
    );

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.stringContaining("registers bound '1' but the call passes limit '5'"),
      ]),
    });
  });

  it("rejects a wrapper that aliases readStream out of call-shaped review", async () => {
    const root = await fixture({
      [CONSUMER]: `export function createReader(eventStore) {
  const { readStream } = eventStore;
  return (streamId) => readStream({ streamId });
}
`,
    });

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("referenced without being called directly")]),
    });
  });

  it("rejects computed member access to readStream", async () => {
    const root = await fixture({
      [CONSUMER]: `const method = "readStream";
export const load = (eventStore, streamId) => eventStore[method]({ streamId });
`,
    });

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("referenced without being called directly")]),
    });
  });

  it("rejects split-literal computed access instead of omitting it from the inventory", async () => {
    const root = await fixture({
      [CONSUMER]: `export const load = (eventStore, streamId) => eventStore["read" + "Stream"]({ streamId });
`,
    });

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("computed access")]),
    });
  });

  it("rejects derived-identifier computed access instead of omitting it from the inventory", async () => {
    const root = await fixture({
      [CONSUMER]: `const suffix = "Stream";
const method = "read" + suffix;
export const load = (eventStore, streamId) => eventStore[method]({ streamId });
`,
    });

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("computed access")]),
    });
  });

  it("rejects unresolved computed EventStore access fail-closed", async () => {
    const root = await fixture({
      [CONSUMER]: `export const load = (eventStore, streamId, method) => eventStore[method]({ streamId });
`,
    });

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("unresolved computed access")]),
    });
  });

  it("rejects a stale registry entry once its site is gone", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export const loadOrder = async (deps, streamId) =>
  readCompleteStream(deps.eventStore, { streamId });
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      { entries: [BOUNDED_PREFIX_ENTRY] },
    );

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("stale entry")]),
    });
  });

  it("rejects a registry reason too thin to be a contract", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function loadOrder(deps, orderId) {
  // event-stream-read: bounded-prefix -- only the first event matters here, honestly
  const events = await deps.eventStore.readStream({ streamId: orderId, limit: 1 });
  return events[0] ?? null;
}
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      { entries: [{ ...BOUNDED_PREFIX_ENTRY, reason: "because" }] },
    );

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("at least 40 characters")]),
    });
  });

  it("accepts a deliberate bounded-prefix reader with an annotation, a bound, and a bound test", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function loadOrder(deps, orderId) {
  // event-stream-read: bounded-prefix -- the stream holds exactly one immutable fact
  const events = await deps.eventStore.readStream({ streamId: orderId, limit: 1 });
  return events[0] ?? null;
}
`,
        [BOUND_TEST]: `// bound contract for ${CONSUMER_ID}\n`,
      },
      { entries: [BOUNDED_PREFIX_ENTRY] },
    );

    await expect(validate(root)).resolves.toMatchObject({ ok: true, violations: [] });
  });

  it("accepts a paged catch-up drain that advances an inclusive fromVersion", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function drain(eventStore, streamId, batchSize) {
  let fromVersion = 1;
  for (;;) {
    // event-stream-read: paged-catch-up -- applies each event in its own transaction
    const events = await eventStore.readStream({ streamId, fromVersion, limit: batchSize });
    if (events.length === 0) return;
    fromVersion = events[events.length - 1].streamVersion + 1;
  }
}
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      {
        entries: [
          {
            ...BOUNDED_PREFIX_ENTRY,
            classification: "paged-catch-up",
            bound: "batchSize",
            reason: "Drains the stream to exhaustion one transactional batch at a time; folds no aggregate state.",
          },
        ],
      },
    );

    await expect(validate(root)).resolves.toMatchObject({ ok: true, violations: [] });
  });

  it("rejects a paged catch-up read that never advances a fromVersion", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function drain(eventStore, streamId, batchSize) {
  // event-stream-read: paged-catch-up -- applies each event in its own transaction
  return eventStore.readStream({ streamId, limit: batchSize });
}
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      {
        entries: [
          {
            ...BOUNDED_PREFIX_ENTRY,
            classification: "paged-catch-up",
            bound: "batchSize",
            reason: "Drains the stream to exhaustion one transactional batch at a time; folds no aggregate state.",
          },
        ],
      },
    );

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("must pass fromVersion")]),
    });
  });

  it("rejects a paged catch-up cursor that advances by page length", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `export async function drain(eventStore, streamId, batchSize) {
  let fromVersion = 37;
  for (;;) {
    // event-stream-read: paged-catch-up -- applies each event in its own transaction
    const events = await eventStore.readStream({ streamId, fromVersion, limit: batchSize });
    if (events.length === 0) return;
    fromVersion += events.length;
  }
}
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      {
        entries: [
          {
            ...BOUNDED_PREFIX_ENTRY,
            classification: "paged-catch-up",
            bound: "batchSize",
            reason: "Drains the stream to exhaustion one transactional batch at a time; folds no aggregate state.",
          },
        ],
      },
    );

    await expect(validate(root)).resolves.toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("never from page.length")]),
    });
  });

  it("accepts the canonical complete-history reader with no annotation at all", async () => {
    const root = await fixture({
      [CONSUMER]: `import { readCompleteStream } from "@chase-sets/event-core/complete-stream";

export async function loadOrder(deps, orderId) {
  const events = await readCompleteStream(deps.eventStore, { streamId: \`commerce.order-\${orderId}\` });
  return events.reduce(fold, initialState);
}
`,
    });

    await expect(validate(root)).resolves.toMatchObject({ ok: true, violations: [] });
  });

  it("leaves the event store implementations free to call readStream", async () => {
    const root = await fixture({
      "infrastructure/event-core-postgres/event-store.ts": `export const store = {
  readStream: async (input) => pool.query(readStreamSql, [input.streamId, input.fromVersion, input.limit]),
};
`,
      "contracts/event-core/complete-stream.ts": `export async function readCompleteStream(reader, input) {
  return reader.readStream({ streamId: input.streamId, fromVersion: 1, limit: 500 });
}
`,
    });

    await expect(validate(root)).resolves.toMatchObject({ ok: true, violations: [] });
  });

  it("does not police test files, harnesses, or fixtures", async () => {
    const root = await fixture({
      "bounded-contexts/example/features/orders/api/runtime.test.ts": `await eventStore.readStream({ streamId });`,
      "bounded-contexts/example/features/orders/tests/harness.ts": `await eventStore.readStream({ streamId });`,
      "bounded-contexts/example/features/orders/api/seeding/runtime-test-harness.ts": `readStream: async () => [];`,
      "contracts/event-core/test-support.ts": `readStream: async (input) => slice(input);`,
    });

    await expect(validate(root)).resolves.toMatchObject({ ok: true, violations: [] });
  });

  it("classifies every discovered production consumer, not only the failing ones", async () => {
    const root = await fixture(
      {
        [CONSUMER]: `import { readCompleteStream } from "@chase-sets/event-core/complete-stream";

export async function loadOrder(deps, orderId) {
  // event-stream-read: bounded-prefix -- the stream holds exactly one immutable fact
  const probe = await deps.eventStore.readStream({ streamId: orderId, limit: 1 });
  return probe.length ? readCompleteStream(deps.eventStore, { streamId: orderId }) : [];
}
`,
        [BOUND_TEST]: `// ${CONSUMER_ID}\n`,
      },
      { entries: [BOUNDED_PREFIX_ENTRY] },
    );

    const rows = await collectEventStreamReadSites({ repoRoot: root });

    expect(rows.map((row) => ({ id: row.id, classification: row.classification }))).toEqual([
      { id: CONSUMER_ID, classification: "bounded-prefix" },
      { id: `${CONSUMER}:readCompleteStream#1`, classification: "complete-history" },
    ]);
  });
});

describe("authoritative stream read inventory over the real repository", () => {
  it("has no unclassified production event-stream reader", async () => {
    const result = await validateAuthoritativeStreamReadInventory({
      repoRoot: path.resolve(import.meta.dirname, "../.."),
      writeArtifact: false,
    });

    expect(result.violations).toEqual([]);
  }, 120_000);

  it("keeps every complete-history consumer on the canonical reader", async () => {
    const rows = await collectEventStreamReadSites({ repoRoot: path.resolve(import.meta.dirname, "../..") });
    const completeHistory = rows.filter((row) => row.classification === "complete-history");

    expect(completeHistory.length).toBeGreaterThan(0);
    expect(completeHistory.every((row) => row.mechanism === "readCompleteStream")).toBe(true);
  }, 120_000);
});
