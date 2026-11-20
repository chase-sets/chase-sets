import { beforeAll, expect, it } from "vitest";
import { captureProbe, serializeResult } from "./stripe-payment-create-uncertain-outcome-probe.mjs";

const marker = "PLANTED_PRIVATE_MARKER";
const source = "a".repeat(40);
const secretKey = `sk_test_${marker}`;
const customer = `cus_${marker}`;
const method = `pm_${marker}`;
const session = `cs_test_${marker}`;
const intent = `pi_${marker}`;
const calls = [];
let elapsed = 0;
const state = { session: null, intent: null };
const json = (value, status = 200) => Response.json(value, { status });

async function providerFetch(url, init) {
  const { origin, pathname: path, searchParams } = new URL(url);
  expect(origin).toBe("https://api.stripe.com");
  expect(init.redirect).toBe("error");
  const form = new URLSearchParams(init.body);
  const key = new Headers(init.headers).get("idempotency-key");
  calls.push({ elapsed, path, method: init.method, body: String(init.body), key });
  switch (`${init.method} ${path}`) {
    case "POST /v1/customers":
      return json({ id: customer, object: "customer", livemode: false });
    case "POST /v1/payment_methods/pm_card_threeDSecure2Required/attach":
      expect(form.get("customer")).toBe(customer);
      return json({ id: method, object: "payment_method", customer, livemode: false });
    case `POST /v1/payment_methods/${method}/detach`:
      return json({ id: method, object: "payment_method", type: "card", customer: null, livemode: false });
    case "POST /v1/checkout/sessions":
      state.session = {
        id: session,
        object: "checkout.session",
        livemode: false,
        status: "open",
        payment_status: "unpaid",
        metadata: { payment_id: form.get("metadata[payment_id]") },
        client_secret: marker,
        url: `https://example.invalid/${marker}`,
      };
      return json(state.session);
    case "POST /v1/payment_intents":
      expect(form.get("confirm")).toBe("true");
      state.intent = {
        id: intent,
        object: "payment_intent",
        livemode: false,
        status: "requires_payment_method",
        metadata: { payment_id: form.get("metadata[payment_id]") },
        last_payment_error: { message: marker },
      };
      return json({ error: { message: marker, payment_intent: state.intent } }, 402);
    case `GET /v1/checkout/sessions/${session}`:
      return json(state.session);
    case `GET /v1/payment_intents/${intent}`:
      return json(state.intent);
    case "GET /v1/payment_intents/search":
      expect(searchParams.get("limit")).toBe("1");
      return json({
        data:
          elapsed > 0 && searchParams.get("query") === `metadata['payment_id']:'${state.intent.metadata.payment_id}'`
            ? [state.intent]
            : [],
        has_more: false,
      });
    case `POST /v1/payment_intents/${intent}/cancel`:
      return json({ ...state.intent, status: "canceled" });
    default:
      throw new Error(marker);
  }
}

let result;
beforeAll(async () => {
  result = await captureProbe({
    armed: true,
    secretKey,
    source,
    providerFetch,
    clock: { now: () => elapsed },
    wait: async (ms) => {
      elapsed += ms;
    },
  });
});

it("AC1: Checkout known GET observes the Session and never treats the PI search as Session lookup", () => {
  const [row] = result.rows;
  expect(row.branch).toBe("checkout-session");
  expect(row.responseKind).toBe("accepted");
  expect(row.observations.map(({ elapsedMs }) => elapsedMs)).toEqual([0, 30_000, 900_000]);
  expect(
    row.observations.map(({ knownObjectGet, runtimePaymentIdSearch }) => [
      knownObjectGet.result,
      runtimePaymentIdSearch.result,
    ]),
  ).toEqual([
    ["found", "not-found"],
    ["found", "not-found"],
    ["found", "not-found"],
  ]);
  expect(row.disposition.paymentObject).toBe("retained-test");
});

it("AC2: saved PI confirmation error still has a private identity; GET and search have independent outcomes", () => {
  const [, row] = result.rows;
  expect(row.responseKind).toBe("confirmation-error-with-object");
  expect(
    row.observations.map(({ knownObjectGet, runtimePaymentIdSearch }) => [
      knownObjectGet.result,
      runtimePaymentIdSearch.result,
    ]),
  ).toEqual([
    ["found", "not-found"],
    ["found", "found"],
    ["found", "found"],
  ]);
  expect(row.observations[2].knownObjectGet.providerState).toBe("requires_payment_method");
  expect(row.disposition.paymentObject).toBe("canceled");
});

it("AC3: both creates replay J's exact stored bytes and key only after both final reads", () => {
  for (const row of result.rows)
    expect(row.exactReplay).toMatchObject({ sameObject: true, requestDigestEqual: true, keyDigestEqual: true });
  const lastRead = calls.findLastIndex(({ method }) => method === "GET");
  for (const path of ["/v1/checkout/sessions", "/v1/payment_intents"]) {
    const [first, replay, extra] = calls.filter((call) => call.path === path);
    expect(extra).toBeUndefined();
    expect(first.key).toMatch(/^evidence-window\/v1:/);
    expect(replay).toMatchObject({ key: first.key, body: first.body, elapsed: 900_000 });
    expect(calls.indexOf(replay)).toBeGreaterThan(lastRead);
  }
});

it("AC4: closed artifact excludes planted private data, has finite calls and refuses a held launch before any call", async () => {
  expect(calls).toHaveLength(20);
  const serialized = serializeResult(result);
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toMatch(/evidence-window\/v1:|https?:|pay_probe_|acc_probe_/);
  expect(result.fixtureDisposition).toEqual({ customer: "retained-test", paymentMethod: "detached" });
  expect(() => serializeResult({ ...result, rows: [result.rows[0], result.rows[0]] })).toThrow();
  const altered = structuredClone(result);
  altered.rows[0].observations[0].knownObjectGet.extra = marker;
  expect(() => serializeResult(altered)).toThrow();
  altered.rows[0].observations[0].knownObjectGet = { result: "found", providerState: marker, paymentStatus: "unpaid" };
  expect(() => serializeResult(altered)).toThrow();
  let contacted = false;
  for (const [armed, key] of [
    [false, secretKey],
    [true, `sk_live_${marker}`],
  ]) {
    await expect(
      captureProbe({
        armed,
        secretKey: key,
        source,
        providerFetch: () => {
          contacted = true;
        },
      }),
    ).rejects.toThrow();
  }
  expect(contacted).toBe(false);
});

it("AC5: the conclusion cites runtime correlation, never infers absence from a finite window", () => {
  expect(result.rows.map(({ conclusion }) => conclusion)).toEqual([
    { result: "unresolved-unknown", authority: "no-conclusive-runtime-object-correlation" },
    { result: "provider-object-found", authority: "correlated-runtime-payment-intent-search" },
  ]);
  const altered = structuredClone(result);
  altered.rows[0].conclusion = altered.rows[1].conclusion;
  expect(() => serializeResult(altered)).toThrow();
});
