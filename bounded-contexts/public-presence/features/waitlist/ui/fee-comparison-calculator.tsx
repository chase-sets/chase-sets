import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Grid,
  Inline,
  LinkButton,
  PageSection,
  Stack,
  Surface,
  Table,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { formatBpsPercent, formatMoney } from "@chase-sets/localization";
import {
  centsToMoneyAmount,
  centsToSignedMoneyAmount,
  moneyToCents,
  roundRational,
  tryMoneyToCents,
} from "@chase-sets/primitives/money";
import { trackWaitlistEvent } from "./analytics";
import { publicPresenceT as t } from "./public-presence-translator";

/**
 * The Chase Sets side of the comparison is truth-gated: every number renders
 * from this schedule, which the home loader reads through the whitelisted
 * public policy read — never from hardcoded constants. When the read is
 * unavailable the calculator hides instead of showing stale or invented
 * numbers.
 */
export type PublicMarketplaceFeeSchedule = Readonly<{
  /** Marketplace sales fee percentage in basis points (live policy value). */
  percentageBps: number;
  /** Fixed per-item fee as a canonical money amount, e.g. "0.00". */
  fixedAmount: string;
  /** Per-item fee cap as a canonical money amount, e.g. "25.00". */
  capAmount: string;
  /** When the current schedule took effect, if published. */
  effectiveFrom: string | null;
}>;

type PublicPolicyValuesLike = Readonly<{
  values: Readonly<
    Record<string, Readonly<{ type: string; value: string | number; effectiveFrom: string | null }> | undefined>
  >;
}>;

const STANDARD_BPS_KEY = "marketplace-sales-fee.standard.bps";
const STANDARD_FIXED_KEY = "marketplace-sales-fee.standard.fixed";
const STANDARD_CAP_KEY = "marketplace-sales-fee.standard.cap";

/** Narrow the whitelisted public policy read to the calculator's schedule. */
export function toPublicMarketplaceFeeSchedule(policyValues: PublicPolicyValuesLike): PublicMarketplaceFeeSchedule {
  const bps = policyValues.values[STANDARD_BPS_KEY];
  const fixed = policyValues.values[STANDARD_FIXED_KEY];
  const cap = policyValues.values[STANDARD_CAP_KEY];
  if (!bps || !fixed || !cap) {
    throw new Error("The public marketplace sales fee schedule values are unavailable.");
  }
  const percentageBps = Number(bps.value);
  if (!Number.isInteger(percentageBps) || percentageBps < 0 || percentageBps > 10_000) {
    throw new Error("The public marketplace sales fee percentage is not a valid basis-point value.");
  }
  return {
    percentageBps,
    fixedAmount: centsToMoneyAmount(moneyToCents(String(fixed.value))),
    capAmount: centsToMoneyAmount(moneyToCents(String(cap.value))),
    effectiveFrom: bps.effectiveFrom,
  };
}

// Competitor fee schedules: publicly documented rates only, retrieved
// 2026-07-12. Where their published math is ambiguous at cent granularity,
// every rounding decision goes in the competitor's favor (their fee rounds
// DOWN, so the amount we show them keeping is never understated), and the
// comparison excludes shipping, tax, store subscriptions, and promotions —
// all of which would typically INCREASE what these marketplaces charge
// (both apply their percentage fees to totals that include shipping and,
// for TCGplayer processing, sales tax).
//
// TCGplayer (https://help.tcgplayer.com/hc/en-us/articles/201357836-TCGplayer-Fees,
// https://seller.tcgplayer.com/blog/important-changes-to-tcgplayer-direct-minimum-pricing-and-marketplace-fees):
// - 10.75% marketplace commission for standard (Level 1-4) marketplace
//   sellers, effective 2026-02-10, capped at $75 per item.
// - Payment processing: 2.5% + $0.30 per order.
const TCGPLAYER_COMMISSION_BPS = 1075n;
const TCGPLAYER_COMMISSION_CAP_CENTS = 7_500n;
const TCGPLAYER_PROCESSING_BPS = 250n;
const TCGPLAYER_PER_ORDER_FEE_CENTS = 30n;
//
// eBay (https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822):
// - Trading Cards final value fee for sellers without a store: 13.25% on the
//   portion of the sale up to $7,500, then 2.35% on the portion above $7,500.
//   The final value fee includes eBay's payment processing.
// - Per-order fee: $0.30 for orders of $10 or less, $0.40 for orders over $10.
const EBAY_TRADING_CARDS_FVF_BPS = 1325n;
const EBAY_FVF_TIER_THRESHOLD_CENTS = 750_000n;
const EBAY_FVF_ABOVE_TIER_BPS = 235n;
const EBAY_SMALL_ORDER_THRESHOLD_CENTS = 1_000n;
const EBAY_SMALL_ORDER_FEE_CENTS = 30n;
const EBAY_STANDARD_ORDER_FEE_CENTS = 40n;

