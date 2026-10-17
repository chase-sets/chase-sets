import { afterEach, expect, it, vi } from "vitest";
import { action } from "../../../routes/marketplace/account-shipping-addresses";
import { syntheticMutationResult } from "../../account-management/api/test-support";
import type { MutationAction } from "../../account-management/domain/contract";

const marker = "Bearer synthetic-shipping-token-marker";
const actor = {
  sessionId: "ses_test",
  tenantId: "tnt_test",
  userId: "usr_test",
  accountId: "acc_test",
  membershipId: "mbr_test",
  roleKey: "owner",
  permissions: ["accounts.manage"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const addressId = "adr_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function args(intent: string, shippingAddressId = addressId) {
  return {
    request: new Request("https://marketplace.test/account/shipping-addresses", {
      method: "POST",
      headers: { "Idempotency-Key": "9230f01b-7871-420b-9c32-37139f80f749", Accept: "text/x-script" },
      body: new URLSearchParams({ intent, ...(intent === "create" ? {} : { shippingAddressId }) }),
    }),
    params: {},
    context: undefined,
  };
}

function stub(body: unknown, status: number) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input instanceof Request ? input.url : input).includes("/api/auth/session") ? { actor } : body,
        { status: String(input instanceof Request ? input.url : input).includes("/api/auth/session") ? 200 : status },
      ),
    ),
  );
}

it("partitions real routed failures", async () => {
  const logs = ["error", "warn", "info", "log", "debug"].map((method) =>
    vi.spyOn(console, method as "error").mockImplementation(() => {}),
  );
  const detail = { field: "city", code: "required", message: marker };
  for (const intent of ["create", "update", "default", "archive"]) {
    for (const details of [
      [detail],
      [{ ...detail, field: "token" }],
      [{ ...detail, code: "unknown" }],
      [{ ...detail, nested: { secret: marker } }],
      [{ ...detail, message: "x".repeat(1025) }],
      [detail, detail],
      undefined,
    ]) {
      stub({ error: { code: "validation_failed", message: marker, details } }, 400);
      const result = await action(args(intent));
      const field =
        (intent === "create" || intent === "update") &&
        details?.length === 1 &&
        details[0].field === "city" &&
        details[0].code === "required" &&
        details[0].message.length <= 1024 &&
        !("nested" in details[0]);
      expect(result).toMatchObject({
        data: {
          failure: {
            intent,
            classification: field ? "FIELD" : "INDETERMINATE",
            errors: {
              fieldErrors: field ? { city: ["City is required."] } : {},
              formErrors: field ? [] : [expect.any(String)],
            },
            ...(intent === "update" ? { shippingAddressId: addressId } : {}),
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  }
  stub({ error: { code: "validation_failed", message: marker, details: [detail] } }, 422);
  const mismatchedStatus = await action(args("create"));
  expect(mismatchedStatus).toMatchObject({
    data: {
      failure: {
        intent: "create",
        classification: "INDETERMINATE",
        errors: { fieldErrors: {}, formErrors: [expect.any(String)] },
      },
    },
  });
  expect(JSON.stringify(mismatchedStatus)).not.toContain(marker);
  expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(marker);
});

it("preserves action success and rejection authority", async () => {
  for (const intent of ["create", "update", "default", "archive"]) {
    stub(
      syntheticMutationResult(intent as MutationAction, actor, { target: intent === "create" ? null : addressId }),
      200,
    );
    const success = (await action(args(intent))) as Response;
    expect(success.status).toBe(200);
    expect(success.headers.get("Location")).toBeNull();
    expect(await success.json()).toMatchObject({ outcome: "committed" });
    for (const status of [401, 403, 500, 503]) {
      stub({ error: { code: "validation_failed", message: marker } }, status);
      await expect(action(args(intent))).rejects.toThrow();
    }
    stub(
      { error: { code: "address_standardization_suggested", message: marker }, suggestedAddress: { token: marker } },
      409,
    );
    const result = await action(args(intent));
    expect(result).toMatchObject({ data: { failure: { classification: "FORM", errors: { fieldErrors: {} } } } });
    expect(JSON.stringify(result)).not.toContain(marker);
  }
});

it("rejects raw message and token markers from row identity and unknown intents", async () => {
  for (const shippingAddressId of [marker, `adr_${marker}`, "adr_not-canonical", "adr_" + "x".repeat(1024)]) {
    stub({ error: { code: "validation_failed", message: marker } }, 400);
    const result = await action(args("update", shippingAddressId));
    expect(result).not.toHaveProperty("data.failure.shippingAddressId");
    expect(JSON.stringify(result)).not.toContain(marker);
  }
  stub({}, 200);
  const result = await action(args(marker));
  if (!(result instanceof Response)) throw new Error("Expected refusal");
  expect(result.status).toBe(400);
  const body = await result.json();
  expect(body).toEqual({ outcome: "not-recorded", code: "interruption-safe-client-required" });
  expect(JSON.stringify(body)).not.toContain(marker);
});
