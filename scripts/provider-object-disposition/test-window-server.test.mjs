import { expect, it } from "vitest";
import { createServerFence } from "./test-window-server.mjs";
import { createAttemptBudget } from "./test-window-policy.mjs";
import { syntheticManifest, SYNTHETIC_FIXTURES } from "./test-window-fixtures.mjs";

function subject(patch = {}) {
  const manifest = syntheticManifest();
  const member = {
    writerKind: "payment-saved",
    ownerAccountId: "acc_SYNTHETIC_B",
    logicalOperationId: "pay_SYNTHETIC",
  };
  const row = {
    key: { windowId: manifest.schedule[0].windowId, objectClass: 2, creationOrdinal: 1, operation: "create" },
    binding: member,
    state: "pending",
    version: 1,
    replayDeadline: manifest.timing.expiresAt,
    providerReference: null,
    envelope: {
      method: "POST",
      endpoint: "/v1/payment_intents",
      bodyText: "SYNTHETIC_PRIVATE_BODY",
      apiVersion: manifest.configuration.apiVersion,
      connectedAccountReference: null,
    },
  };
  const rows = [row];
  const requests = [];
  const budget = createAttemptBudget({ expiresAt: manifest.timing.expiresAt, cleanupSeconds: 30 });
  const fence = createServerFence({
    journal: { readWindow: async () => rows },
    configuration: manifest.configuration,
    fixtures: SYNTHETIC_FIXTURES,
    budget,
    send: async (target, init) => {
      requests.push({ target, init });
      return Response.json({
        id: "pi_SYNTHETIC",
        livemode: false,
        status: "requires_confirmation",
        latest_charge: "ch_SYNTHETIC_OBSERVED",
      });
    },
    ...patch,
  });
  const activate = (mapper, phase = "replay") =>
    fence.activate({ mapper, phase, windowId: row.key.windowId, members: [member] });
  activate("payment-saved");
  const headers = {
    "Stripe-Version": manifest.configuration.apiVersion,
    "Idempotency-Key": `evidence-window/v1:${row.key.windowId}:2:1:create`,
  };
  return { fence, row, rows, requests, budget, headers, activate };
}

it("AC-03 v2/foreign refs: exact includes and private/J membership; lists, aliases, queries, duplicate includes, foreign references and writes refuse", async () => {
  const test = subject();
  test.row.state = "succeeded";
  test.row.providerReference = "pi_SYNTHETIC";
  const get = (path) =>
    test.fence.fetch(`https://api.stripe.com${path}`, {
      headers: { "Stripe-Version": test.headers["Stripe-Version"] },
    });
  await get("/v1/payment_intents/pi_SYNTHETIC");
  await get("/v1/charges/ch_SYNTHETIC_OBSERVED");
  await get("/v1/customers/cus_SYNTHETIC_B");
  test.activate("connect-setup");
  const account =
    "/v2/core/accounts/acct_SYNTHETIC?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements&include%5B2%5D=defaults";
  await get(account);
  expect(test.requests).toHaveLength(4);
  for (const path of [
    "/v1/customers",
    "/v1/payment_intents",
    "/v1/payment_intents/search",
    "/v1/payment_intents/pi_FOREIGN",
    "/v1/charges/ch_FOREIGN",
    "/v1/customers/cus_FOREIGN",
    "/v2/core/accounts/acct_FOREIGN",
    "/v2/core/accounts/acct_SYNTHETIC",
    `${account}&include%5B2%5D=defaults`,
    "/v1/payment_intents/pi_SYNTHETIC?",
    "/v1/payment_intents/pi_SYNTHETIC#",
    "/v1/payment_intents/%70i_SYNTHETIC",
    "/v1/alias/../payment_intents/pi_SYNTHETIC",
  ])
    await expect(get(path)).rejects.toThrow("capture-target");
  for (const method of ["HEAD", "OPTIONS", "DELETE", "PATCH", "PUT", "POST"])
    await expect(
      test.fence.fetch("https://api.stripe.com/v1/customers", { method, headers: test.headers }),
    ).rejects.toThrow("capture-target");
  expect(test.requests).toHaveLength(4);
  test.row.binding = { ...test.row.binding, ownerAccountId: "acc_FOREIGN" };
  await expect(get("/v1/payment_intents/pi_SYNTHETIC")).rejects.toThrow("capture-target");
});

it("AC-04 lifecycle: immutable committed body/key/version/deadline, accepted response loss and one equal replay", async () => {
  const test = subject();
  const send = () =>
    test.fence.fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: test.headers,
      body: test.row.envelope.bodyText,
    });
  test.activate("payment-saved", "original");
  await expect(send()).rejects.toThrow("capture-response-withheld");
  test.row.version = 2;
  test.activate("payment-saved", "replay");
  await send();
  const records = test.fence.observations();
  expect(records).toHaveLength(2);
  expect(records[0].keyDigest).toBe(records[1].keyDigest);
  expect(records[0].requestDigest).toBe(records[1].requestDigest);
  expect(records[0].responseDigest).toBe(records[1].responseDigest);
  expect(records.map((record) => record.version)).toEqual([1, 2]);
  expect(test.fence.creationCount()).toBe(1);
  expect(JSON.stringify(records).includes("SYNTHETIC_PRIVATE_BODY")).toBe(false);
  await expect(
    test.fence.fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: test.headers,
      body: "SYNTHETIC_REPLACED",
    }),
  ).rejects.toThrow("capture-target");
  test.row.replayDeadline = "2000-01-01T00:00:00Z";
  await expect(send()).rejects.toThrow("capture-target");
  expect(test.requests).toHaveLength(2);
});

it("AC-03 staging/refusal: missing/true livemode and redirects cannot yield positive mode evidence or more sends", async () => {
  for (const response of [
    Response.json({ id: "pi_SYNTHETIC" }),
    Response.json({ livemode: true }),
    new Response("", { status: 302, headers: { location: "https://api.stripe.com/v1/customers" } }),
  ]) {
    let sends = 0;
    const test = subject({
      send: async (_target, init) => {
        sends++;
        expect(init.redirect).toBe("manual");
        return response;
      },
    });
    const send = () =>
      test.fence.fetch("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: test.headers,
        body: test.row.envelope.bodyText,
      });
    await expect(send()).rejects.toThrow();
    expect(sends).toBe(1);
    expect(test.fence.observations()).toHaveLength(1);
    expect(test.fence.observations()[0].responseDigest).toBeNull();
  }
});