export const FEE_CALCULATOR_MIN_PRICE_CENTS = 1n;
export const FEE_CALCULATOR_MAX_PRICE_CENTS = 999_999n;
export const FEE_CALCULATOR_MAX_CARD_COUNT = 100;

/** When the competitor fee schedules above were retrieved from each marketplace's published documentation. */
export const COMPETITOR_FEES_AS_OF = "July 12, 2026";

/**
 * Preformatted competitor fee facts for comparison copy (the /compare pages'
 * tables and FAQ answers). Derived from the exact constants the calculator
 * computes with, so cited numbers can never drift from the formulas.
 */
export const tcgplayerFeeFacts = {
  commissionRate: formatBpsPercent(Number(TCGPLAYER_COMMISSION_BPS)),
  commissionCap: formatMoney(centsToMoneyAmount(TCGPLAYER_COMMISSION_CAP_CENTS), "USD"),
  processingRate: formatBpsPercent(Number(TCGPLAYER_PROCESSING_BPS)),
  processingFixed: formatMoney(centsToMoneyAmount(TCGPLAYER_PER_ORDER_FEE_CENTS), "USD"),
  asOf: COMPETITOR_FEES_AS_OF,
} as const;

export const ebayFeeFacts = {
  finalValueFeeRate: formatBpsPercent(Number(EBAY_TRADING_CARDS_FVF_BPS)),
  tierThreshold: formatMoney(centsToMoneyAmount(EBAY_FVF_TIER_THRESHOLD_CENTS), "USD"),
  aboveTierRate: formatBpsPercent(Number(EBAY_FVF_ABOVE_TIER_BPS)),
  smallOrderThreshold: formatMoney(centsToMoneyAmount(EBAY_SMALL_ORDER_THRESHOLD_CENTS), "USD"),
  smallOrderFee: formatMoney(centsToMoneyAmount(EBAY_SMALL_ORDER_FEE_CENTS), "USD"),
  standardOrderFee: formatMoney(centsToMoneyAmount(EBAY_STANDARD_ORDER_FEE_CENTS), "USD"),
  asOf: COMPETITOR_FEES_AS_OF,
} as const;

/** The evergreen comparison pages the calculator links out to. */
export type FeeComparisonCompetitor = "tcgplayer" | "ebay";

const compareLinkLabelKeys = {
  tcgplayer: "publicPresence.compare.link.tcgplayer",
  ebay: "publicPresence.compare.link.ebay",
} as const satisfies Record<FeeComparisonCompetitor, string>;

export type MarketplaceFeeOutcome = Readonly<{
  /** The marketplace's own selling fee (commission / final value fee) in cents. */
  marketplaceFeeCents: bigint;
  /** Seller-paid payment processing and per-order fees in cents. */
  processingFeeCents: bigint;
  /** Order total minus all seller-side fees; negative when fees exceed the sale. */
  keptCents: bigint;
  /** True when a per-item fee cap reduced the marketplace fee. */
  capApplied: boolean;
}>;

/** Basis points applied with floor rounding — used ONLY for competitor fees, in their favor. */
function floorBps(amountCents: bigint, bps: bigint): bigint {
  return (amountCents * bps) / 10_000n;
}

/**
 * Mirrors commercial-terms `quoteMarketplaceSalesFee` exactly: the percentage
 * component rounds up (ceil) like the real quote, plus the fixed amount, then
 * the per-item cap. Chase Sets is intentionally NOT given the favorable
 * rounding competitors get.
 */
