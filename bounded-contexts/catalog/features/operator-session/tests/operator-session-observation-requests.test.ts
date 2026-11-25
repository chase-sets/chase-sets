import { afterEach, expect, it, vi } from "vitest";
import { OperatorSessionRequestError, readBody } from "../api/request";
import { createMarketObservationRoutes, MARKET_OBSERVATION_BODY_MAX_BYTES } from "../api/market-observations";
import { PART_TEXT_MAX_BYTES } from "@chase-sets/tcgplayer-market-observations";
import {
  harness,
  current,
  partBody,
  partPath,
  completionBody,
  input,
  batchId,
  provenance,
} from "./market-observation-fixture";
import { mutant, bodyReaderWithoutDeadline } from "./market-observation-mutants";
import { operatorSessionPublicRoutes } from "../api/route";

afterEach(() => vi.useRealTimers());

it("kills the body-reader deadline bypass without leaving an endless read behind", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let close: () => void = () => {};
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => controller.close();
      },
    });
  const original = readBody(input(stream()), 1024).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await original).toMatchObject({ code: "request-timeout" });
  let settled = false;
  const bypass = bodyReaderWithoutDeadline()(input(stream()), 1024).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(settled).toBe(false);
  close();
  await bypass;
  expect(settled).toBe(true);
});

it("relays the exact request or null, no-store JSON, and fails closed without a source", async () => {
  const h = harness();
  const response = await h.send("/observation-requests/current", undefined, "GET");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ request: current });
  h.currentRequest.mockResolvedValue(null);
  expect(await (await h.routes.current(input(undefined, "GET"))).json()).toEqual({ request: null });
  const absent = createMarketObservationRoutes({ ...h.deps, requestSource: undefined });
  expect(await (await absent.current(input(undefined, "GET"))).json()).toEqual({ code: "request-source-unavailable" });
  expect((await absent.part(input(partBody()), batchId, "0")).status).toBe(503);
  expect((await absent.complete(input(await completionBody(), "POST"), batchId)).status).toBe(503);
});

const catalogRequest = {
  kind: "set-names",
  requestId: "opaque_catalog_attempt",
  productLineId: 1,
  expiresAt: "2026-11-15T00:15:00.000Z",
} as const;

function sharedPoll(includePricing = true) {
  const h = harness();
  const catalogSource = vi.fn(async () => catalogRequest);
  const routes = createMarketObservationRoutes(
    { ...h.deps, requestSource: includePricing ? h.deps.requestSource : undefined },
    catalogSource,
  );
  const unused = async () => Response.json({ code: "unused-test-route" });
  const app = operatorSessionPublicRoutes({
    authorizeObservationGrant: h.authorize,
    execute: unused,
    recordTcgplayerSetNameObservations: unused,
    recordTcgplayerSealedProductObservations: unused,
    marketObservations: routes,
  });
  const send = (query = "?version=2", origin = "https://admin.staging.chasesets.com") =>
    app.request(`${origin}/observation-requests/current${query}`);
  return { ...h, catalogSource, shared: send };
}

it("alternates v2 sources without consuming the other queue and preserves Pricing v1", async () => {
  const h = sharedPoll();
  expect(await (await h.shared("")).json()).toEqual({ request: current });
  h.currentRequest.mockClear();
  const first = await h.shared();
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(await first.json()).toEqual({ contractVersion: 2, request: catalogRequest });
  expect(h.catalogSource).toHaveBeenCalledExactlyOnceWith({ grant: provenance, environment: "staging" });
  expect(h.currentRequest).not.toHaveBeenCalled();
  expect(await (await h.shared()).json()).toEqual({
    contractVersion: 2,
    request: {
      kind: "market-observations",
      requestId: current.requestId,
      expiresAt: "2026-11-15T00:05:00.000Z",
      marketRequest: current,
    },
  });
  expect(h.catalogSource).toHaveBeenCalledTimes(1);
  expect(await (await h.shared()).json()).toEqual({ contractVersion: 2, request: catalogRequest });
});

it("serves Catalog on either turn without Pricing and leaves legacy source outages unchanged", async () => {
  const h = sharedPoll(false);
  expect((await h.shared("?version=1")).status).toBe(503);
  for (let i = 0; i < 2; i++)
    expect(await (await h.shared()).json()).toEqual({ contractVersion: 2, request: catalogRequest });
  const empty = createMarketObservationRoutes({ ...h.deps, requestSource: undefined });
  const response = await empty.current(new Request("https://admin.chasesets.com/?version=2"));
  expect(await response.json()).toEqual({ contractVersion: 2, request: null });
});

