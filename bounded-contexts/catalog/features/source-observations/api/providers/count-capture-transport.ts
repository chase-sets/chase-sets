import { AsyncLocalStorage } from "node:async_hooks";
import { countFingerprint } from "../../../scope-sync-batches/domain/count-acquisition";

export const countCapturePhases = ["baseline", "bootstrap", "quote", "acquisition", "preview", "pre-confirm"] as const;
export type CountCapturePhase = (typeof countCapturePhases)[number];
export type CountCaptureBinding = Readonly<{ runId: string; requestId: string; phase: CountCapturePhase }>;
export type CountCaptureUsage = Readonly<{ purpose: "bootstrap" | "readiness" | "planImport"; unitKey?: string }>;
export type CountCaptureSend = Readonly<{
  category: "usage" | "cards" | "sealed";
  requestFingerprint: string;
  usage?: CountCaptureUsage;
}>;
// The capture store implements this port; the transport never imports a store.
export type CountCaptureLedger = Readonly<{
  debit(binding: CountCaptureBinding, send: CountCaptureSend): Promise<number>;
  result(binding: CountCaptureBinding, sequence: number, status: number): Promise<void>;
  stop(binding: CountCaptureBinding): Promise<void>;
}>;

export class CountCaptureStopped extends Error {
  constructor() {
    super("capture-stopped");
    this.name = "CountCaptureStopped";
  }
}

type CountCaptureRequest = {
  readonly binding: CountCaptureBinding;
  readonly ledger: CountCaptureLedger;
  stopped: boolean;
  durablyStopped: boolean;
};
const requests = new AsyncLocalStorage<CountCaptureRequest>();
const usages = new AsyncLocalStorage<CountCaptureUsage>();

// Tags the usage read issued by `work` so a bound capture can debit the right slot.
export function runCountCaptureUsage<T>(usage: CountCaptureUsage, work: () => T): T {
  return usages.run(usage, work);
}

// A capture permits no send after an unresolved possible send. Plan its units
// serially so independent units cannot race that guard; ordinary plans stay parallel.
export async function mapCountCaptureUnits<T, R>(units: readonly T[], plan: (unit: T) => Promise<R>): Promise<R[]> {
  const request = requests.getStore();
  if (!request) return Promise.all(units.map(plan));
  const results: R[] = [];
  for (const unit of units) {
    if (request.stopped) throw new CountCaptureStopped();
    results.push(await plan(unit));
  }
  return results;
}

// Binds every provider send issued by `work` to one durable capture request. Any
// failure, including one the provider adapter swallowed, stops the run.
export async function runCountCaptureRequest<T>(
  input: Readonly<{ binding: CountCaptureBinding; ledger: CountCaptureLedger }>,
  work: () => Promise<T>,
): Promise<T> {
  const outer = requests.getStore();
  if (outer) {
    outer.stopped = true;
    throw new CountCaptureStopped();
  }
  const request: CountCaptureRequest = { ...input, stopped: false, durablyStopped: false };
  return requests.run(request, async () => {
    try {
      const value = await work();
      if (!request.stopped) return value;
    } catch {
      /* Every failure inside a bound request stops the run below. */
    }
    await stop(request);
    throw new CountCaptureStopped();
  });
}

// A failed durable stop is retried by the next failure; the local stop already
// refuses every later send, and a possible-send debit is never released.
async function stop(request: CountCaptureRequest) {
  request.stopped = true;
  if (request.durablyStopped) return;
  try {
    await request.ledger.stop(request.binding);
    request.durablyStopped = true;
  } catch {
    /* The run stays locally stopped. */
  }
}

// Classifies the actual transport target. A caller-supplied category is accepted
// only when the provider, origin, method, path and query keys agree with it.
export function classifyCountCaptureSend(
  provider: string,
  category: string | undefined,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Omit<CountCaptureSend, "usage"> {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (
    provider !== "scrydex" ||
    url.origin !== "https://api.scrydex.com" ||
    url.username ||
    url.password ||
    url.hash ||
    method !== "GET"
  )
    throw new CountCaptureStopped();
  if (category === "usage") {
    if (url.pathname !== "/account/v1/usage" || url.search) throw new CountCaptureStopped();
    return { category: "usage", requestFingerprint: countFingerprint({ method, path: "account/v1/usage" }) };
  }
  if (category !== "card-force" || !url.pathname.startsWith("/onepiece/v1/")) throw new CountCaptureStopped();
  const path = url.pathname.slice("/onepiece/v1/".length);
  const query = Object.fromEntries(url.searchParams);
  const kind =
    path === "cards" && /^printings:[A-Za-z0-9_-]+$/.test(query.q ?? "")
      ? "cards"
      : /^expansions\/[A-Za-z0-9_-]+\/sealed$/.test(path)
        ? "sealed"
        : null;
  const keys = [...url.searchParams.keys()].sort().join();
  if (!kind || keys !== (kind === "cards" ? "page,page_size,q,select" : "page,page_size,select") || query.page !== "1")
    throw new CountCaptureStopped();
  return { category: kind, requestFingerprint: countFingerprint({ method, path, query }) };
}

// Returns a transport that durably debits each possible send before it leaves,
// or undefined when no capture request is bound so ordinary sends are untouched.
export function countCaptureTransport(
  provider: string,
  category: string | undefined,
  transport: typeof fetch,
): typeof fetch | undefined {
  const request = requests.getStore();
  if (!request) return undefined;
  return async (input, init) => {
    try {
      if (request.stopped) throw new CountCaptureStopped();
      const classified = classifyCountCaptureSend(provider, category, input, init);
      const usage = usages.getStore();
      const sequence = await request.ledger.debit(
        request.binding,
        classified.category === "usage" && usage ? { ...classified, usage } : classified,
      );
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new CountCaptureStopped();
      // A sibling send may have stopped the request while this debit committed; the debit stays.
      if (request.stopped) throw new CountCaptureStopped();
      // A followed redirect would be an undebited second send.
      const response = await transport(input, { ...init, redirect: "manual" });
      if (!response.ok || response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        throw new CountCaptureStopped();
      }
      await request.ledger.result(request.binding, sequence, response.status);
      return response;
    } catch {
      await stop(request);
      throw new CountCaptureStopped();
    }
  };
}