export function computeChaseSetsOutcome(
  itemPriceCents: bigint,
  itemCount: bigint,
  schedule: PublicMarketplaceFeeSchedule,
): MarketplaceFeeOutcome {
  const capCents = moneyToCents(schedule.capAmount);
  const uncappedPerItemCents =
    roundRational(itemPriceCents * BigInt(schedule.percentageBps), 10_000n, "ceil") +
    moneyToCents(schedule.fixedAmount);
  const perItemCents = uncappedPerItemCents < capCents ? uncappedPerItemCents : capCents;
  const marketplaceFeeCents = perItemCents * itemCount;
  return {
    marketplaceFeeCents,
    // Payment processing is buyer-side at checkout on Chase Sets; sellers
    // never pay a separate processing line (shipped /sales-fees promise).
    processingFeeCents: 0n,
    keptCents: itemPriceCents * itemCount - marketplaceFeeCents,
    capApplied: uncappedPerItemCents > capCents,
  };
}

export function computeTcgplayerOutcome(itemPriceCents: bigint, itemCount: bigint): MarketplaceFeeOutcome {
  const orderTotalCents = itemPriceCents * itemCount;
  const uncappedCommissionPerItemCents = floorBps(itemPriceCents, TCGPLAYER_COMMISSION_BPS);
  const commissionPerItemCents =
    uncappedCommissionPerItemCents < TCGPLAYER_COMMISSION_CAP_CENTS
      ? uncappedCommissionPerItemCents
      : TCGPLAYER_COMMISSION_CAP_CENTS;
  const marketplaceFeeCents = commissionPerItemCents * itemCount;
  const processingFeeCents = floorBps(orderTotalCents, TCGPLAYER_PROCESSING_BPS) + TCGPLAYER_PER_ORDER_FEE_CENTS;
  return {
    marketplaceFeeCents,
    processingFeeCents,
    keptCents: orderTotalCents - marketplaceFeeCents - processingFeeCents,
    capApplied: uncappedCommissionPerItemCents > TCGPLAYER_COMMISSION_CAP_CENTS,
  };
}

export function computeEbayOutcome(itemPriceCents: bigint, itemCount: bigint): MarketplaceFeeOutcome {
  const orderTotalCents = itemPriceCents * itemCount;
  const tieredCents =
    orderTotalCents > EBAY_FVF_TIER_THRESHOLD_CENTS ? orderTotalCents - EBAY_FVF_TIER_THRESHOLD_CENTS : 0n;
  const baseCents = orderTotalCents - tieredCents;
  const marketplaceFeeCents =
    floorBps(baseCents, EBAY_TRADING_CARDS_FVF_BPS) + floorBps(tieredCents, EBAY_FVF_ABOVE_TIER_BPS);
  const processingFeeCents =
    orderTotalCents > EBAY_SMALL_ORDER_THRESHOLD_CENTS ? EBAY_STANDARD_ORDER_FEE_CENTS : EBAY_SMALL_ORDER_FEE_CENTS;
  return {
    marketplaceFeeCents,
    processingFeeCents,
    keptCents: orderTotalCents - marketplaceFeeCents - processingFeeCents,
    capApplied: false,
  };
}

export function parseCalculatorPrice(input: string): bigint | null {
  const cents = tryMoneyToCents(input.trim().replace(/^\$/, "").replace(/,/g, ""));
  if (cents === null || cents < FEE_CALCULATOR_MIN_PRICE_CENTS || cents > FEE_CALCULATOR_MAX_PRICE_CENTS) {
    return null;
  }
  return cents;
}

export function parseCalculatorCardCount(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const count = Number(trimmed);
  if (count < 1 || count > FEE_CALCULATOR_MAX_CARD_COUNT) {
    return null;
  }
  return count;
}

function money(cents: bigint): string {
  return formatMoney(centsToSignedMoneyAmount(cents), "USD");
}

