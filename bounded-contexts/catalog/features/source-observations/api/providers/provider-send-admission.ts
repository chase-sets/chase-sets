import { AsyncLocalStorage } from "node:async_hooks";

export const providerSendPolicy = Object.freeze({
  preflightCard: 32,
  preflightUsage: 768,
  preflightOtherScrydex: 136,
  nonScrydex: 20_000,
  payloadMember: 256,
  additionalScrydex: 3_464,
  passes: 9,
  totalSends: 246_000,
  totalScrydex: 46_000,
});

export const providerSendProviders = [
  "scrydex",
  "tcgplayer",
  "tcgdex",
  "scryfall",
  "ygoprodeck",
  "ygojson",
  "lorcanajson",
  "lorcast",
  "mtgjson",
  "catalog-mirror",
] as const;
export type ProviderSendProvider = (typeof providerSendProviders)[number];
export const providerSendCategories = [
  "card-force",
  "usage",
  "discovery",
  "planning",
  "payload",
  "asset",
  "mirror",
  "baseline",
] as const;
export type ProviderSendCategory = (typeof providerSendCategories)[number];
export type ProviderSendBinding = Readonly<{ windowId: string; phase: "preflight" | "pass"; pass: number }>;
export type ProviderSendRequest = Readonly<{
  provider: ProviderSendProvider;
  category: ProviderSendCategory | "unknown";
  binding?: ProviderSendBinding | null;
  unitKey?: string;
  language?: string;
  coordinate?: string;
  tariff?: "general-one-credit" | "non-scrydex";
}>;
export type ProviderSendRefusal =
  | "authority-unavailable"
  | "unknown-request"
  | "stale-binding"
  | "quota-exhausted"
  | "terminal"
  | "redirect-refused";
const providerSendRefusals: readonly ProviderSendRefusal[] = [
  "authority-unavailable",
  "unknown-request",
  "stale-binding",
  "quota-exhausted",
  "terminal",
  "redirect-refused",
];

export class ProviderSendStoppedError extends Error {
  public readonly code: ProviderSendRefusal;

  constructor(code: ProviderSendRefusal) {
    super(`Catalog provider-send window stopped (${code}).`);
    this.name = "ProviderSendStoppedError";
    this.code = code;
  }
}

export type ProviderSendDebit =
  | Readonly<{ state: "unarmed" }>
  | Readonly<{ state: "admitted"; windowId: string; sequence: number }>
  | Readonly<{ state: "refused"; code: ProviderSendRefusal }>;
export type ProviderSendLedger = Readonly<{
  debit(request: ProviderSendRequest): Promise<ProviderSendDebit>;
  settle(windowId: string, sequence: number): Promise<void>;
  stop(windowId: string, code: ProviderSendRefusal): Promise<void>;
  bind(): Promise<ProviderSendBinding | null>;
  maximum?(request: ProviderSendRequest): Promise<number | null>;
}>;

export function createProviderSendAdmission(options: Readonly<{ enabled: boolean; ledger: ProviderSendLedger }>) {
  return {
    enabled: options.enabled,
    refuse: async (binding: ProviderSendBinding | null, code: ProviderSendRefusal) => {
      if (!options.enabled || !binding) return;
      try {
        await options.ledger.stop(binding.windowId, code);
      } catch {
        throw new ProviderSendStoppedError("authority-unavailable");
      }
    },
    maximum: async (request: ProviderSendRequest) => {
      if (!options.enabled) return null;
      try {
        return (await options.ledger.maximum?.(request)) ?? null;
      } catch {
        throw new ProviderSendStoppedError("authority-unavailable");
      }
    },
    bind: async () => {
      if (!options.enabled) return null;
      try {
        return await options.ledger.bind();
      } catch {
        throw new ProviderSendStoppedError("authority-unavailable");
      }
    },
    async send(
      request: ProviderSendRequest,
      transport: typeof fetch,
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ): Promise<Response> {
      if (!options.enabled) return transport(input, init);
      let debit: ProviderSendDebit;
      try {
        debit = await options.ledger.debit(request);
      } catch {
        throw new ProviderSendStoppedError("authority-unavailable");
      }
      if (debit?.state === "unarmed") return transport(input, init);
      if (debit?.state === "refused")
        throw new ProviderSendStoppedError(
          providerSendRefusals.includes(debit.code) ? debit.code : "authority-unavailable",
        );
      if (
        debit?.state !== "admitted" ||
        typeof debit.windowId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(debit.windowId) ||
        !Number.isSafeInteger(debit.sequence) ||
        debit.sequence < 1 ||
        debit.sequence > providerSendPolicy.totalSends
      )
        throw new ProviderSendStoppedError("authority-unavailable");
      // Redirects cannot hide an uncharged application request. No redirect is followed.
      const response = await transport(input, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        try {
          await options.ledger.stop(debit.windowId, "redirect-refused");
        } catch {
          throw new ProviderSendStoppedError("authority-unavailable");
        }
        throw new ProviderSendStoppedError("redirect-refused");
      }
      try {
        await options.ledger.settle(debit.windowId, debit.sequence);
      } catch {
        throw new ProviderSendStoppedError("authority-unavailable");
      }
      return response;
    },
  };
}

export type ProviderSendAdmission = ReturnType<typeof createProviderSendAdmission>;
type ProviderSendContext = Readonly<{
  admission: ProviderSendAdmission;
  binding: ProviderSendBinding | null;
  request?: Omit<ProviderSendRequest, "binding">;
}>;
const providerSendContext = new AsyncLocalStorage<ProviderSendContext>();

export async function runCatalogProviderWork<T>(
  admission: ProviderSendAdmission,
  work: () => Promise<T>,
  binding?: ProviderSendBinding | null,
): Promise<T> {
  const existing = providerSendContext.getStore();
  if (existing && binding === undefined) return work();
  const captured = binding === undefined ? await admission.bind() : binding;
  return providerSendContext.run({ admission, binding: captured }, async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProviderSendStoppedError) await admission.refuse(captured, error.code);
      throw error;
    }
  });
}

export function currentProviderSendBinding(): ProviderSendBinding | null {
  return providerSendContext.getStore()?.binding ?? null;
}

export function currentProviderSendAdmission(): ProviderSendAdmission | undefined {
  return providerSendContext.getStore()?.admission;
}

export function runProviderSendRequest<T>(request: Omit<ProviderSendRequest, "binding">, work: () => T): T {
  const context = providerSendContext.getStore();
  return context ? providerSendContext.run({ ...context, request }, work) : work();
}

export function sendCatalogProviderRequest(
  provider: ProviderSendProvider,
  transport: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  category?: ProviderSendCategory,
  fallbackCategory?: ProviderSendCategory,
): Promise<Response> {
  const context = providerSendContext.getStore();
  if (!context) {
    if (process.env.CATALOG_PROVIDER_SEND_WINDOW_ENABLED === "true") {
      throw new ProviderSendStoppedError("authority-unavailable");
    }
    return transport(input, init);
  }
  const request = context.request;
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const generalScrydexPath =
    /^\/(?:account\/v1\/usage|(?:lorcana|onepiece)\/v1\/(?:cards|sealed|expansions)(?:\/[^/]+)?(?:\/(?:cards|sealed))?)$/.test(
      url.pathname,
    );
  return context.admission.send(
    {
      ...request,
      provider,
      category: category ?? request?.category ?? fallbackCategory ?? "unknown",
      binding: context.binding,
      tariff: provider !== "scrydex" ? "non-scrydex" : generalScrydexPath ? "general-one-credit" : undefined,
    },
    transport,
    input,
    init,
  );
}
