import { afterEach, describe, expect, it, vi } from "vitest";
import * as router from "react-router";
import { syntheticMutationResult } from "../api/test-support";
import { resolveClientState, sendMutation } from "./transport";
const binding = { tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" };
afterEach(() => vi.restoreAllMocks());

describe("issue-9909 failure details", () => {
  const target = "adr_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const marker = "SYNTHETIC-SECRET-MARKER-9909";
  const failure = {
    kind: "validation",
    status: 400,
    code: "validation_failed",
    message: "City is required.",
    intent: "update",
    classification: "FIELD",
    shippingAddressId: target,
    errors: { fieldErrors: { city: ["City is required."] }, formErrors: [] },
  };
  async function direct(value: unknown, status = 400, action = "update", sentTarget: string | null = target) {
    vi.spyOn(router, "UNSAFE_decodeViaTurboStream").mockResolvedValue({ value: { data: value } } as never);
    return sendMutation({
      route: action === "update-profile" ? "/account" : "/account/shipping-addresses",
      action,
      target: sentTarget,
      key: "9230f01b-7871-420b-9c32-37139f80f749",
      form: new FormData(),
      binding,
      fetch: vi.fn().mockResolvedValue(new Response("synthetic", { status })),
    });
  }
  it("keyed field envelope remains failed-safe", () => {
    expect(resolveClientState({ failure }, 400)).toBe("failed-safe");
  });
  it("retired validation-failed resolves ambiguous", () => {
    expect(resolveClientState({ outcome: "not-recorded", code: "validation-failed" }, 400)).toBe("ambiguous");
  });
  it("failure details accept-mismatched-intent drops only details", async () => {
    const value = {
      ...failure,
      intent: "create",
      shippingAddressId: undefined,
      errors: { fieldErrors: { name: ["Name is required."] }, formErrors: [] },
    };
    expect(await direct({ failure: value }, 400, "update-profile", "acc_test")).toEqual({ state: "failed-safe" });
  });
  it.each([
    ["other address", "update", target, "adr_01ARZ3NDEKTSV4RRFFQ69G5FAT"],
    ["id on create", "create", null, target],
    ["non-adr id", "update", target, "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
  ] as const)("failure details accept-mismatched-target: %s", async (_name, action, sentTarget, id) => {
    expect(
      await direct({ failure: { ...failure, intent: action, shippingAddressId: id } }, 400, action, sentTarget),
    ).toEqual({ state: "failed-safe" });
  });
  it("failure details accept-unknown-field checks the sent intent actionFields", async () => {
    expect(
      await direct(
        {
          failure: {
            ...failure,
            intent: "update-profile",
            shippingAddressId: undefined,
            errors: { fieldErrors: { label: [marker] }, formErrors: [] },
          },
        },
        400,
        "update-profile",
        "acc_test",
      ),
    ).toEqual({ state: "failed-safe" });
  });
  it.each([
    ["nested unknown", { ...failure.errors, unknown: marker }],
    ["11 messages", { fieldErrors: { city: Array.from({ length: 11 }, () => "City is required.") }, formErrors: [] }],
    ["501-char message", { fieldErrors: { city: ["x".repeat(501)] }, formErrors: [] }],
  ])("failure details accept-nested-unknown: %s", async (_name, errors) => {
    expect((await direct({ failure: { ...failure, errors } })).failure).toBeUndefined();
  });
  it("failure details accept-non-failed-safe-details: conflict", async () => {
    expect(await direct({ failure: { ...failure, kind: "domain", status: 409, code: "conflict" } }, 409)).toEqual({
      state: "conflict",
    });
  });
  it.each([
    ["ambiguous", { outcome: "indeterminate", code: "INDETERMINATE" }, "ambiguous"],
    ["succeeded", syntheticMutationResult("update", binding, { target }), "succeeded"],
  ])("failure details accept-non-failed-safe-details: %s", async (_name, value, state) => {
    const result = await direct(value);
    expect(result.state).toBe(state);
    expect(result.failure).toBeUndefined();
  });
  it("failure details accept-lookup-details never hands off a lookup envelope", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic loss"))
      .mockResolvedValueOnce(Response.json({ failure }, { status: 400 }));
    const result = await sendMutation({
      route: "/account/shipping-addresses",
      action: "update",
      target,
      key: "9230f01b-7871-420b-9c32-37139f80f749",
      form: new FormData(),
      binding,
      fetch,
    });
    expect(result).toEqual({ state: "failed-safe" });
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "GET"]);
  });
  it("failure details exclude synthetic secrets outside the admitted set", async () => {
    const admitted = await direct({ failure: { ...failure, classification: marker } });
    expect(admitted.failure?.message).toBe(failure.message);
    expect(JSON.stringify(admitted)).not.toContain(marker);
    for (const patch of [
      { errors: { fieldErrors: { unknown: [marker] }, formErrors: [] } },
      { errors: { ...failure.errors, unknown: marker } },
      { message: marker, intent: "create" },
    ]) {
      const result = await direct({ failure: { ...failure, ...patch } });
      expect(result.failure).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });
});

