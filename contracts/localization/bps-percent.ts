export type FormatBpsPercentOptions = Readonly<{
  locale?: string;
  /** Maximum fraction digits on the rendered percent value. Defaults to 2
   * (basis points resolve to hundredths of a percent, so 2 digits is lossless
   * for integer bps). Consumers formatting coarser statistical rates may
   * choose 1. */
  maximumFractionDigits?: number;
}>;

/**
 * Formats a basis-points integer (fields named `*_bps` / `*PercentageBps`
 * throughout the domain, for example `shipping_allowance_percentage_bps`) as
 * locale-aware percent display text (for example `450` -> "4.5%"). This is the
 * single canonical bps-percent display helper for `@chase-sets/localization`,
 * replacing the repeated local `formatAllowancePercentage` definitions (and one
 * raw `bps / 100` inline expression) across consumer UI.
 *
 * 10,000 bps is 100%; values above 10,000 (for example an offer priced above
 * its listing's ask) format as percentages above 100%, matching the historical
 * behavior of every consumer that duplicated this formatter.
 */
export function formatBpsPercent(bps: number, options: FormatBpsPercentOptions = {}): string {
  const formatted = new Intl.NumberFormat(options.locale, {
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(bps / 100);

  return `${formatted}%`;
}
