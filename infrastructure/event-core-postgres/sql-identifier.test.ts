import { describe, expect, it } from "vitest";
import { assertSqlIdentifier } from "./sql-identifier";

describe("SQL identifier validation", () => {
  it("accepts simple identifiers and rejects unsafe SQL fragments", () => {
    expect(assertSqlIdentifier("event_store_events")).toBe("event_store_events");
    expect(assertSqlIdentifier("_projection_1")).toBe("_projection_1");

    expect(() => assertSqlIdentifier("1_table")).toThrow("Invalid SQL identifier");
    expect(() => assertSqlIdentifier("events; DROP TABLE events")).toThrow("Invalid SQL identifier");
    expect(() => assertSqlIdentifier("event-store")).toThrow("Invalid SQL identifier");
  });
});
