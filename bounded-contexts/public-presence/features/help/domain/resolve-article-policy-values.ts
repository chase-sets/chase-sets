import { formatBpsPercent, formatMoney } from "@chase-sets/localization";
import type { PublicPolicyValue, PublicPolicyValuesResponse } from "../api/public-policy-values";
import type { HelpArticle, HelpArticleInline } from "./article-model";

export function resolveArticlePolicyValues(
  article: HelpArticle,
  policyValues: PublicPolicyValuesResponse,
  options: Readonly<{
    now?: string;
    changeCalloutDays?: number;
    unavailableKeys?: readonly string[];
  }> = {},
): HelpArticle {
  const now = Date.parse(options.now ?? policyValues.resolvedAt);
  const windowMs = (options.changeCalloutDays ?? policyValues.changeCalloutDays) * 86_400_000;
  const unavailableKeys = new Set(options.unavailableKeys ?? []);
  const usedValues = article.policyValueKeys
    .filter((key) => !unavailableKeys.has(key))
    .map((key) => {
      const value = policyValues.values[key];
      if (!value) throw new Error(`Article '${article.href}' could not resolve public policy value '${key}'.`);
      return [key, value] as const;
    });
  const formatted = new Map(usedValues.map(([key, value]) => [key, formatPublicPolicyValue(value)]));
  const effectiveDates = new Set(
    usedValues.flatMap(([, value]) =>
      value.upcoming
        .filter(({ effectiveFrom }) => {
          const effectiveAt = Date.parse(effectiveFrom);
          return effectiveAt > now && effectiveAt - now <= windowMs;
        })
        .map(({ effectiveFrom }) => effectiveFrom),
    ),
  );

  return {
    ...article,
    blocks: article.blocks.map((block) =>
      block.type === "list"
        ? {
            ...block,
            items: block.items.map((item) => resolveInline(item, formatted, unavailableKeys, article.href)),
          }
        : { ...block, content: resolveInline(block.content, formatted, unavailableKeys, article.href) },
    ),
    policyChanges: [...effectiveDates].sort().map((effectiveFrom) => ({
      effectiveFrom,
      description: "The published policy values on this page will update automatically on this date.",
    })),
  };
}

function resolveInline(
  content: readonly HelpArticleInline[],
  formatted: ReadonlyMap<string, string>,
  unavailableKeys: ReadonlySet<string>,
  href: string,
): readonly HelpArticleInline[] {
  return content.map((inline) => {
    if (inline.type !== "policy-value") return inline;
    if (unavailableKeys.has(inline.key)) {
      return { type: "policy-value-unavailable", key: inline.key };
    }
    const value = formatted.get(inline.key);
    if (value === undefined)
      throw new Error(`Article '${href}' could not resolve public policy value '${inline.key}'.`);
    return { type: "text", value };
  });
}

function formatPublicPolicyValue(value: PublicPolicyValue) {
  if (value.type === "bps") return formatBpsPercent(Number(value.value));
  if (value.type === "money") return formatMoney(String(value.value), value.currency ?? "USD");
  if (value.type === "days") return `${value.value} ${Number(value.value) === 1 ? "day" : "days"}`;
  if (value.type === "hours") return `${value.value} ${Number(value.value) === 1 ? "hour" : "hours"}`;
  if (value.type === "minutes") {
    const minutes = Number(value.value) / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return String(value.value);
}
