import { describe, expect, it } from "vitest";
import { parseTypedIdBoundary } from "./typed-id";

describe("parseTypedIdBoundary", () => {
  it("returns a branded ID when the prefix matches", () => {
    expect(parseTypedIdBoundary("  acc_01TEST  ", "acc", "accountId")).toBe("acc_01TEST");
  });

  it.each(["usr_01TEST", "01TEST", undefined])(
    "returns a typed 400 error when the expected prefix is wrong or missing (%s)",
    (value) => {
      expect(() => parseTypedIdBoundary(value, "acc", "accountId")).toThrowError(
        expect.objectContaining({
          name: "TypedIdBoundaryDomainError",
          status: 400,
          body: {
            error: {
              code: "validation_failed",
              message: "accountId must start with acc_.",
              details: [
                {
                  field: "accountId",
                  code: "invalid_id_prefix",
                  message: "Expected an ID starting with acc_.",
                },
              ],
            },
          },
        }),
      );
    },
  );
});
