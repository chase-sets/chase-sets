import { t } from "@chase-sets/localization";

const checkoutStatuses = [
  "incomplete",
  "requires_escalation",
  "ready_for_complete",
  "complete_in_progress",
  "completed",
  "canceled",
] as const;

export type AgentCheckoutStatus = (typeof checkoutStatuses)[number];
export type AgentCheckoutViewState = { kind: "loading" } | { kind: "result"; result: unknown };

export type AgentCheckoutMessage = Readonly<{
  type: "error" | "warning" | "info";
  code?: string;
  content: string;
  path?: string;
}>;

type AgentCheckoutTotal = Readonly<{ type: string; displayText?: string; amount: number }>;
type AgentCheckoutLine = Readonly<{ id: string; title: string; quantity: number; total?: number }>;
type AgentCheckoutOrder = Readonly<{ id: string; label?: string; permalinkUrl: string }>;

export type AgentCheckout = Readonly<{
  status: AgentCheckoutStatus;
  currency: string;
  lineItems: readonly AgentCheckoutLine[];
  /** Every entry except the single `total`, in the order the server sent them. */
  breakdown: readonly AgentCheckoutTotal[];
  total: number;
  messages: readonly AgentCheckoutMessage[];
  continueUrl?: string;
  order?: AgentCheckoutOrder;
}>;

export type AgentCheckoutResult =
  | { kind: "malformed" }
  | { kind: "error"; messages: readonly AgentCheckoutMessage[] }
  | { kind: "checkout"; checkout: AgentCheckout };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function fields(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

function isSignedAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isAmount(value: unknown): value is number {
  return isSignedAmount(value) && value >= 0;
}

/** UCP `total.json` signs: discounts are negative, these charges are nonnegative, any other category is signed. */
function isTotalAmount(type: string, amount: unknown): amount is number {
  if (!isSignedAmount(amount)) return false;
  if (type === "discount" || type === "items_discount") return amount < 0;
  if (type === "subtotal" || type === "fulfillment" || type === "tax" || type === "fee") return amount >= 0;
  return true;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parsedAll<T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return;
  const parsed = value.map(parse);
  return parsed.every((entry) => entry !== undefined) ? (parsed as T[]) : undefined;
}

function message(value: unknown): AgentCheckoutMessage | undefined {
  const { type, content, code, path } = fields(value);
  if (
    (type !== "error" && type !== "warning" && type !== "info") ||
    typeof content !== "string" ||
    !content.trim() ||
    !isOptionalString(code) ||
    !isOptionalString(path)
  )
    return;
  return { type, content, ...(code === undefined ? {} : { code }), ...(path === undefined ? {} : { path }) };
}

function total(value: unknown): AgentCheckoutTotal | undefined {
  const { type, amount, display_text: displayText } = fields(value);
  if (typeof type !== "string" || !isTotalAmount(type, amount) || !isOptionalString(displayText)) return;
  return { type, amount, ...(displayText === undefined ? {} : { displayText }) };
}

function lineItem(value: unknown): AgentCheckoutLine | undefined {
  const { id, quantity, item, totals } = fields(value);
  const { title, price } = fields(item);
  const lineTotals = parsedAll(totals, total);
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    !isAmount(price) ||
    typeof quantity !== "number" ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !lineTotals
  )
    return;
  const lineTotal = lineTotals.find((entry) => entry.type === "total")?.amount;
  return { id, title, quantity, ...(lineTotal === undefined ? {} : { total: lineTotal }) };
}

/** `undefined` when absent, `null` when present but unreadable. */
function order(value: unknown): AgentCheckoutOrder | undefined | null {
  if (value === undefined) return undefined;
  const { id, label, permalink_url: permalinkUrl } = fields(value);
  if (typeof id !== "string" || typeof permalinkUrl !== "string" || !isOptionalString(label)) return null;
  return { id, permalinkUrl, ...(label === undefined ? {} : { label }) };
}

/**
 * Reads a UCP 2026-08-25 checkout tool result. Views branch only on `status`, `continue_url`, `order` and
 * `messages`; the producing tool, extensions and message severity never change what renders.
 */
export function agentCheckoutResult(result: unknown): AgentCheckoutResult {
  const envelope = record(record(result)?.structuredContent);
  const ucp = record(envelope?.ucp);
  if (!envelope || ucp?.version !== "2026-08-25") return { kind: "malformed" };
  const messages = envelope.messages === undefined ? [] : parsedAll(envelope.messages, message);
  if (ucp.status === "error") return messages?.length ? { kind: "error", messages } : { kind: "malformed" };

  const { id, currency, continue_url: continueUrl } = envelope;
  const status = checkoutStatuses.find((candidate) => candidate === envelope.status);
  const lineItems = parsedAll(envelope.line_items, lineItem);
  const totals = parsedAll(envelope.totals, total);
  const totalEntries = totals?.filter((entry) => entry.type === "total") ?? [];
  const grandTotal = totalEntries.length === 1 ? totalEntries[0] : undefined;
  const confirmedOrder = order(envelope.order);
  if (
    ucp.status !== "success" ||
    typeof id !== "string" ||
    !status ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency) ||
    !lineItems ||
    !totals ||
    !grandTotal ||
    !messages ||
    !isOptionalString(continueUrl) ||
    confirmedOrder === null ||
    (status === "completed" && !confirmedOrder)
  )
    return { kind: "malformed" };
  return {
    kind: "checkout",
    checkout: {
      status,
      currency,
      lineItems,
      breakdown: totals.filter((entry) => entry.type !== "total"),
      total: grandTotal.amount,
      messages,
      ...(continueUrl === undefined ? {} : { continueUrl }),
      ...(confirmedOrder ? { order: confirmedOrder } : {}),
    },
  };
}

/** The open action admits only credential-free `https:` URLs. */
export function agentCheckoutLink(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {
    // An invalid URL has no open action.
  }
}

export function isTerminalAgentCheckout(status: AgentCheckoutStatus) {
  return status === "canceled" || status === "completed";
}

export function formatAgentCheckoutAmount(amount: number, currency: string) {
  const format = new Intl.NumberFormat("en", { style: "currency", currency });
  return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

export function agentCheckoutTotalLabel({ type, displayText }: AgentCheckoutTotal) {
  if (displayText) return displayText;
  switch (type) {
    case "subtotal":
      return t("checkout.features.sessions.ui.agentCheckout.total.subtotal");
    case "items_discount":
      return t("checkout.features.sessions.ui.agentCheckout.total.itemsDiscount");
    case "discount":
      return t("checkout.features.sessions.ui.agentCheckout.total.discount");
    case "fulfillment":
      return t("checkout.features.sessions.ui.agentCheckout.total.fulfillment");
    case "tax":
      return t("checkout.features.sessions.ui.agentCheckout.total.tax");
    case "fee":
      return t("checkout.features.sessions.ui.agentCheckout.total.fee");
    default:
      return type;
  }
}
