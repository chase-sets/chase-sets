import { afterEach, expect, it, vi } from "vitest";
import { createOperatorBackground, type OperatorAdapters } from "../domain/extension/background";
import { emptyOperatorRecord, operatorRecordKey, type OperatorRecord } from "../domain/extension/record";
import { operatorOrigins } from "../domain/extension/protocol";
import { createSetNamesObservationDispatcher, setNameRequestHeader } from "../domain/extension/set-names/request";
import type { SetNamesRequestResult } from "../domain/extension/set-names/probe";
import { setNameEntry } from "./set-name-observation-fixture";

const grant = "A".repeat(43);
const replacementGrant = "B".repeat(42) + "E";
const request = {
  kind: "sealed-products",
  requestId: "opaque_work_id",
  productLineId: 1,
  setNameId: 42,
  searchName: "Synthetic Set",
  expiresAt: "2099-01-01T00:15:00.000Z",
};
const envelope = (value: unknown = request) => Response.json({ contractVersion: 2, request: value });
const key = operatorRecordKey("staging");
const popup = {
  id: "test",
  url: "chrome-extension://test/popup.html",
  origin: "chrome-extension://test",
  hasTab: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function harness(initial: OperatorRecord = { ...emptyOperatorRecord("staging"), grant, state: "idle" }) {
  const stored = new Map<string, unknown>([[key, initial]]);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope());
  const dispatch = vi.fn<NonNullable<OperatorAdapters["dispatchObservationRequest"]>>(async () => {});
  const write = vi.fn(async (key: string, value: OperatorRecord) => {
    stored.set(key, value);
  });
  const badge = vi.fn(async () => {});
  const start = () =>
    createOperatorBackground({
      fetch,
      dispatchObservationRequest: dispatch,
      storage: { trust: async () => {}, read: async (key) => stored.get(key), write },
      badge,
    });
  return { start, fetch, dispatch, write, badge, stored };
}

afterEach(() => vi.useRealTimers());

const setNames = {
  kind: "set-names",
  requestId: "00000000-0000-4000-8000-000000000001",
  productLineId: 1,
  expiresAt: request.expiresAt,
};
const qualified: SetNamesRequestResult = {
  ok: true,
  status: 200,
  contentClass: "json",
  bytes: 256,
  body: { errors: [], results: [setNameEntry(1, 1)] },
};
function setNamesWorker() {
  const h = harness();
  const collect = vi.fn(async (_line: string): Promise<SetNamesRequestResult> => qualified);
  const dispatch = createSetNamesObservationDispatcher(collect);
  h.dispatch.mockImplementation((_environment, request, post) => dispatch(request, post));
  h.fetch.mockResolvedValueOnce(envelope(setNames));
  return { ...h, collect, worker: h.start() };
}

it("posts one reduced line without a popup and retries the same bytes and identity after a lost response", async () => {
  const h = setNamesWorker();
  h.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
  h.fetch.mockResolvedValueOnce(Response.json({ observationCount: 1 }));
  await h.worker.pollObservations();
  expect(h.collect).toHaveBeenCalledExactlyOnceWith("1");
  expect(h.fetch).toHaveBeenCalledTimes(3);
  const upload = h.fetch.mock.calls[1]!;
  expect(upload[0]).toBe(
    `${operatorOrigins.staging}/api/public/catalog/operator-session/scope-observations/tcgplayer-set-names`,
  );
  expect(upload[1]).toMatchObject({
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: { [setNameRequestHeader]: setNames.requestId, Authorization: `Bearer ${grant}` },
  });
  expect(h.fetch.mock.calls[2]?.[1]?.body).toBe(upload[1]?.body);
  expect(JSON.parse(String(upload[1]?.body))).toMatchObject({
    contractVersion: 1,
    productLineId: 1,
    sets: [setNameEntry(1, 1)],
  });
});

it("does not upload collected bytes after re-pair", async () => {
  const h = setNamesWorker();
  const entered = deferred<void>();
  const response = deferred<SetNamesRequestResult>();
  h.collect.mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  const poll = h.worker.pollObservations();
  await entered.promise;
  await h.worker.receive({ action: "pair", environment: "staging", grant: replacementGrant }, popup, "test");
  response.resolve(qualified);
  await poll;
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.stored.get(key)).toMatchObject({ grant: replacementGrant });
});

it("reports a provider refusal as a fixed failure without clearing Catalog authority", async () => {
  const h = setNamesWorker();
  h.collect.mockResolvedValueOnce({ ...qualified, ok: false, status: 403 });
  h.fetch.mockResolvedValueOnce(Response.json({ observationCount: 0 }));
  await h.worker.pollObservations();
  expect(h.fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ failure: "provider-request-failed" }));
  expect(h.stored.get(key)).toMatchObject({ grant });
  expect(h.write).not.toHaveBeenCalled();
});

