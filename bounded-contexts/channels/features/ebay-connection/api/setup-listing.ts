import {
  parseLocationItem,
  parsePolicyItem,
  policyTypes,
  type PolicyType,
  type SetupItem,
} from "../domain/setup-material";
import { readEbayProviderJson } from "./provider";

export type SetupList =
  | Readonly<{ status: "complete"; items: readonly SetupItem[] }>
  | Readonly<{ status: "incomplete"; items: readonly [] }>;
export type SetupLists = Readonly<Record<PolicyType | "locations", SetupList>>;
export type SetupRead = (url: string, accessToken: string, signal: AbortSignal) => Promise<unknown>;
const origin = "https://api.sandbox.ebay.com";
export const readEbaySetupJson: SetupRead = async (url, accessToken, signal) => {
  const response = await fetch(url, {
    signal,
    redirect: "error",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
    },
  });
  return readEbayProviderJson(response, 1048576);
};
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error("incomplete");
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("incomplete");
  return value;
}
function locationUrl(value: unknown, offset: number, limit: number) {
  if (typeof value !== "string") throw new Error("incomplete");
  const url = new URL(value);
  if (
    url.origin !== origin ||
    url.pathname !== "/sell/inventory/v1/location" ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["offset", "limit"].includes(key)) ||
    url.searchParams.getAll("offset").length !== 1 ||
    url.searchParams.getAll("limit").length !== 1 ||
    url.searchParams.get("offset") !== String(offset) ||
    url.searchParams.get("limit") !== String(limit)
  )
    throw new Error("incomplete");
  return url.toString();
}

export async function readSetupLists(accessToken: string, read: SetupRead = readEbaySetupJson): Promise<SetupLists> {
  const signal = AbortSignal.timeout(20000);
  const incomplete = { status: "incomplete", items: [] } as const;
  async function policy(type: PolicyType): Promise<SetupList> {
    try {
      const key = `${type}Policies`;
      const page = record(
        await read(`${origin}/sell/account/v1/${type}_policy?marketplace_id=EBAY_US`, accessToken, signal),
        [key, "total"],
      );
      if (!Array.isArray(page[key]) || count(page.total) !== page[key].length) throw new Error();
      const items = page[key].map((item) => parsePolicyItem(type, item));
      if (new Set(items.map((item) => item[`${type}PolicyId`])).size !== items.length) throw new Error();
      return { status: "complete", items };
    } catch {
      return incomplete;
    }
  }
  async function locations(): Promise<SetupList> {
    try {
      const items: SetupItem[] = [];
      let url = `${origin}/sell/inventory/v1/location?offset=0&limit=100`;
      let total: number | undefined;
      for (let pages = 0; pages < 50; pages++) {
        const page = record(await read(url, accessToken, signal), [
          "locations",
          "total",
          "href",
          "limit",
          "offset",
          "next",
          "prev",
        ]);
        const offset = page.offset === undefined ? 0 : count(page.offset);
        const limit = count(page.limit);
        if (
          !Array.isArray(page.locations) ||
          limit < 1 ||
          limit > 100 ||
          offset !== items.length ||
          page.locations.length > limit
        )
          throw new Error();
        locationUrl(url, offset, limit);
        if (page.href !== undefined) locationUrl(page.href, offset, limit);
        if (page.prev !== undefined) locationUrl(page.prev, Math.max(0, offset - limit), limit);
        const observedTotal = count(page.total);
        if (total !== undefined && total !== observedTotal) throw new Error();
        total = observedTotal;
        items.push(...page.locations.map(parseLocationItem));
        if (items.length > total || new Set(items.map((item) => item.merchantLocationKey)).size !== items.length)
          throw new Error();
        if (page.next === undefined) {
          if (items.length !== total) throw new Error();
          return { status: "complete", items };
        }
        if (page.locations.length !== limit || items.length >= total) throw new Error();
        url = locationUrl(page.next, offset + limit, limit);
      }
      return incomplete;
    } catch {
      return incomplete;
    }
  }
  // Sequential reads keep provider load bounded and share a single deadline.
  const policies = {} as Record<PolicyType, SetupList>;
  for (const type of policyTypes) policies[type] = await policy(type);
  return { ...policies, locations: await locations() };
}
