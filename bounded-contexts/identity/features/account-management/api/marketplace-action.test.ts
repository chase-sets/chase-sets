import { describe, expect, it, vi } from "vitest";
import { accountMutationResponse, requireInterruptionSafeClient } from "./marketplace-action";
import * as responses from "@chase-sets/http/responses";
import { syntheticMutationResult } from "./test-support";

describe("issue-7168-ac9-transport-state", () => {
  it("snapshot-return secrets revalidate plainly; fresh-read destinations are supplied by their owning routes", async () => {
    const helper = vi.spyOn(responses, "navigateAfterWrite").mockReturnValue("/unexpected-token");
    try {
      const result = syntheticMutationResult("create-api-key", {
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
      });
      expect((await accountMutationResponse(result, "/account/security").json()).destination).toBe("/account/security");
      expect(helper).not.toHaveBeenCalled();
      expect(
        (await accountMutationResponse(result, "/account/security", "/account/security?afterWrite=synthetic").json())
          .destination,
      ).toBe("/account/security?afterWrite=synthetic");
    } finally {
      helper.mockRestore();
    }
  });
});

describe("issue-7168-ac1-derived-partition", () => {
  it("refuses missing keys, unknown fields and a sixteenth action before authorization or work", async () => {
    const work = vi.fn(async () => Response.json({ outcome: "committed" }));
    const action = requireInterruptionSafeClient(work);
    for (const [key, fields] of [
      [null, { intent: "update-profile" }],
      ["invalid", { intent: "update-profile" }],
      ["9230f01b-7871-420b-9c32-37139f80f749", { intent: "sixteenth" }],
      ["9230f01b-7871-420b-9c32-37139f80f749", { intent: "update-profile", secret: "x" }],
    ] as const) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      const response = await action({
        request: new Request("http://localhost/account", {
          method: "POST",
          headers: key ? { "Idempotency-Key": key, Accept: "text/x-script" } : { Accept: "text/x-script" },
          body: form,
        }),
        params: {},
        context: {},
      });
      if (!(response instanceof Response)) throw new Error("Expected refusal");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ outcome: "not-recorded", code: "interruption-safe-client-required" });
    }
    expect(work).not.toHaveBeenCalled();
  });
  it("rejects native document, duplicate fields and cross-route intent mutants with zero work", async () => {
    const work = vi.fn(async () => Response.json({ outcome: "committed" }));
    const action = requireInterruptionSafeClient(work);
    for (const [headers, fields] of [
      [{ Accept: "text/html" }, "intent=update-profile"],
      [{ Accept: "text/x-script", "Sec-Fetch-Dest": "document" }, "intent=update-profile"],
      [{ Accept: "text/x-script" }, "intent=update-profile&name=one&name=two"],
      [{ Accept: "text/x-script" }, "intent=create-api-key&name=bad"],
    ] as const) {
      const response = await action({
        request: new Request("http://localhost/account", {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": "9230f01b-7871-420b-9c32-37139f80f749" },
          body: new URLSearchParams(fields),
        }),
        params: {},
        context: {},
      });
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(400);
    }
    expect(work).not.toHaveBeenCalled();
  });
});