describe("issue-7168-ac9-transport-state", () => {
  it("failure details are admitted only for the direct validated keyed envelope", async () => {
    const target = "adr_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const failure = {
      kind: "validation",
      status: 400,
      code: "validation_failed",
      message: "City is required.",
      intent: "update",
      classification: "FIELD",
      shippingAddressId: target,
      errors: { fieldErrors: { city: ["City is required."] }, formErrors: [] },
    };
    vi.spyOn(router, "UNSAFE_decodeViaTurboStream").mockResolvedValue({ value: { data: { failure } } } as never);
    const fetch = vi.fn().mockResolvedValue(new Response("synthetic", { status: 400 }));
    const result = await sendMutation({
      route: "/account/shipping-addresses",
      action: "update",
      target,
      key: "9230f01b-7871-420b-9c32-37139f80f749",
      form: new FormData(),
      fetch,
      binding,
    });
    expect(result).toMatchObject({
      state: "failed-safe",
      failure: { intent: "update", target, message: failure.message },
    });
    expect(Object.isFrozen(result.failure)).toBe(true);
    expect(Object.isFrozen(result.failure?.errors)).toBe(true);

    for (const patch of [
      { intent: "create" },
      { shippingAddressId: "adr_01ARZ3NDEKTSV4RRFFQ69G5FAT" },
      { shippingAddressId: undefined, intent: "create" },
      { shippingAddressId: "not-an-address" },
      { errors: { fieldErrors: { unknown: ["marker"] }, formErrors: [] } },
    ]) {
      vi.spyOn(router, "UNSAFE_decodeViaTurboStream").mockResolvedValueOnce({
        value: { data: { failure: { ...failure, ...patch } } },
      } as never);
      const rejected = await sendMutation({
        route: "/account/shipping-addresses",
        action: "update",
        target,
        key: "f230f01b-7871-420b-9c32-37139f80f749",
        form: new FormData(),
        fetch: vi.fn().mockResolvedValue(new Response("synthetic", { status: 400 })),
        binding,
      });
      expect(rejected.failure).toBeUndefined();
    }
  });

  it("uses one keyed .data POST and one read-only confirmation after possibly-sent loss", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(Response.json({ outcome: "not-recorded", code: "not-recorded" }));
    const form = new FormData();
    form.set("intent", "revoke");
    form.set("membershipId", "mbr_test");
    const result = await sendMutation({
      route: "/account/team",
      action: "revoke",
      target: "mbr_test",
      key: "9230f01b-7871-420b-9c32-37139f80f749",
      form,
      fetch,
      binding,
    });
    expect(result.state).toBe("failed-safe");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe("/account/team.data");
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Idempotency-Key": "9230f01b-7871-420b-9c32-37139f80f749" },
    });
    expect(fetch.mock.calls[1][1].method).toBe("GET");
  });
  it("maps the closed lookup table and rejects unknown, secret-return and retry mutants", async () => {
    expect(resolveClientState({ outcome: "not-recorded", code: "not-recorded" }, 200)).toBe("failed-safe");
    expect(resolveClientState({ outcome: "indeterminate", code: "INDETERMINATE" }, 200)).toBe("ambiguous");
    expect(resolveClientState(null, 401)).toBe("reauth-required");
    expect(resolveClientState(null, 403)).toBe("route-denied");
    expect(resolveClientState({ outcome: "anything" }, 200)).toBe("ambiguous");
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ outcome: "indeterminate", code: "INDETERMINATE", secret: "unexpected" }));
    const form = new FormData();
    form.set("intent", "revoke");
    expect(
      (
        await sendMutation({
          route: "/account/team",
          action: "revoke",
          target: "mbr_test",
          key: "9230f01b-7871-420b-9c32-37139f80f749",
          form,
          fetch,
          binding,
        })
      ).state,
    ).toBe("ambiguous");
    expect(fetch.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(1);
  });
  it.each(["committed", "not-recorded", "indeterminate", "conflict", "401", "403"])(
    "reads the %s recovery arm exactly once",
    async (outcome) => {
      const committed = syntheticMutationResult("revoke", binding, { target: "mbr_test", newlyCommitted: false });
      const status = outcome === "401" ? 401 : outcome === "403" ? 403 : 200;
      const value =
        outcome === "committed"
          ? committed
          : { outcome, code: outcome === "indeterminate" ? "INDETERMINATE" : outcome };
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("synthetic loss"))
        .mockResolvedValueOnce(Response.json(value, { status }));
      const onConfirming = vi.fn();
      const result = await sendMutation({
        route: "/account/team",
        action: "revoke",
        target: "mbr_test",
        key: "9230f01b-7871-420b-9c32-37139f80f749",
        form: new FormData(),
        fetch,
        binding,
        onConfirming,
      });
      expect(result.state).toBe(
        {
          committed: "succeeded",
          "not-recorded": "failed-safe",
          indeterminate: "ambiguous",
          conflict: "conflict",
          "401": "reauth-required",
          "403": "route-denied",
        }[outcome],
      );
      expect(onConfirming).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "GET"]);
    },
  );
  it("refuses pre-fetch bad key/route mutants and never accepts foreign actor/target or lookup secret", async () => {
    const form = new FormData();
    const args = {
      route: "/account/team",
      action: "revoke",
      target: "mbr_test",
      key: "9230f01b-7871-420b-9c32-37139f80f749",
      form,
      binding,
    };
    for (const patch of [
      { key: "bad" },
      { route: "https://other.test/account/team" },
      { action: "sixteenth" },
      { route: "/account/security" },
    ]) {
      const fetch = vi.fn();
      expect((await sendMutation({ ...args, ...patch, fetch })).state).toBe("failed-safe");
      expect(fetch).not.toHaveBeenCalled();
    }
    for (const value of [
      syntheticMutationResult("revoke", { ...binding, accountId: "acc_foreign" }, { target: "mbr_test" }),
      syntheticMutationResult("revoke", binding, { target: "mbr_foreign" }),
      syntheticMutationResult("create-api-key", binding, { newlyCommitted: true, secret: "key_synthetic_secret" }),
    ]) {
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("synthetic loss"))
        .mockResolvedValueOnce(Response.json(value));
      expect((await sendMutation({ ...args, fetch })).state).toBe("ambiguous");
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
  it("keeps a first-response key secret outside router state; replay cannot return it", async () => {
    const value = syntheticMutationResult("create-api-key", binding, { secret: "key_synthetic_secret" });
    vi.spyOn(router, "UNSAFE_decodeViaTurboStream").mockResolvedValue({ value: { data: value } } as never);
    const fetch = vi.fn().mockResolvedValue(new Response("synthetic stream"));
    const args = {
      route: "/account/security",
      action: "create-api-key",
      target: null,
      key: "9230f01b-7871-420b-9c32-37139f80f749",
      form: new FormData(),
      fetch,
      binding,
    };
    expect(await sendMutation(args)).toMatchObject({ state: "succeeded", secret: "key_synthetic_secret" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolveClientState({ ...value, newlyCommitted: false }, 200)).toBe("ambiguous");
    expect(resolveClientState({ ...value, secretState: "committed-secret-unrecoverable" }, 200)).toBe("ambiguous");
  });
});
