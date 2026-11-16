import { expect, it } from "vitest";
import {
  PART_TEXT_MAX_BYTES,
  maxPartCount,
  maxBatchTextBytes,
  parseTcgplayerMarketObservationBatch,
} from "@chase-sets/tcgplayer-market-observations";
import { createMarketObservationRoutes } from "../api/market-observations";
import { operatorExtensionContext } from "../api/set-name-observations";
import {
  harness,
  partBody,
  completionBody,
  input,
  batchId,
  current,
  provenance,
  streamId,
  secondaryRequest,
  smallSecondaryBatch,
  maximalLaunchBatch,
} from "./market-observation-fixture";
import { mutant } from "./market-observation-mutants";

it("validates the maximal five-product launch fixture through C0 before using it as DB evidence", () => {
  const request = secondaryRequest(),
    text = JSON.stringify(maximalLaunchBatch(request));
  expect(text.length).toBeLessThanOrEqual(maxBatchTextBytes(request));
  expect(() => parseTcgplayerMarketObservationBatch(text, request)).not.toThrow();
});

it.each([
  ["!/^(0|[1-9][0-9]{0,15})$/.test(index)", "false", "decimal"],
  ["!Number.isSafeInteger(Number(index))", "false", "safe-index"],
  ['typeof body.requestId !== "string"', "false", "request-type"],
  ["!UUID.test(body.requestId)", "false", "request-uuid"],
  ['body.phase !== "price-points" && body.phase !== "secondary"', "false", "phase"],
  ['typeof value.text !== "string"', "false", "text-type"],
  ["!/^[\\x00-\\x7f]*$/.test(value.text)", "false", "ascii"],
  ["privateText(value.text)", "false", "privacy"],
  ["!positive(value.textBytes)", "false", "bytes"],
  ["Math.ceil(value.textBytes / PART_TEXT_MAX_BYTES) !== value.partCount", "false", "count-bytes"],
  ['typeof value.digest !== "string"', "false", "digest-type"],
  ["!/^[0-9a-f]{64}$/.test(value.digest)", "false", "digest-hex"],
])("kills the isolated %s body/path bypass before downstream work", async (needle, replacement, kind) => {
  async function probe(factory: typeof createMarketObservationRoutes) {
    const h = harness(factory);
    let body: unknown = partBody(),
      index = "0";
    const completion = ["bytes", "count-bytes", "digest-type", "digest-hex"].includes(kind);
    if (kind === "decimal") index = "01";
    if (kind === "safe-index") index = "9007199254740992";
    if (kind === "request-type") body = { ...partBody(), requestId: [current.requestId] };
    if (kind === "request-uuid") body = { ...partBody(), requestId: "not-a-uuid" };
    if (kind === "phase") body = { ...partBody(), phase: "unknown" };
    if (kind === "text-type") body = { ...partBody(), text: 1 };
    if (kind === "ascii") body = partBody("é");
    if (kind === "privacy") body = partBody("Cookie: hostile");
    if (completion) {
      const complete: Record<string, unknown> = await completionBody();
      if (kind === "bytes") complete.textBytes = "1";
      if (kind === "count-bytes") complete.textBytes = PART_TEXT_MAX_BYTES + 1;
      if (kind === "digest-type") complete.digest = [complete.digest];
      if (kind === "digest-hex") complete.digest = "g".repeat(64);
      body = complete;
    }
    await (completion ? h.routes.complete(input(body, "POST"), batchId) : h.routes.part(input(body), batchId, index));
    return h;
  }
  const original = await probe(createMarketObservationRoutes),
    bypass = await probe(mutant(needle, replacement));
  if (kind === "decimal" || kind === "safe-index") {
    expect(original.authorize).not.toHaveBeenCalled();
    expect(bypass.authorize).toHaveBeenCalled();
  } else {
    expect(original.currentRequest).not.toHaveBeenCalled();
    expect(bypass.currentRequest).toHaveBeenCalled();
  }
});

it.each(["request", "part-cap", "byte-cap"])(
  "kills the %s request-relative bypass with one input changed",
  async (kind) => {
    const needle =
      kind === "request"
        ? "!request || request.requestId !== value.requestId || request.phase !== value.phase"
        : kind === "part-cap"
          ? "Number(index) >= maxPartCount(current)"
          : "(value.textBytes as number) > maxBatchTextBytes(current)";
    async function probe(factory: typeof createMarketObservationRoutes) {
      const h = harness(factory);
      if (kind === "request") h.currentRequest.mockResolvedValue({ ...current, requestId: batchId });
      const complete = await completionBody();
      if (kind === "byte-cap") complete.textBytes = maxBatchTextBytes(current) + 1;
      await (kind === "byte-cap"
        ? h.routes.complete(input(complete, "POST"), batchId)
        : h.routes.part(input(partBody()), batchId, kind === "part-cap" ? String(maxPartCount(current)) : "0"));
      return h;
    }
    expect((await probe(createMarketObservationRoutes)).readStream).not.toHaveBeenCalled();
    expect((await probe(mutant(needle, "false"))).readStream).toHaveBeenCalled();
  },
);