it("refuses unauthorized or unrecognized v2 polls before reading either work source", async () => {
  const h = sharedPoll();
  expect((await h.shared("?version=2&version=1")).status).toBe(400);
  expect((await h.shared("?version=2", "https://wrong.invalid")).status).toBe(403);
  h.authorize.mockRejectedValue(new OperatorSessionRequestError("authority-lost", 403));
  expect(await (await h.shared()).json()).toEqual({ code: "authority-lost" });
  expect(h.catalogSource).not.toHaveBeenCalled();
  expect(h.currentRequest).not.toHaveBeenCalled();
  expect(h.appendToStream).not.toHaveBeenCalled();
});

it.each([401, 403])("refuses every route before body, source or store for authority status %s", async (status) => {
  const h = harness();
  const code = status === 401 ? "grant-invalid" : "authority-lost";
  h.authorize.mockRejectedValue(new OperatorSessionRequestError(code, status));
  const cases = [
    () => h.routes.current(input(undefined, "GET")),
    () => h.routes.part(input(partBody()), batchId, "0"),
    () => h.routes.complete(input(awaitBody, "POST"), batchId),
  ];
  const awaitBody = await completionBody();
  for (const run of cases) {
    const response = await run();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  }
  expect(h.currentRequest).not.toHaveBeenCalled();
  expect(h.readStream).not.toHaveBeenCalled();
  expect(h.appendToStream).not.toHaveBeenCalled();
  expect(h.databaseNow).not.toHaveBeenCalled();
});

it("kills the authorization-bypass mutant independently for all three routes", async () => {
  const factory = mutant(
    "const grant = await deps.authorizeObservationGrant(input);",
    `const grant = ${JSON.stringify(provenance)};`,
  );
  const h = harness(factory);
  h.authorize.mockRejectedValue(new OperatorSessionRequestError("authority-lost", 403));
  for (const response of [
    await h.routes.current(input(undefined, "GET")),
    await h.routes.part(input(partBody()), batchId, "0"),
    await h.routes.complete(input(await completionBody(), "POST"), batchId),
  ])
    expect(response.status).not.toBe(403);
  expect(h.authorize).not.toHaveBeenCalled();
});

it.each([
  [batchId.toUpperCase(), "0"],
  [batchId + "a", "0"],
  ...["-1", "01", "1.5", "12345678901234567"].map((index) => [batchId, index]),
])("rejects invalid path %s/%s before grant lookup", async (id, index) => {
  const h = harness();
  expect((await h.send(partPath(id, index), partBody())).status).toBe(400);
  expect(h.authorize).not.toHaveBeenCalled();
});

it.each([
  { ...partBody(), extra: true },
  { requestId: current.requestId, phase: current.phase },
  partBody(""),
  partBody("a".repeat(PART_TEXT_MAX_BYTES + 1)),
  partBody("é"),
  { ...partBody(), phase: 1 },
])("closes the part body before request reads: %j", async (body) => {
  const h = harness();
  expect(await (await h.routes.part(input(body), batchId, "0")).json()).toEqual({ code: "invalid-body" });
  expect(h.currentRequest).not.toHaveBeenCalled();
  expect(h.readStream).not.toHaveBeenCalled();
});

it("bounds cap+1 and endless bodies before source and store, even if cancellation never settles", async () => {
  const h = harness();
  const over = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(MARKET_OBSERVATION_BODY_MAX_BYTES + 1));
    },
    cancel() {
      return new Promise(() => {});
    },
  });
  const response = await h.routes.part(input(over), batchId, "0");
  expect(response.status).toBe(413);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const endless = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      return new Promise(() => {});
    },
  });
  const pending = h.routes.part(input(endless), batchId, "0");
  await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).status).toBe(408);
  expect(h.currentRequest).not.toHaveBeenCalled();
  expect(h.readStream).not.toHaveBeenCalled();
});

it.each([
  ["!UUID.test(batchId)", "false", "path"],
  ["Object.keys(value).every((key) => keys.includes(key))", "true", "closed"],
  ["value.text.length < 1", "false", "empty"],
  ["value.text.length > PART_TEXT_MAX_BYTES", "false", "text-cap"],
  ['kind === "part" ? MARKET_OBSERVATION_BODY_MAX_BYTES : 1024', "Number.MAX_SAFE_INTEGER", "body-cap"],
])("kills the %s bypass with one varied input", async (needle, replacement, kind) => {
  const h = harness(mutant(needle, replacement));
  let body: unknown = partBody();
  if (kind === "closed") body = { ...partBody(), extra: true };
  if (kind === "empty") body = partBody("");
  if (kind === "text-cap") body = partBody("a".repeat(PART_TEXT_MAX_BYTES + 1));
  if (kind === "body-cap")
    body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(partBody()) + " ".repeat(MARKET_OBSERVATION_BODY_MAX_BYTES)));
        c.close();
      },
    });
  await h.routes.part(input(body), kind === "path" ? batchId.toUpperCase() : batchId, "0");
  if (kind === "path") expect(h.authorize).toHaveBeenCalled();
  else expect(h.currentRequest).toHaveBeenCalled();
});
