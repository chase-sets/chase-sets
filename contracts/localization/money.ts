import { centsToSignedMoneyAmount, trySignedMoneyToCents } from "@chase-sets/primitives/money";

export type FormatMoneyOptions = Readonly<{
  locale?: string;
}>;

type CurrencyDisplayChrome = Readonly<{
  prefix: string;
  suffix: string;
  decimalSeparator: string;
  groupSeparator: string;
}>;

const currencyDisplayChromeCache = new Map<string, CurrencyDisplayChrome>();

// Derives the locale's currency symbol placement and separator characters from a
// fixed probe value (never the real amount), so the actual money magnitude is
// assembled from the canonical decimal-string cents representation below and
// never round-trips through a floating-point number.
function currencyDisplayChrome(currencyCode: string, locale: string | undefined): CurrencyDisplayChrome {
  const cacheKey = `${locale ?? ""}:${currencyCode}`;
  const cached = currencyDisplayChromeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const parts = new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode }).formatToParts(1234.5);

  let prefix = "";
  let suffix = "";
  let decimalSeparator = ".";
  let groupSeparator = ",";
  let sawDigit = false;

  for (const part of parts) {
    if (part.type === "integer" || part.type === "group") {
      sawDigit = true;
      if (part.type === "group") {
        groupSeparator = part.value;
      }
      continue;
    }
    if (part.type === "decimal") {
      sawDigit = true;
      decimalSeparator = part.value;
      continue;
    }
    if (part.type === "fraction") {
      sawDigit = true;
      continue;
    }
    if (sawDigit) {
      suffix += part.value;
    } else {
      prefix += part.value;
    }
  }

  const chrome: CurrencyDisplayChrome = { prefix, suffix, decimalSeparator, groupSeparator };
  currencyDisplayChromeCache.set(cacheKey, chrome);
  return chrome;
}

function groupWholeDigits(wholeDigits: string, groupSeparator: string): string {
  return wholeDigits.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
}

/**
 * Formats a canonical decimal money amount string (for example "145.00") as
 * locale-aware currency display text (for example "$145.00"). This is the
 * single display companion to the `@chase-sets/primitives/money` amount type:
 * it consumes the same decimal-string representation and never widens the
 * amount through a floating-point number, so arbitrarily large balances format
 * without precision loss.
 *
 * Falls back to `"<amount> <CURRENCY>"` for amounts that are not valid signed
 * money decimals (for example placeholder or malformed values), matching the
 * historical degraded-display behavior across consumer UI.
 */
export function formatMoney(amount: string, currencyCode: string, options: FormatMoneyOptions = {}): string {
  const code = currencyCode.trim().toUpperCase();
  const cents = trySignedMoneyToCents(amount);

  if (cents === null) {
    return `${amount} ${code}`.trim();
  }

  const canonical = centsToSignedMoneyAmount(cents);
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [wholeDigits, fractionDigits] = unsigned.split(".");
  const { prefix, suffix, decimalSeparator, groupSeparator } = currencyDisplayChrome(code, options.locale);
  const groupedWhole = groupWholeDigits(wholeDigits, groupSeparator);

  return `${negative ? "-" : ""}${prefix}${groupedWhole}${decimalSeparator}${fractionDigits}${suffix}`;
}