function buildShareLink(priceCents: bigint, cardCount: number): string {
  const origin = typeof window === "undefined" ? "https://chasesets.com" : window.location.origin;
  const url = new URL("/", origin);
  url.searchParams.set("price", centsToMoneyAmount(priceCents));
  url.searchParams.set("cards", String(cardCount));
  url.searchParams.set("utm_source", "fee-calculator");
  url.searchParams.set("utm_medium", "share");
  url.searchParams.set("utm_campaign", "what-you-keep");
  url.hash = "fee-calculator";
  return url.toString();
}

/**
 * The interactive "what you actually keep" comparison: a seller
 * enters a sale price (and optionally a card count, which is what makes the
 * per-item cap visible), and sees the seller-side fees and kept amount on
 * Chase Sets, TCGplayer, and eBay. Renders nothing without a live schedule.
 */
export function FeeCalculatorSection({
  schedule,
  compareLinks = ["tcgplayer", "ebay"],
}: {
  schedule?: PublicMarketplaceFeeSchedule | null;
  /** Which /compare pages to link; a compare page passes only the other competitor. */
  compareLinks?: readonly FeeComparisonCompetitor[];
}) {
  if (!schedule) {
    return null;
  }
  return <FeeCalculatorWorkbench schedule={schedule} compareLinks={compareLinks} />;
}

