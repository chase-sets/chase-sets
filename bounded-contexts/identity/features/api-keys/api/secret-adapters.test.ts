import { timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createIdentitySecretAdapters } from "./secret-adapters";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

describe("Identity secret adapters", () => {
  const adapters = createIdentitySecretAdapters();
  const stored = adapters.hashSecret("synthetic-api-secret");

  it.each(["synthetic-api-secret", "different-secret"])(
    "compares the 32-byte digest of %s in constant time",
    (secret) => {
      vi.mocked(timingSafeEqual).mockClear();

      expect(adapters.verifySecret(secret, stored)).toBe(secret === "synthetic-api-secret");
      expect(timingSafeEqual).toHaveBeenCalledExactlyOnceWith(
        Buffer.from(adapters.hashSecret(secret), "hex"),
        Buffer.from(stored, "hex"),
      );
    },
  );

  it.each(["a".repeat(62), "g".repeat(64), `${stored}\n`])("rejects a malformed secret digest", (malformed) => {
    vi.mocked(timingSafeEqual).mockClear();

    expect(adapters.verifySecret("synthetic-api-secret", malformed)).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });
});
