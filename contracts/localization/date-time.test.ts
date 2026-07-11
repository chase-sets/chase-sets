import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "./date-time";

describe("formatDate", () => {
  it("formats an ISO timestamp with the medium preset by default (month, day, year)", () => {
    expect(formatDate("2026-02-23T21:26:00.000Z")).toBe("Feb 23, 2026");
  });

  it("formats a Postgres timestamptz::text query-boundary string (space + offset, no Z)", () => {
    expect(formatDate("2026-02-23 21:26:00.123456+00")).toBe("Feb 23, 2026");
  });

  it("formats the short preset without a year", () => {
    expect(formatDate("2026-02-23T21:26:00.000Z", { preset: "short" })).toBe("Feb 23");
  });

  it("formats the long preset with the full month name", () => {
    expect(formatDate("2026-02-23T21:26:00.000Z", { preset: "long" })).toBe("February 23, 2026");
  });

  it("omits the day when includeDay is false (month/year-only display)", () => {
    expect(formatDate("2026-02-23T21:26:00.000Z", { preset: "long", includeDay: false })).toBe("February 2026");
  });

  it("resolves calendar fields in UTC by default regardless of local wall-clock offset", () => {
    // 11:30 PM UTC on Feb 23 -- a non-UTC local zone could roll this to Feb 24.
    expect(formatDate("2026-02-23T23:30:00.000Z")).toBe("Feb 23, 2026");
  });

  it("honors an explicit non-UTC time zone", () => {
    expect(formatDate("2026-02-23T23:30:00.000Z", { timeZone: "America/Los_Angeles" })).toBe("Feb 23, 2026");
  });

  it("falls back to the raw input string for unparsable values", () => {
    expect(formatDate("pending")).toBe("pending");
  });
});

describe("formatDateTime", () => {
  it("formats an ISO timestamp with the medium preset (month, day, year, time) and a UTC suffix", () => {
    expect(formatDateTime("2026-02-23T21:26:00.000Z")).toBe("Feb 23, 2026, 9:26 PM UTC");
  });

  it("formats the short preset without a year", () => {
    expect(formatDateTime("2026-02-23T21:26:00.000Z", { preset: "short" })).toBe("Feb 23, 9:26 PM UTC");
  });

  it("pads single-digit minutes", () => {
    expect(formatDateTime("2026-02-23T21:05:00.000Z")).toBe("Feb 23, 2026, 9:05 PM UTC");
  });

  it("formats a Postgres timestamptz::text query-boundary string", () => {
    expect(formatDateTime("2026-02-23 21:26:00.123456+00")).toBe("Feb 23, 2026, 9:26 PM UTC");
  });

  it("omits the UTC suffix for an explicit non-UTC time zone", () => {
    const result = formatDateTime("2026-02-23T21:26:00.000Z", { timeZone: "America/Los_Angeles" });
    expect(result).not.toContain("UTC");
    expect(result).toContain("2026");
  });

  it("falls back to the raw input string for unparsable values", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });

  it("renders identically across call sites for the same instant", () => {
    const walletValue = formatDateTime("2026-02-23T21:26:00.000Z");
    const orderValue = formatDateTime("2026-02-23T21:26:00.000Z");

    expect(walletValue).toBe(orderValue);
  });
});