function FeeCalculatorWorkbench({
  schedule,
  compareLinks,
}: {
  schedule: PublicMarketplaceFeeSchedule;
  compareLinks: readonly FeeComparisonCompetitor[];
}) {
  const [priceInput, setPriceInput] = useState("50.00");
  const [cardCountInput, setCardCountInput] = useState("1");
  const [copied, setCopied] = useState(false);

  // Share links carry ?price= and ?cards= so a pasted link reopens the exact
  // comparison being argued about. Prefill happens after mount, so server and
  // first client render agree on the defaults.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const sharedPrice = params.get("price");
    const sharedCards = params.get("cards");
    if (sharedPrice !== null && parseCalculatorPrice(sharedPrice) !== null) {
      setPriceInput(sharedPrice);
    }
    if (sharedCards !== null && parseCalculatorCardCount(sharedCards) !== null) {
      setCardCountInput(sharedCards);
    }
  }, []);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const priceCents = parseCalculatorPrice(priceInput);
  const cardCount = parseCalculatorCardCount(cardCountInput);
  const rate = formatBpsPercent(schedule.percentageBps);
  const cap = formatMoney(schedule.capAmount, "USD");

  const outcomes =
    priceCents !== null && cardCount !== null
      ? {
          chaseSets: computeChaseSetsOutcome(priceCents, BigInt(cardCount), schedule),
          tcgplayer: computeTcgplayerOutcome(priceCents, BigInt(cardCount)),
          ebay: computeEbayOutcome(priceCents, BigInt(cardCount)),
        }
      : null;
  const orderTotal = priceCents !== null && cardCount !== null ? money(priceCents * BigInt(cardCount)) : null;

  function copyShareLink() {
    if (priceCents === null || cardCount === null) {
      return;
    }
    const link = buildShareLink(priceCents, cardCount);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(link).catch(() => undefined);
    }
    setCopied(true);
    trackWaitlistEvent("cta_clicked", { section: "fee_calculator", target: "copy_share_link" });
  }

  return (
    <PageSection
      id="fee-calculator"
      data-public-presence-section="fee_calculator"
      title={t("publicPresence.home.feeCalculator.title")}
      description={t("publicPresence.home.feeCalculator.description", { rate, cap })}
    >
      <Stack gap={4}>
        <Grid columns={{ base: 1, sm: 2 }} gap={3}>
          <TextInput
            label={t("publicPresence.home.feeCalculator.price.label")}
            name="fee-calculator-price"
            inputMode="decimal"
            autoComplete="off"
            value={priceInput}
            error={priceCents === null ? t("publicPresence.home.feeCalculator.price.error") : undefined}
            onChange={(event) => setPriceInput(event.target.value)}
          />
          <TextInput
            label={t("publicPresence.home.feeCalculator.cards.label")}
            name="fee-calculator-cards"
            type="number"
            min={1}
            max={FEE_CALCULATOR_MAX_CARD_COUNT}
            step={1}
            inputMode="numeric"
            autoComplete="off"
            value={cardCountInput}
            error={cardCount === null ? t("publicPresence.home.feeCalculator.cards.error") : undefined}
            onChange={(event) => setCardCountInput(event.target.value)}
          />
        </Grid>
        {outcomes && orderTotal ? (
          <Stack gap={3}>
            {cardCount !== null && cardCount > 1 && priceCents !== null ? (
              <Text size="sm" tone="secondary">
                {t("publicPresence.home.feeCalculator.perCardNote", {
                  count: cardCount,
                  price: money(priceCents),
                  total: orderTotal,
                })}
              </Text>
            ) : null}
            <Table
              caption={t("publicPresence.home.feeCalculator.caption", { total: orderTotal })}
              columns={[
                t("publicPresence.home.feeCalculator.column.metric", { total: orderTotal }),
                t("publicPresence.home.feeCalculator.column.chaseSets"),
                t("publicPresence.home.feeCalculator.column.tcgplayer"),
                t("publicPresence.home.feeCalculator.column.ebay"),
              ]}
              rows={[
                [
                  t("publicPresence.home.feeCalculator.row.marketplaceFee"),
                  money(outcomes.chaseSets.marketplaceFeeCents),
                  money(outcomes.tcgplayer.marketplaceFeeCents),
                  money(outcomes.ebay.marketplaceFeeCents),
                ],
                [
                  t("publicPresence.home.feeCalculator.row.processing"),
                  t("publicPresence.home.feeCalculator.row.processing.chaseSets"),
                  money(outcomes.tcgplayer.processingFeeCents),
                  money(outcomes.ebay.processingFeeCents),
                ],
                [
                  t("publicPresence.home.feeCalculator.row.youKeep"),
                  <Badge tone="success" variant="solid">
                    {money(outcomes.chaseSets.keptCents)}
                  </Badge>,
                  money(outcomes.tcgplayer.keptCents),
                  money(outcomes.ebay.keptCents),
                ],
              ]}
            />
            {outcomes.chaseSets.capApplied && priceCents !== null ? (
              <Text size="sm" tone="secondary" data-testid="fee-calculator-cap-note">
                {t("publicPresence.home.feeCalculator.capNote", {
                  rate,
                  uncapped: money(
                    roundRational(priceCents * BigInt(schedule.percentageBps), 10_000n, "ceil") +
                      moneyToCents(schedule.fixedAmount),
                  ),
                  cap,
                })}
              </Text>
            ) : null}
            <Inline gap={2} align="center">
              <Button tone="secondary" size="sm" onClick={copyShareLink}>
                {t("publicPresence.home.feeCalculator.share.action")}
              </Button>
              {copied ? (
                <Text size="sm" tone="secondary" role="status">
                  {t("publicPresence.home.feeCalculator.share.copied")}
                </Text>
              ) : null}
            </Inline>
          </Stack>
        ) : null}
        <Surface tone="subtle">
          <Stack gap={2}>
            <Inline gap={2} align="center">
              <Badge tone="trust">{t("publicPresence.home.feeCalculator.founders.badge")}</Badge>
              <LinkButton href="/founders" tone="secondary" size="sm">
                {t("publicPresence.home.feeCalculator.founders.action")}
              </LinkButton>
            </Inline>
            <Text size="sm" tone="secondary">
              {t("publicPresence.home.feeCalculator.founders.text")}
            </Text>
          </Stack>
        </Surface>
        <Text size="sm" tone="tertiary">
          {t("publicPresence.home.feeCalculator.sourceNote")}
        </Text>
        {compareLinks.length > 0 ? (
          <Inline gap={2}>
            {compareLinks.map((competitor) => (
              <LinkButton
                key={competitor}
                href={`/compare/${competitor}`}
                tone="secondary"
                size="sm"
                onClick={() =>
                  trackWaitlistEvent("cta_clicked", { section: "fee_calculator", target: `compare_${competitor}` })
                }
              >
                {t(compareLinkLabelKeys[competitor])}
              </LinkButton>
            ))}
          </Inline>
        ) : null}
      </Stack>
    </PageSection>
  );
}
