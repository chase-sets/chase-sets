import { describe, expect, it } from "vitest";
import { decideAuthorization, evolveAuthorization, initialAuthorization, type AuthorizationCommand } from "./domain";

const balance = { useBalance: true, instrumentId: null, category: null } as const;
const card = { useBalance: false, instrumentId: "card_one", category: "card" } as const;
const bank = { useBalance: false, instrumentId: "bank_one", category: "bank-account" } as const;
const authorize = { type: "authorize", source: card, consentVersion: "offer-automatic-charge-v1" } as const;
const unavailable = { type: "markPaymentMethodUnavailable", generation: 1, instrumentId: "card_one" } as const;
const hold = { type: "holdForFailedPayment", generation: 1, orderId: "ord_first" } as const;
const revoke = { type: "revoke" } as const;
const required = { type: "markRequired" } as const;
const resume = (source: typeof balance | typeof bank) => ({ type: "resume", source }) as const;

function step(current: typeof initialAuthorization, command: AuthorizationCommand) {
  const event = decideAuthorization(current, command);
  expect(event).not.toBeNull();
  return evolveAuthorization(current, event!);
}

describe("Offer Payment Authorization transitions", () => {
  it("marks an absent authorization required only once and authorizes from none", () => {
    const marked = step(initialAuthorization, required);
    expect(marked.snapshot).toMatchObject({ state: "none", generation: 0 });
    expect(decideAuthorization(marked, required)).toBeNull();
    expect(step(marked, authorize).snapshot).toMatchObject({ state: "active", generation: 1, source: card });
  });

  it("replaces an active source only with a new source and reauthorizes after revoke", () => {
    const active = step(initialAuthorization, authorize);
    expect(() => decideAuthorization(active, authorize)).toThrow();
    const replaced = step(active, { ...authorize, source: bank });
    expect(replaced.snapshot).toMatchObject({ state: "active", generation: 2, source: bank });
    expect(decideAuthorization(replaced, unavailable)).toBeNull();
    const revoked = step(replaced, revoke);
    expect(revoked.snapshot.state).toBe("revoked");
    expect(() => decideAuthorization(revoked, resume(balance))).toThrow();
    expect(step(revoked, { ...authorize, consentVersion: "offer-automatic-charge-v2" }).snapshot).toMatchObject({
      state: "active",
      generation: 3,
      consentVersion: "offer-automatic-charge-v2",
    });
  });

  it.each([false, true])(
    "can hold active or unavailable and resume without new consent (unavailable: %s)",
    (loseCard) => {
      const active = step(initialAuthorization, authorize);
      const original = loseCard ? step(active, unavailable) : active;
      if (loseCard) {
        expect(original.snapshot.state).toBe("payment-method-unavailable");
        expect(decideAuthorization(original, unavailable)).toBeNull();
        expect(step(original, resume(bank)).snapshot).toMatchObject({ state: "active", source: bank, generation: 2 });
      }
      const held = step(original, hold);
      expect(held.snapshot).toMatchObject({ state: "held", generation: 1, latestHeldOrderId: hold.orderId });
      expect(decideAuthorization(held, { ...hold, orderId: "ord_second" })).toBeNull();
      const resumed = step(held, resume(balance));
      expect(resumed.snapshot).toMatchObject({
        state: "active",
        source: balance,
        generation: 2,
        consentVersion: authorize.consentVersion,
      });
      expect(decideAuthorization(resumed, hold)).toBeNull();
      expect(decideAuthorization(resumed, { ...hold, generation: 2 })).toBeNull();
      expect(decideAuthorization(resumed, { ...unavailable, generation: 2 })).toBeNull();
    },
  );

  it("revokes all live states and refuses user commands outside the table", () => {
    const active = step(initialAuthorization, authorize);
    const missing = step(active, unavailable);
    const held = step(active, hold);
    for (const state of [active, missing, held]) {
      const revoked = step(state, revoke);
      expect(revoked.snapshot.state).toBe("revoked");
      expect(decideAuthorization(revoked, hold)).toBeNull();
      expect(() => decideAuthorization(revoked, revoke)).toThrow();
    }
    expect(() => decideAuthorization(initialAuthorization, revoke)).toThrow();
    expect(() => decideAuthorization(initialAuthorization, resume(balance))).toThrow();
    expect(() => decideAuthorization(active, resume(balance))).toThrow();
    expect(() => decideAuthorization(missing, authorize)).toThrow();
    expect(() => decideAuthorization(held, authorize)).toThrow();
    expect(decideAuthorization(initialAuthorization, hold)).toBeNull();
  });

  it("allows a different failed Order after Resume, but never records the earlier Order again", () => {
    const active = step(initialAuthorization, authorize);
    const first = step(active, hold);
    const resumed = step(first, resume(balance));
    expect(decideAuthorization(resumed, { ...hold, generation: 2 })).toBeNull();
    const second = step(resumed, { ...hold, generation: 2, orderId: "ord_second" });
    expect(second.snapshot).toMatchObject({ state: "held", latestHeldOrderId: "ord_second", generation: 2 });
  });
});