it("uses the restored grant with one flight per environment and shares the manual wake", async () => {
  const h = harness();
  const entered = deferred<void>();
  const reply = deferred<Response>();
  h.fetch.mockImplementationOnce(() => {
    entered.resolve();
    return reply.promise;
  });
  const worker = h.start();
  const pending = worker.pollObservations();
  await entered.promise;
  await worker.pollObservations();
  const wake = { action: "poll-now", environment: "staging" };
  await worker.receive(wake, popup, "test");
  expect(h.fetch).toHaveBeenCalledExactlyOnceWith(
    `${operatorOrigins.staging}/api/public/catalog/operator-session/observation-requests/current?version=2`,
    expect.objectContaining({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: `Bearer ${grant}` },
    }),
  );
  reply.resolve(envelope());
  await pending;
  expect(h.dispatch).toHaveBeenCalledExactlyOnceWith("staging", request, expect.any(Function));
  expect(await worker.receive(wake, { ...popup, hasTab: true }, "test")).toBeNull();
  expect(h.fetch).toHaveBeenCalledTimes(1);
  await worker.receive(wake, popup, "test");
  expect(h.fetch).toHaveBeenCalledTimes(2);
});

it.each([
  ["no work", () => envelope(null)],
  ["unknown kind", () => envelope({ ...request, kind: "anything" })],
  ["supplied URL", () => envelope({ ...request, url: "https://wrong.invalid/" })],
  ["invalid coordinates", () => envelope({ ...request, setNameId: 0 })],
  ["expired", () => envelope({ ...request, expiresAt: "2000-01-01T00:00:00.000Z" })],
  ["oversize", () => new Response(" ".repeat(64 * 1024) + JSON.stringify({ contractVersion: 2, request }))],
  ["non-grant 403", () => Response.json({ code: "environment-refused" }, { status: 403 })],
])("does not dispatch or clear the grant for %s", async (_label, response) => {
  const h = harness();
  h.fetch.mockResolvedValueOnce(response());
  await h.start().pollObservations();
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
});

it.each([
  ["work", envelope],
  ["401", () => Response.json({ code: "grant-invalid" }, { status: 401 })],
  ["403", () => Response.json({ code: "authority-lost" }, { status: 403 })],
  ["retry", () => new Response(null, { status: 429, headers: { "Retry-After": "600" } })],
])("ignores a late %s response from the old pairing", async (_label, response) => {
  const h = harness();
  const entered = deferred<void>();
  const reply = deferred<Response>();
  h.fetch.mockImplementationOnce(() => {
    entered.resolve();
    return reply.promise;
  });
  const worker = h.start();
  const pending = worker.pollObservations();
  await entered.promise;
  expect(
    await worker.receive({ action: "pair", environment: "staging", grant: replacementGrant }, popup, "test"),
  ).toMatchObject({ paired: true, state: "idle" });
  reply.resolve(response());
  await pending;
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.write).toHaveBeenCalledTimes(1);
  expect(h.stored.get(key)).toMatchObject({ grant: replacementGrant, profileRevision: 1, nextAttemptAt: 0 });
  await worker.pollObservations();
  expect(h.fetch.mock.lastCall?.[1]?.headers).toEqual({ Authorization: `Bearer ${replacementGrant}` });
  expect(h.dispatch).toHaveBeenCalledExactlyOnceWith("staging", request, expect.any(Function));
});

it.each([401, 403])(
  "clears only the current pairing on authoritative %s and stays cleared on restart",
  async (status) => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(
      Response.json({ code: status === 401 ? "grant-invalid" : "authority-lost" }, { status }),
    );
    await h.start().pollObservations();
    expect(h.stored.get(key)).toMatchObject({ grant: null, state: "re-pair-required" });
    expect(h.badge).toHaveBeenCalledWith(true);
    await h.start().pollObservations();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.dispatch).not.toHaveBeenCalled();
  },
);

it("uses the revision fence even when a grant is paired again with identical bytes", async () => {
  const h = harness();
  const entered = deferred<void>();
  const reply = deferred<Response>();
  h.fetch.mockImplementationOnce(() => {
    entered.resolve();
    return reply.promise;
  });
  const worker = h.start();
  const pending = worker.pollObservations();
  await entered.promise;
  await worker.receive({ action: "pair", environment: "staging", grant }, popup, "test");
  reply.resolve(Response.json({ code: "grant-invalid" }, { status: 401 }));
  await pending;
  expect(h.stored.get(key)).toMatchObject({ grant, profileRevision: 1, state: "idle" });
  expect(h.write).toHaveBeenCalledTimes(1);
});

it.each(["600", "Sun, 01 Nov 2026 00:10:00 GMT"])("persists Retry-After %s through a worker restart", async (value) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.parse("2026-11-01T00:00:00.000Z");
  vi.setSystemTime(now);
  const h = harness();
  h.fetch.mockResolvedValueOnce(new Response(null, { status: 503, headers: { "Retry-After": value } }));
  await h.start().pollObservations();
  expect(h.stored.get(key)).toMatchObject({ grant, nextAttemptAt: now + 600_000 });
  const restarted = h.start();
  vi.setSystemTime(now + 599_999);
  await restarted.pollObservations();
  expect(h.fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now + 600_000);
  await restarted.pollObservations();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.dispatch).toHaveBeenCalledExactlyOnceWith("staging", request, expect.any(Function));
});
