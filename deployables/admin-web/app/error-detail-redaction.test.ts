import { describe, expect, it } from "vitest";
import { redactAdminErrorDetail } from "./error-detail-redaction";

describe("redactAdminErrorDetail", () => {
  it("redacts email addresses", () => {
    expect(redactAdminErrorDetail("no account found for operator@example.com")).toBe(
      "no account found for [redacted-email]",
    );
  });

  it("redacts cookie and set-cookie assignments", () => {
    expect(redactAdminErrorDetail("Cookie: chase_sets_session=abc123def456")).toContain("[redacted-cookie]");
  });

  it("redacts the chase_sets session cookie name even without a Cookie: label", () => {
    expect(redactAdminErrorDetail("stale value chase_sets_session=abc123def456; retry")).toContain("[redacted-cookie]");
  });

  it("redacts session and csrf token assignments", () => {
    expect(redactAdminErrorDetail("session_token=abcdefgh12345678 expired")).toContain("[redacted-session]");
    expect(redactAdminErrorDetail("csrf-token: abcdefgh12345678 mismatch")).toContain("[redacted-session]");
  });

  it("redacts authorization headers and bearer tokens", () => {
    expect(redactAdminErrorDetail("authorization: Bearer abcdefgh12345678")).toContain("[redacted-token]");
    expect(redactAdminErrorDetail("failed with Bearer abcdefgh12345678")).toContain("[redacted-token]");
  });

  it("redacts JWT-shaped tokens", () => {
    expect(
      redactAdminErrorDetail(
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toContain("[redacted-token]");
  });

  it("redacts raw read-after-write recovery tokens", () => {
    expect(redactAdminErrorDetail("retry with afterWrite=abcXYZ123")).toContain("[redacted-token]");
    expect(redactAdminErrorDetail("Chase-Sets-Read-After-Write: abcXYZ123")).toContain("[redacted-token]");
  });

  it("redacts raw domain ids", () => {
    expect(redactAdminErrorDetail("membership_01H8ZZZZZZZZZZZZZZZZZZZZZZ not found")).toBe("[redacted-id] not found");
    expect(redactAdminErrorDetail("account_01H8ZZZZZZZZZZZZZZZZZZZZZZ suspended")).toBe("[redacted-id] suspended");
  });

  it("redacts full URLs", () => {
    expect(redactAdminErrorDetail("failed fetching https://admin.staging.chasesets.com/api/access/x?y=1")).toBe(
      "failed fetching [redacted-url]",
    );
  });

  it("leaves support-safe technical detail untouched", () => {
    const message = "Failed to load projection status: request timed out after 5000ms";
    expect(redactAdminErrorDetail(message)).toBe(message);
  });

  it("is idempotent", () => {
    const once = redactAdminErrorDetail("membership_01H8ZZZZZZZZZZZZZZZZZZZZZZ for operator@example.com");
    expect(redactAdminErrorDetail(once)).toBe(once);
  });
});
