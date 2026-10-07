import { describe, expect, it } from "vitest";
import {
  supportOperationsQueueFilters,
  supportOperationsQueuePagination,
  supportOperationsQueueQuery,
} from "./list-pagination";

describe("support operations queue URL filters", () => {
  it("round-trips unresolved and its page window alongside other filters", () => {
    const request = new Request(
      "https://support.example.test/support/requests?status=unresolved&limit=2&offset=2&priority=normal&search=SUP-ABCD1234&flowType=return-request&contested=true&overdue=true",
    );
    expect(supportOperationsQueueFilters(request)).toEqual({
      status: "unresolved",
      priority: "normal",
      search: "SUP-ABCD1234",
      flowType: "return-request",
      contested: true,
      overdue: true,
    });
    expect(supportOperationsQueuePagination(request)).toEqual({ limit: 2, offset: 2 });
    expect(new URLSearchParams(supportOperationsQueueQuery(request)).get("status")).toBe("unresolved");
    expect(supportOperationsQueueQuery(request)).toBe(
      "limit=2&offset=2&status=unresolved&priority=normal&search=SUP-ABCD1234&flowType=return-request&contested=true&overdue=true",
    );
  });

  it.each(["", "all", "unknown-status"])("normalizes %s to the default view", (status) => {
    const request = new Request(`https://support.example.test/support/requests?status=${status}`);
    expect(supportOperationsQueueFilters(request).status).toBe("all");
    expect(supportOperationsQueueQuery(request)).toBe("limit=50&offset=0");
  });

  it.each(["open", "waiting-on-buyer", "waiting-on-seller", "ready-for-support", "resolved", "closed", "cancelled"])(
    "preserves the existing %s status",
    (status) => {
      const request = new Request(`https://support.example.test/support/requests?status=${status}`);
      expect(supportOperationsQueueFilters(request).status).toBe(status);
      expect(new URLSearchParams(supportOperationsQueueQuery(request)).get("status")).toBe(status);
    },
  );
});
