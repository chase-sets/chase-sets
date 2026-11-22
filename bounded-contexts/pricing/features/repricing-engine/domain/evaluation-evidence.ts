import { assertConfigurationGrantVector } from "@chase-sets/event-core/configuration-epoch";
import { moneyToCents } from "@chase-sets/primitives/money";
import { z } from "zod";
import { assertEconomicsFacts, requireRfc3339Instant } from "../../economics/domain/contracts";
import type { EconomicsResolution } from "../../economics/domain/resolution";
import {
  parseRepricingHaltState,
  parseRepricingPolicyState,
} from "../../repricing-policies/domain/configuration-state";
import { evaluationBindingSchema, evaluationDigest, exactUtc, readCompetitorCapture } from "./evaluation-authority";
import { repricingEnginePolicy } from "./policy";

const id = z.string().min(1);
const version = z.number().int().positive();
const cents = z.string().regex(/^\d+(\.\d{1,2})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const size = z.number().int().nonnegative();
const amount = { amount: cents, currencyCode: currency };
const timestamp = exactUtc;
const policy = z.strictObject({ state: z.unknown().transform(parseRepricingPolicyState), version });
const halt = z.strictObject({ state: z.unknown().transform(parseRepricingHaltState), version: size });
const marketSources = z.strictObject({
  estimate: z.strictObject({ version, estimatedAt: timestamp }).nullable(),
  sale: z.strictObject({ orderId: id, lineId: id, updatedAt: timestamp }).nullable(),
});
const supply = z.enum(["observed", "truncated", "unavailable", "disabled"]);
const finiteNonNegative = z.number().nonnegative();
const curvePoint = z.strictObject({
  percentile: size.max(100),
  priceAmount: cents,
  buyerArrivalIntervalDays: finiteNonNegative.nullable(),
  competingSellerCount: size.nullable(),
  storeWinShare: finiteNonNegative.max(1).nullable(),
  medianSellDays: finiteNonNegative.nullable(),
  qualifyingSaleCount: size,
  historyCapped: z.boolean(),
  hopeless: z.boolean(),
  supplyStatus: supply,
  salesCoverage: id,
});
const curve = z.strictObject({
  catalogItemId: id,
  productId: id,
  version,
  providerCondition: id,
  providerVariant: id,
  providerLanguage: id,
  fingerprint: id,
  modelVersion: id,
  policyRevisionId: id,
  ladderMethod: id,
  anchorCondition: id.nullable(),
  exposureStartReason: id,
  salesCoverage: id,
  supplyStatus: supply,
  ownSellerExclusionApplied: z.boolean().nullable(),
  builtAt: timestamp,
  currencyCode: currency.nullable(),
  freshUntil: timestamp.nullable(),
  points: z.array(curvePoint),
});
const platformValue = z.custom<Parameters<typeof repricingEnginePolicy.decodeValue>[0]>();
const platformDocument = z.strictObject({
  documentId: id,
  version,
  from: timestamp,
  until: timestamp.nullable(),
  status: z.literal("active"),
  value: platformValue,
});
const evidenceInputs = z.strictObject({
  standing: z.strictObject({ policies: z.array(policy), halt }),
  assignment: policy,
  platform: z.strictObject({ selected: platformDocument.nullable(), value: platformValue, bounds: z.array(timestamp) }),
  freeze: z
    .strictObject({
      next_eligible_at: timestamp,
      same_direction_rounds: size,
      last_direction: z.enum(["up", "down"]).nullable(),
      frozen_until: timestamp.nullable(),
      updated_at: timestamp,
    })
    .nullable(),
  catalogVersion: version,
  inventoryOrigin: id,
  inventoryVersion: version,
  stock: z.strictObject({
    itemId: id,
    accountId: id,
    totalQuantity: size,
    heldQuantity: size,
    availableQuantity: version,
  }),
  allocationRevision: version,
  marketSources,
  estimate: z.strictObject({ ...amount, freshUntil: timestamp }).nullable(),
  sale: z.strictObject({ ...amount, currencyCode: currency.nullable(), soldAt: timestamp }).nullable(),
  curve: curve.nullable(),
  economics: z.custom<EconomicsResolution>((value) => validateEconomics(value)).nullable(),
});
const listing = z
  .strictObject({
    listingId: id,
    sellerAccountId: id,
    inventoryItemId: id,
    catalogItemId: id,
    productId: id,
    priceAmount: cents,
    priceCurrencyCode: currency,
    quantityCap: version,
    listingVersion: version,
    listingStatus: z.literal("active"),
    pauseReason: z.null(),
    categoryIds: z.array(id),
    grading: z.enum(["graded", "raw"]),
    createdAt: timestamp,
    costBasisAmount: cents.nullable(),
    costBasisCurrencyCode: currency.nullable(),
    policyId: id,
    policyRevision: timestamp,
    rules: z.array(z.unknown()),
    maxChangesPerDay: version,
    economics: z.unknown(),
  })
  .refine((value) => Object.hasOwn(value, "economics"));
const valuationAnchor = z.strictObject({
  source: z.enum(["market-estimate", "lowest-competing-ask", "comp-percentile", "last-sold", "curve-objective"]),
  amount: cents,
  stratum: z.enum(["market-estimate", "hard-ask", "any-ask", "last-sold", "curve-objective"]),
  contributingListingCount: size,
  goal: z
    .strictObject({
      goalId: id,
      goalVersion: version,
      curveVersion: version,
      equivalentPercentile: finiteNonNegative.max(100),
      forecastMedianSellDays: finiteNonNegative.nullable(),
      forecastStatus: id,
      unprofitable: z.boolean(),
    })
    .optional(),
});
const evaluation = z.strictObject({
  listingId: id,
  currentPriceAmount: cents,
  targetPriceAmount: cents,
  ruleIndex: size,
  action: z.literal("update-price"),
  anchor: valuationAnchor.nullable(),
  exhaustedAnchors: z.array(
    z.strictObject({
      source: id,
      state: z.enum(["present", "stale", "absent", "currency-incomplete", "currency-mismatch"]),
      reason: id.optional(),
    }),
  ),
  clamps: z.strictObject({
    floor: z.boolean(),
    ceiling: z.boolean(),
    maxMove: z.boolean(),
    evidenceFloor: z.boolean().optional(),
  }),
  tolerance: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("absolute"), amount: cents }),
    z.strictObject({ mode: z.literal("percent"), percent: finiteNonNegative }),
  ]),
  flags: z.array(
    z.enum(["floor-binding", "ceiling-binding", "max-move-binding", "band-binding", "evidence-floor-binding"]),
  ),
  skipReason: z.null(),
});
const schema = z.strictObject({
  version: z.literal(1),
  binding: evaluationBindingSchema,
  challengeTime: timestamp,
  deadline: timestamp,
  grants: z.array(z.unknown()),
  members: z
    .array(
      z.strictObject({
        owner: z.enum(["pricing", "marketplace", "inventory", "catalog"]),
        key: id,
        seal: z.strictObject({ storeIncarnation: id, version: size }),
      }),
    )
    .min(5)
    .max(32),
  listing,
  inputs: evidenceInputs,
  competitors: z.unknown().transform(readCompetitorCapture),
  evaluation,
});

