import type { SupportOperationsQueueFilters } from "../../features/support-requests/ui/contracts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;
const SUPPORT_OPERATIONS_QUEUE_STATUSES = new Set([
  "open",
  "waiting-on-buyer",
  "waiting-on-seller",
  "ready-for-support",
  "resolved",
  "closed",
  "cancelled",
]);
const SUPPORT_OPERATIONS_QUEUE_PRIORITIES = new Set(["normal", "urgent"]);
const SUPPORT_OPERATIONS_QUEUE_FLOW_TYPES = new Set([
  "product-not-received",
  "product-not-as-described",
  "product-damaged",
  "wrong-product-received",
  "missing-products",
  "authenticity-concern",
  "return-request",
  "buyer-cancel-request",
  "seller-cannot-fulfill",
  "refund-status",
  "shipping-label-or-tracking",
  "payment-problem",
]);

/**
 * Reads the operator support queue's filters — status, priority, flow type,
 * contested, overdue — and search from the request's URL so the applied
 * filters round-trip through links, form submissions, and browser navigation
 * instead of resetting on every load.
 */
export function supportOperationsQueueFilters(request: Request): SupportOperationsQueueFilters {
  const searchParams = new URL(request.url).searchParams;
  const status = searchParams.get("status")?.trim() ?? "";
  const priority = searchParams.get("priority")?.trim() ?? "";
  const flowType = searchParams.get("flowType")?.trim() ?? "";

  return {
    status: SUPPORT_OPERATIONS_QUEUE_STATUSES.has(status) ? status : "all",
    priority: SUPPORT_OPERATIONS_QUEUE_PRIORITIES.has(priority) ? priority : "all",
    search: searchParams.get("search")?.trim() ?? "",
    flowType: SUPPORT_OPERATIONS_QUEUE_FLOW_TYPES.has(flowType) ? flowType : "all",
    contested: searchParams.get("contested") === "true",
    overdue: searchParams.get("overdue") === "true",
  };
}

/**
 * Builds the `limit`/`offset`/`status`/`priority`/`search`/`flowType`/`contested`/`overdue` query
 * string for the operator support queue, reading pagination and filter state from the request's
 * URL so page position and applied filters round-trip through links and browser navigation instead
 * of resetting to the first page or clearing filters on every load.
 */
export function supportOperationsQueueQuery(request: Request): string {
  const searchParams = new URL(request.url).searchParams;
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || DEFAULT_LIMIT, MAX_LIMIT));
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const { status, priority, search, flowType, contested, overdue } = supportOperationsQueueFilters(request);

  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status !== "all") {
    query.set("status", status);
  }
  if (priority !== "all") {
    query.set("priority", priority);
  }
  if (search) {
    query.set("search", search);
  }
  if (flowType !== "all") {
    query.set("flowType", flowType);
  }
  if (contested) {
    query.set("contested", "true");
  }
  if (overdue) {
    query.set("overdue", "true");
  }

  return query.toString();
}

/** Reads the normalized `limit`/`offset` pagination window from the request's URL. */
export function supportOperationsQueuePagination(request: Request): Readonly<{ limit: number; offset: number }> {
  const searchParams = new URL(request.url).searchParams;
  return {
    limit: Math.max(1, Math.min(Number(searchParams.get("limit")) || DEFAULT_LIMIT, MAX_LIMIT)),
    offset: Math.max(0, Number(searchParams.get("offset")) || 0),
  };
}