it.each(["lower", "upper"])("kills the %s endpoint-clock bypass with one timestamp varied", async (side) => {
  const request = secondaryRequest();
  const batch = smallSecondaryBatch(request);
  if (side === "lower")
    batch.products[0]!.sales.requestedAt = new Date(Date.parse(request.issuedAt) - 120001).toISOString();
  else batch.products[0]!.sales.responseObservedAt = new Date(Date.parse(request.issuedAt) + 120001).toISOString();
  const text = JSON.stringify(batch);
  async function probe(factory: typeof createMarketObservationRoutes) {
    const h = harness(factory);
    h.currentRequest.mockResolvedValue(request);
    expect((await h.routes.part(input(partBody(text, request)), batchId, "0")).status).toBe(200);
    return h.routes.complete(input(await completionBody(text, request), "POST"), batchId);
  }
  expect((await probe(createMarketObservationRoutes)).status).toBe(400);
  expect(
    (await probe(mutant(side === "lower" ? "Date.parse(instant) < minimum" : "Date.parse(instant) > maximum", "false")))
      .status,
  ).toBe(200);
});

it("kills the foreign-event-type bypass rather than granting replay from payload shape alone", async () => {
  async function probe(factory: typeof createMarketObservationRoutes) {
    const h = harness(factory);
    await h.store.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: operatorExtensionContext(provenance),
      events: [{ eventType: "foreign.event", payload: { batchId, partIndex: 0, ...partBody() } }],
    });
    return h.routes.part(input(partBody()), batchId, "0");
  }
  expect((await probe(createMarketObservationRoutes)).status).toBe(409);
  expect((await probe(mutant("event.eventType !== tcgplayerMarketObservationPartRecorded", "false"))).status).toBe(200);
});

it("kills the expected-version bypass under concurrent identical first parts", async () => {
  async function probe(factory: typeof createMarketObservationRoutes) {
    const h = harness(factory);
    await Promise.all([h.routes.part(input(partBody()), batchId, "0"), h.routes.part(input(partBody()), batchId, "0")]);
    return h.store.readStream({ streamId });
  }
  expect(await probe(createMarketObservationRoutes)).toHaveLength(1);
  expect(await probe(mutant('events.length === 0 ? "no_stream" : events.length', '"any"'))).toHaveLength(2);
});

it.each(["foreign-batch", "foreign-index", "order", "short-part", "conflict", "closed"])(
  "kills the %s stream guard bypass",
  async (kind) => {
    const needles: Record<string, readonly [string, string]> = {
      "foreign-batch": ["part.batchId !== batchId", "false"],
      "foreign-index": ["part.partIndex !== index", "false"],
      order: ['if (events.length !== part.partIndex) refuse("part-out-of-order", 409);', ""],
      "short-part": [
        "if (events.some((event) => (event.payload.text as string).length !== PART_TEXT_MAX_BYTES))",
        "if (false)",
      ],
      conflict: ["prior.payload.text === part.text", "true"],
      closed: ['if (admitted) refuse("batch-closed", 409);', ""],
    };
    async function probe(factory: typeof createMarketObservationRoutes) {
      const h = harness(factory);
      const request = {
        ...current,
        products: [{ productId: 1, skuIds: Array.from({ length: 250 }, (_, i) => i + 1), skuTargetCount: 250 }],
      };
      h.currentRequest.mockResolvedValue(request);
      if (kind === "foreign-batch" || kind === "foreign-index") {
        await h.store.appendToStream({
          streamId,
          expectedVersion: "no_stream",
          context: operatorExtensionContext(provenance),
          events: [
            {
              eventType: "catalog.operator-session.market-observation-part-recorded",
              payload: {
                batchId: kind === "foreign-batch" ? current.requestId : batchId,
                partIndex: kind === "foreign-index" ? 1 : 0,
                ...partBody(),
              },
            },
          ],
        });
      } else if (kind !== "order") {
        expect((await h.routes.part(input(partBody()), batchId, "0")).status).toBe(200);
        if (kind === "closed")
          expect((await h.routes.complete(input(await completionBody(), "POST"), batchId)).status).toBe(200);
      }
      return h.routes.part(
        input(partBody(kind === "conflict" ? "different" : undefined)),
        batchId,
        kind === "order" || kind === "short-part" ? "1" : "0",
      );
    }
    expect((await probe(createMarketObservationRoutes)).status).toBe(409);
    const [needle, replacement] = needles[kind]!;
    expect((await probe(mutant(needle, replacement))).status).toBe(200);
  },
);
