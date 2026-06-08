import { describe, expect, it } from "vitest";
import { formatCommercialTermsAdminLoadError } from "./admin-loader-error";

describe("formatCommercialTermsAdminLoadError", () => {
  it("returns recoverable messages for loader errors", () => {
    expect(formatCommercialTermsAdminLoadError(new Error("Commercial Terms API request failed."))).toBe(
      "Commercial Terms API request failed.",
    );
  });

  it("preserves route responses for auth redirects and framework errors", () => {
    const response = new Response(null, { status: 302 });

    expect(() => formatCommercialTermsAdminLoadError(response)).toThrow(response);
  });
});
