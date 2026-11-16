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