function validateEconomics(value: unknown) {
  const shape = z.object({ kind: z.enum(["resolved", "unavailable"]) }).safeParse(value);
  if (!shape.success) return false;
  const result = value as EconomicsResolution;
  if (result.kind === "resolved") {
    requireRfc3339Instant(result.economics.effectiveAt, "Economics effective time");
    assertEconomicsFacts(result.economics.facts, result.economics.currency);
    return typeof result.economics.revision === "string" && result.economics.revision.length > 0;
  }
  requireRfc3339Instant(result.effectiveAt, "Unavailable Economics effective time");
  return typeof result.revision === "string" && result.revision.length > 0;
}

function assertSafeNumbers(value: unknown): void {
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new Error("Unsafe number in exact Pricing evidence.");
  if (value && typeof value === "object") for (const nested of Object.values(value)) assertSafeNumbers(nested);
}

export function assertExactEvaluationEvidence(value: unknown) {
  assertSafeNumbers(value);
  const evidence = schema.parse(value);
  const grants = assertConfigurationGrantVector(
    evidence.grants as Parameters<typeof assertConfigurationGrantVector>[0],
  );
  const { binding, evaluation: priced, listing: own, inputs } = evidence;
  const { assignment, standing, platform, estimate, sale, marketSources: sources } = inputs;
  const platformValue = repricingEnginePolicy.decodeValue(platform.value);
  if (platform.selected) repricingEnginePolicy.decodeValue(platform.selected.value);
  if (
    (estimate === null) !== (sources.estimate === null) ||
    (sale === null) !== (sources.sale === null) ||
    standing.halt.state.engaged ||
    assignment.state.status !== "active" ||
    assignment.state.accountId !== binding.accountId ||
    !standing.policies.some((candidate) => evaluationDigest(candidate) === evaluationDigest(assignment)) ||
    own.policyId !== assignment.state.policyId ||
    own.policyRevision !== assignment.state.updatedAt ||
    evaluationDigest(own.rules) !== evaluationDigest(assignment.state.rules) ||
    own.maxChangesPerDay !== assignment.state.maxChangesPerDay ||
    own.listingId !== binding.listingId ||
    priced.listingId !== binding.listingId ||
    own.listingVersion !== binding.listingVersion ||
    own.catalogItemId !== binding.catalogItemId ||
    own.productId !== binding.productId ||
    own.sellerAccountId !== binding.accountId ||
    inputs.stock.itemId !== own.inventoryItemId ||
    inputs.stock.accountId !== binding.accountId ||
    inputs.stock.totalQuantity - inputs.stock.heldQuantity !== inputs.stock.availableQuantity ||
    own.priceCurrencyCode !== binding.priceCurrencyCode ||
    moneyToCents(priced.currentPriceAmount) !== moneyToCents(own.priceAmount) ||
    moneyToCents(priced.targetPriceAmount) !== moneyToCents(binding.priceAmount) ||
    priced.ruleIndex >= own.rules.length ||
    (platform.selected && evaluationDigest(platform.selected.value) !== evaluationDigest(platformValue)) ||
    (inputs.curve &&
      (inputs.curve.catalogItemId !== binding.catalogItemId || inputs.curve.productId !== binding.productId))
  )
    throw new Error("Pricing evidence does not authorize the exact Listing decision.");
  return { ...evidence, grants };
}
