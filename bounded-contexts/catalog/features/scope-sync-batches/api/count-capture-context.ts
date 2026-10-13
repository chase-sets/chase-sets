import { AsyncLocalStorage } from "node:async_hooks";
import {
  countFingerprint,
  countQueryKey,
  type ScrydexCountQuery,
  type ScrydexCountSource,
} from "../domain/count-acquisition";
import type { ScopeSyncBatchPlanner } from "./planner";

export type CountCapturePhase = "baseline" | "bootstrap" | "quote" | "acquisition" | "preview" | "pre-confirm";
export type CountCaptureBinding = Readonly<{ runId: string; requestId: string; phase: CountCapturePhase }>;
export type CountCaptureUsage = Readonly<{ purpose: "bootstrap" | "readiness" | "planImport"; unitKey?: string }>;
export type CountCaptureSend = Readonly<{
  category: "usage" | "cards" | "sealed";
  requestFingerprint: string;
  usage?: CountCaptureUsage;
}>;
const usageRequests = new AsyncLocalStorage<CountCaptureUsage>();
export function runCountCaptureUsage<T>(usage: CountCaptureUsage, work: () => T): T {
  return usageRequests.run(usage, work);
}
export type CountCaptureLedger = Readonly<{
  debit(binding: CountCaptureBinding, send: CountCaptureSend): Promise<number>;
  result(binding: CountCaptureBinding, sequence: number, status: number): Promise<void>;
  stop(binding: CountCaptureBinding): Promise<void>;
}>;
export class CountCaptureStopped extends Error {
  constructor() {
    super("capture-stopped");
  }
}
const requests = new AsyncLocalStorage<
  Readonly<{
    binding: CountCaptureBinding;
    ledger: CountCaptureLedger;
  }>
>();
export type CountCaptureWinner = Readonly<{
  query: ScrydexCountQuery;
  source: ScrydexCountSource | null;
  readAt: string;
}>;
const observers = new AsyncLocalStorage<CountCaptureWinner[]>();
type CountCapturePlan = Awaited<ReturnType<ScopeSyncBatchPlanner["resolve"]>>;
const planObservers = new AsyncLocalStorage<CountCapturePlan[]>();

export function countCaptureRequestIsBound() {
  return requests.getStore() !== undefined;
}

export async function collectCountCaptureWinners<T>(work: () => Promise<T>) {
  const winners: CountCaptureWinner[] = [];
  const value = await observers.run(winners, work);
  return { value, winners };
}

export function observeCountCapturePlan(plan: CountCapturePlan) {
  const plans = planObservers.getStore();
  if (!plans) return;
  if (plans.length !== 0) throw new CountCaptureStopped();
  plans.push(structuredClone(plan));
}

export async function collectCountCapturePlannerRead<T>(work: () => Promise<T>) {
  const plans: CountCapturePlan[] = [];
  const result = await planObservers.run(plans, () => collectCountCaptureWinners(work));
  if (plans.length !== 1) throw new CountCaptureStopped();
  const plan = plans[0]!;
  const selected = plan.plans.flatMap((scope) => scope.participationPreview.units.filter((unit) => unit.selected));
  for (const unit of selected) {
    const source = unit.estimate.countSource;
    if (!source) continue;
    const winners = result.winners.filter((winner) => winner.query.unitKey === unit.unitKey);
    if (
      winners.length !== 1 ||
      countFingerprint(winners[0]!.source) !== countFingerprint(source) ||
      countQueryKey(winners[0]!.query) !== countQueryKey(source.query)
    )
      throw new CountCaptureStopped();
  }
  // A reader call not represented by the actual plan is not evidence for this
  // request, even when its totals happen to match a selected source.
  for (const winner of result.winners) {
    const units = selected.filter((unit) => unit.unitKey === winner.query.unitKey);
    if (
      units.length !== 1 ||
      countFingerprint(units[0]!.estimate.countSource ?? null) !== countFingerprint(winner.source)
    )
      throw new CountCaptureStopped();
  }
  return { ...result, plan };
}

export function observeCountCaptureWinner(query: ScrydexCountQuery, source: ScrydexCountSource | null, readAt: string) {
  const winners = observers.getStore();
  if (!winners) return;
  if (winners.length >= 6) throw new CountCaptureStopped();
  winners.push(structuredClone({ query, source, readAt }));
}

export async function runCountCaptureRequest<T>(
  input: Readonly<{ binding: CountCaptureBinding; ledger: CountCaptureLedger }>,
  work: () => Promise<T>,
): Promise<T> {
  if (requests.getStore()) throw new CountCaptureStopped();
  return requests.run(input, async () => {
    try {
      return await work();
    } catch {
      try {
        await input.ledger.stop(input.binding);
      } catch {
        /* A retained in-flight request remains closed. */
      }
      throw new CountCaptureStopped();
    }
  });
}

// The classifier examines the actual transport target, not a browser request or
// caller-supplied category. The durable ledger also matches the approved query.
export function classifyCountCaptureSend(
  provider: string,
  category: string | undefined,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): CountCaptureSend {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  if (
    provider !== "scrydex" ||
    url.origin !== "https://api.scrydex.com" ||
    url.username ||
    url.password ||
    url.hash ||
    (init?.method ?? request?.method ?? "GET") !== "GET"
  )
    throw new CountCaptureStopped();
  if (category === "usage" && url.pathname === "/account/v1/usage" && !url.search)
    return { category: "usage", requestFingerprint: countFingerprint({ method: "GET", path: "account/v1/usage" }) };
  if (category !== "card-force" || !url.pathname.startsWith("/onepiece/v1/")) throw new CountCaptureStopped();
  const path = url.pathname.slice("/onepiece/v1/".length);
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !["page", "page_size", "select", "q"].includes(key)) ||
    url.searchParams.get("page") !== "1"
  )
    throw new CountCaptureStopped();
  const kind =
    path === "cards" && url.searchParams.get("q") === "printings:OP01"
      ? "cards"
      : path === "expansions/OP01/sealed" && !url.searchParams.has("q")
        ? "sealed"
        : null;
  if (!kind) throw new CountCaptureStopped();
  return {
    category: kind,
    requestFingerprint: countFingerprint({ method: "GET", path, query: Object.fromEntries(url.searchParams) }),
  };
}

export async function sendCountCaptureRequest(
  provider: string,
  category: string | undefined,
  transport: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const capture = requests.getStore();
  if (!capture) return transport(input, init);
  try {
    const classified = classifyCountCaptureSend(provider, category, input, init);
    const send = classified.category === "usage" ? { ...classified, usage: usageRequests.getStore() } : classified;
    const sequence = await capture.ledger.debit(capture.binding, send);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 11) throw new CountCaptureStopped();
    const response = await transport(input, { ...init, redirect: "manual" });
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      throw new CountCaptureStopped();
    }
    await capture.ledger.result(capture.binding, sequence, response.status);
    return response;
  } catch {
    try {
      await capture.ledger.stop(capture.binding);
    } catch {
      /* Never release a possible-send debit. */
    }
    throw new CountCaptureStopped();
  }
}
