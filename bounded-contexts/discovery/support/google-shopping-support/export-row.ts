import { createHash } from "node:crypto";
import type { DiscoveryImageFallback, DiscoveryProductAssetSet } from "../client-support/contracts";

export type GoogleShoppingEligibilityStatus = "eligible" | "excluded";
export type GoogleShoppingImageEligibilityStatus = "eligible" | "excluded";

export type GoogleShoppingExclusionReason =
  | "listing-not-active"
  | "seller-unavailable"
  | "seller-not-active"
  | "sold-out"
  | "missing-link"
  | "missing-title"
  | "missing-description"
  | "missing-image"
  | "invalid-image-url"
  | "image-not-public"
  | "image-too-small"
  | "fallback-image-not-approved"
  | "missing-price"
  | "missing-condition"
  | "ambiguous-condition"
  | "missing-shipping-policy"
  | "missing-returns-policy"
  | "missing-product-measure"
  | "not-crawlable";

export type GoogleShoppingFeedRowInput = Readonly<{
  listingId: string;
  listingStatus: string;
  sellerListingAvailabilityStatus: string;
  sellerAccountStatus?: string | null;
  accountId: string;
  catalogItemId: string;
  productId: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  priceAmount: string | null;
  condition: string | null;
  shippingPolicyReady: boolean;
  returnsPolicyReady: boolean;
  crawlable: boolean;
  quantityCap?: number | null;
  productMeasureReady?: boolean | null;
}>;

export type GoogleShoppingPayloadInput = Readonly<{
  offerId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  priceAmount: string;
  currencyCode: string;
  availability: "in stock" | "out of stock";
  condition: string;
  externalSellerId: string;
  targetCountry: string;
  contentLanguage: string;
  feedLabel: string;
  brand?: string;
  gtin?: string;
  mpn?: string;
  identifierExists?: boolean;
  productType?: string;
  googleProductCategory?: string;
  productDetails?: readonly GoogleShoppingProductDetail[];
  shipping?: GoogleShoppingShippingPolicyPayload;
  returnPolicyLabel?: string;
}>;

export type GoogleShoppingSelectedOption = Readonly<{
  dimensionId: string;
  dimensionName?: string | null;
  optionId: string;
  optionCode?: string | null;
  optionLabel?: string | null;
  numericValue?: number | null;
}>;

export type GoogleShoppingProductDetail = Readonly<{
  sectionName: string;
  attributeName: string;
  attributeValue: string;
}>;

export type GoogleShoppingImageCandidate = Readonly<{
  url: string | null;
  width: number | null;
  height: number | null;
  source: "product-asset" | "image-url" | "image-fallback";
  fallbackUsage?: "permanent" | "loading-only" | null;
}>;

export type GoogleShoppingImageEligibility = Readonly<{
  status: GoogleShoppingImageEligibilityStatus;
  imageUrl: string | null;
  source: GoogleShoppingImageCandidate["source"] | null;
  reasons: readonly GoogleShoppingExclusionReason[];
}>;

export type GoogleShoppingCatalogFactsInput = Readonly<{
  catalogItemId: string;
  productId: string;
  title: string | null;
  subtitle?: string | null;
  description: string | null;
  productSummary?: string | null;
  selectedOptions: readonly GoogleShoppingSelectedOption[];
  productAssetSets?: readonly DiscoveryProductAssetSet[] | null;
  imageUrls?: readonly string[] | null;
  imageFallback?: DiscoveryImageFallback | null;
  brand?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  productType?: string | null;
  googleProductCategory?: string | null;
  productForm?: "single" | "graded" | "sealed" | "lot" | "unknown" | null;
  fallbackImagePolicyApproved?: boolean;
  allowedImageHosts?: readonly string[];
}>;

export type GoogleShoppingOfferFactsInput = Readonly<{
  listingId: string;
  listingStatus: string;
  sellerListingAvailabilityStatus: string;
  sellerAccountStatus?: string | null;
  accountId: string;
  canonicalUrl: string | null;
  priceAmount: string | null;
  currencyCode?: string | null;
  quantityCap?: number | null;
  crawlable: boolean;
}>;

export type GoogleShoppingShippingPolicyInput = Readonly<{
  ready: boolean;
  country: string;
  service?: string | null;
  priceAmount?: string | null;
  currencyCode?: string | null;
  shipFromCode?: string | null;
  shippingAllowancePercentageBps?: number | null;
  productMeasureReady?: boolean | null;
}>;

export type GoogleShoppingReturnsPolicyInput = Readonly<{
  ready: boolean;
  policyUrl: string | null;
  policyLabel?: string | null;
}>;

export type GoogleShoppingShippingPolicyPayload = Readonly<{
  country: string;
  service?: string;
  price?: Readonly<{
    amount: string;
    currencyCode: string;
  }>;
}>;

export type GoogleShoppingProductAttributes = Readonly<{
  title: string | null;
  description: string | null;
  image: GoogleShoppingImageEligibility;
  condition: "new" | "used" | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  identifierExists: boolean | null;
  productType: string | null;
  googleProductCategory: string | null;
  productDetails: readonly GoogleShoppingProductDetail[];
  exclusionReasons: readonly GoogleShoppingExclusionReason[];
}>;

export type GoogleShoppingOfferAttributes = Readonly<{
  offerId: string;
  externalSellerId: string;
  link: string | null;
  priceAmount: string | null;
  currencyCode: string;
  availability: "in stock" | "out of stock";
  exclusionReasons: readonly GoogleShoppingExclusionReason[];
}>;

export type GoogleShoppingPolicyAttributes = Readonly<{
  shipping: GoogleShoppingShippingPolicyPayload | null;
  returnPolicyLabel: string | null;
  exclusionReasons: readonly GoogleShoppingExclusionReason[];
}>;

export type GoogleShoppingMappedFeedRowInput = Readonly<{
  catalog: GoogleShoppingCatalogFactsInput;
  offer: GoogleShoppingOfferFactsInput;
  shipping: GoogleShoppingShippingPolicyInput;
  returns: GoogleShoppingReturnsPolicyInput;
  targetCountry: string;
  contentLanguage: string;
  feedLabel: string;
}>;

export type GoogleShoppingMappedFeedRow = Readonly<{
  rowId: string;
  merchantOfferId: string;
  externalSellerId: string;
  payload: GoogleShoppingPayloadInput | null;
  payloadHash: string | null;
  eligibility: Readonly<{ status: GoogleShoppingEligibilityStatus; reasons: readonly GoogleShoppingExclusionReason[] }>;
  imageEligibility: GoogleShoppingImageEligibility;
}>;

export function buildGoogleShoppingRowId(listingId: string) {
  return `google-shopping:listing:${listingId}`;
}

export function buildGoogleShoppingMerchantOfferId(listingId: string) {
  return `cs-listing-${listingId}`;
}

export function buildGoogleShoppingExternalSellerId(accountId: string) {
  return `cs-account-${accountId}`;
}

export function evaluateGoogleShoppingEligibility(
  input: GoogleShoppingFeedRowInput,
): Readonly<{ status: GoogleShoppingEligibilityStatus; reasons: readonly GoogleShoppingExclusionReason[] }> {
  const reasons: GoogleShoppingExclusionReason[] = [];

  if (input.listingStatus !== "active") {
    reasons.push("listing-not-active");
  }
  if (input.sellerListingAvailabilityStatus !== "available") {
    reasons.push("seller-unavailable");
  }
  if (input.sellerAccountStatus && input.sellerAccountStatus !== "active") {
    reasons.push("seller-not-active");
  }
  if (input.quantityCap !== undefined && input.quantityCap !== null && input.quantityCap <= 0) {
    reasons.push("sold-out");
  }
  if (!input.canonicalUrl?.trim()) {
    reasons.push("missing-link");
  }
  if (!input.title?.trim()) {
    reasons.push("missing-title");
  }
  if (!input.description?.trim()) {
    reasons.push("missing-description");
  }
  if (!input.imageUrl?.trim()) {
    reasons.push("missing-image");
  }
  if (!isPositiveMoneyAmount(input.priceAmount)) {
    reasons.push("missing-price");
  }
  if (!input.condition?.trim()) {
    reasons.push("missing-condition");
  }
  if (!input.shippingPolicyReady) {
    reasons.push("missing-shipping-policy");
  }
  if (input.productMeasureReady === false) {
    reasons.push("missing-product-measure");
  }
  if (!input.returnsPolicyReady) {
    reasons.push("missing-returns-policy");
  }
  if (!input.crawlable || !input.canonicalUrl?.trim()) {
    reasons.push("not-crawlable");
  }

  return {
    status: reasons.length === 0 ? "eligible" : "excluded",
    reasons,
  };
}

export function hashGoogleShoppingPayload(payload: GoogleShoppingPayloadInput) {
  return createHash("sha256").update(stableJsonStringify(payload)).digest("hex");
}

export function mapGoogleShoppingProductAttributes(
  input: GoogleShoppingCatalogFactsInput,
): GoogleShoppingProductAttributes {
  const baseTitle = trimToNull(input.title);
  const subtitle = trimToNull(input.subtitle);
  const title = baseTitle ? [baseTitle, subtitle].filter(Boolean).join(" ") : null;
  const description = trimToNull(input.description) ?? trimToNull(input.productSummary);
  const image = selectGoogleShoppingImage({
    productAssetSets: input.productAssetSets,
    imageUrls: input.imageUrls,
    imageFallback: input.imageFallback,
    fallbackImagePolicyApproved: input.fallbackImagePolicyApproved ?? false,
    allowedImageHosts: input.allowedImageHosts,
  });
  const conditionResult = mapGoogleShoppingCondition(input);
  const brand = trimToNull(input.brand);
  const gtin = trimToNull(input.gtin);
  const mpn = trimToNull(input.mpn);
  const productDetails = selectedOptionsToProductDetails(input.selectedOptions);
  const reasons: GoogleShoppingExclusionReason[] = [];

  if (!title) {
    reasons.push("missing-title");
  }
  if (!description) {
    reasons.push("missing-description");
  }
  reasons.push(...image.reasons);
  if (!conditionResult.condition) {
    reasons.push(conditionResult.reason);
  }

  return {
    title,
    description,
    image,
    condition: conditionResult.condition,
    brand,
    gtin,
    mpn,
    identifierExists: gtin || mpn ? true : false,
    productType: trimToNull(input.productType),
    googleProductCategory: trimToNull(input.googleProductCategory),
    productDetails,
    exclusionReasons: uniqueReasons(reasons),
  };
}

export function mapGoogleShoppingOfferAttributes(input: GoogleShoppingOfferFactsInput): GoogleShoppingOfferAttributes {
  const reasons: GoogleShoppingExclusionReason[] = [];
  const priceAmount = normalizePositiveMoneyAmount(input.priceAmount);
  const quantityCap = input.quantityCap ?? null;
  const link = trimToNull(input.canonicalUrl);

  if (input.listingStatus !== "active") {
    reasons.push("listing-not-active");
  }
  if (input.sellerListingAvailabilityStatus !== "available") {
    reasons.push("seller-unavailable");
  }
  if (input.sellerAccountStatus && input.sellerAccountStatus !== "active") {
    reasons.push("seller-not-active");
  }
  if (quantityCap !== null && quantityCap <= 0) {
    reasons.push("sold-out");
  }
  if (!link) {
    reasons.push("missing-link");
  }
  if (!priceAmount) {
    reasons.push("missing-price");
  }
  if (!input.crawlable || !link) {
    reasons.push("not-crawlable");
  }

  return {
    offerId: buildGoogleShoppingMerchantOfferId(input.listingId),
    externalSellerId: buildGoogleShoppingExternalSellerId(input.accountId),
    link,
    priceAmount,
    currencyCode: trimToNull(input.currencyCode) ?? "USD",
    availability: reasons.includes("sold-out") ? "out of stock" : "in stock",
    exclusionReasons: uniqueReasons(reasons),
  };
}

export function mapGoogleShoppingPolicyAttributes(
  shipping: GoogleShoppingShippingPolicyInput,
  returns: GoogleShoppingReturnsPolicyInput,
): GoogleShoppingPolicyAttributes {
  const reasons: GoogleShoppingExclusionReason[] = [];
  const returnPolicyUrl = trimToNull(returns.policyUrl);
  const shippingPayload =
    shipping.ready && trimToNull(shipping.country)
      ? {
          country: shipping.country.trim(),
          ...(trimToNull(shipping.service) ? { service: shipping.service!.trim() } : {}),
          ...(normalizePositiveMoneyAmount(shipping.priceAmount)
            ? {
                price: {
                  amount: normalizePositiveMoneyAmount(shipping.priceAmount)!,
                  currencyCode: trimToNull(shipping.currencyCode) ?? "USD",
                },
              }
            : {}),
        }
      : null;

  if (!shipping.ready || !shippingPayload) {
    reasons.push("missing-shipping-policy");
  }
  if (shipping.ready && !trimToNull(shipping.shipFromCode)) {
    reasons.push("missing-shipping-policy");
  }
  if (shipping.productMeasureReady === false) {
    reasons.push("missing-product-measure");
  }
  if (!returns.ready || !returnPolicyUrl || !isPublicHttpsUrl(returnPolicyUrl)) {
    reasons.push("missing-returns-policy");
  }

  return {
    shipping: shippingPayload,
    returnPolicyLabel: trimToNull(returns.policyLabel) ?? (returns.ready ? "chase-sets-standard-returns" : null),
    exclusionReasons: uniqueReasons(reasons),
  };
}

export function buildGoogleShoppingMappedFeedRow(input: GoogleShoppingMappedFeedRowInput): GoogleShoppingMappedFeedRow {
  const product = mapGoogleShoppingProductAttributes(input.catalog);
  const offer = mapGoogleShoppingOfferAttributes(input.offer);
  const policy = mapGoogleShoppingPolicyAttributes(input.shipping, input.returns);
  const reasons = uniqueReasons([...product.exclusionReasons, ...offer.exclusionReasons, ...policy.exclusionReasons]);
  const payload =
    reasons.length === 0 &&
    product.title &&
    product.description &&
    product.image.imageUrl &&
    product.condition &&
    offer.link &&
    offer.priceAmount
      ? compactPayload({
          offerId: offer.offerId,
          title: product.title,
          description: product.description,
          link: offer.link,
          imageLink: product.image.imageUrl,
          priceAmount: offer.priceAmount,
          currencyCode: offer.currencyCode,
          availability: offer.availability,
          condition: product.condition,
          externalSellerId: offer.externalSellerId,
          targetCountry: input.targetCountry,
          contentLanguage: input.contentLanguage,
          feedLabel: input.feedLabel,
          brand: product.brand ?? undefined,
          gtin: product.gtin ?? undefined,
          mpn: product.mpn ?? undefined,
          identifierExists: product.identifierExists ?? undefined,
          productType: product.productType ?? undefined,
          googleProductCategory: product.googleProductCategory ?? undefined,
          productDetails: product.productDetails.length > 0 ? product.productDetails : undefined,
          shipping: policy.shipping ?? undefined,
          returnPolicyLabel: policy.returnPolicyLabel ?? undefined,
        })
      : null;

  return {
    rowId: buildGoogleShoppingRowId(input.offer.listingId),
    merchantOfferId: offer.offerId,
    externalSellerId: offer.externalSellerId,
    payload,
    payloadHash: payload ? hashGoogleShoppingPayload(payload) : null,
    eligibility: {
      status: reasons.length === 0 ? "eligible" : "excluded",
      reasons,
    },
    imageEligibility: product.image,
  };
}

export function selectGoogleShoppingImage(input: {
  productAssetSets?: readonly DiscoveryProductAssetSet[] | null;
  imageUrls?: readonly string[] | null;
  imageFallback?: DiscoveryImageFallback | null;
  fallbackImagePolicyApproved?: boolean;
  allowedImageHosts?: readonly string[];
}): GoogleShoppingImageEligibility {
  const candidates = collectImageCandidates(input);

  for (const candidate of candidates) {
    if (candidate.source === "image-fallback" && !input.fallbackImagePolicyApproved) {
      return {
        status: "excluded",
        imageUrl: null,
        source: candidate.source,
        reasons: ["fallback-image-not-approved"],
      };
    }

    const validation = validateImageCandidate(candidate, input.allowedImageHosts);
    if (validation.length === 0) {
      return {
        status: "eligible",
        imageUrl: candidate.url?.trim() ?? null,
        source: candidate.source,
        reasons: [],
      };
    }
  }

  return {
    status: "excluded",
    imageUrl: null,
    source: candidates[0]?.source ?? null,
    reasons:
      candidates.length === 0 ? ["missing-image"] : validateImageCandidate(candidates[0]!, input.allowedImageHosts),
  };
}

function isPositiveMoneyAmount(value: string | null) {
  if (!value?.trim()) {
    return false;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function normalizePositiveMoneyAmount(value: string | null | undefined) {
  if (!isPositiveMoneyAmount(value ?? null)) {
    return null;
  }

  return Number(value).toFixed(2);
}

function mapGoogleShoppingCondition(
  input: Pick<GoogleShoppingCatalogFactsInput, "selectedOptions" | "productForm">,
): Readonly<{ condition: "new" | "used" | null; reason: "missing-condition" | "ambiguous-condition" }> {
  const conditionOption = input.selectedOptions.find((option) => optionLooksLikeCondition(option));
  const productForm = input.productForm ?? "unknown";

  if (!conditionOption) {
    if (productForm === "sealed") {
      return { condition: "new", reason: "missing-condition" };
    }

    return { condition: null, reason: "missing-condition" };
  }

  const conditionText = normalizeToken(
    [conditionOption.optionCode, conditionOption.optionLabel, conditionOption.optionId].filter(Boolean).join(" "),
  );

  if (/(sealed|unopened|factory sealed|\bnew\b)/.test(conditionText)) {
    return { condition: "new", reason: "missing-condition" };
  }
  if (
    /(pristine|mint|near mint|excellent|good|lightly played|moderately played|heavily played|poor|damaged|raw|graded|played|used)/.test(
      conditionText,
    )
  ) {
    return { condition: "used", reason: "missing-condition" };
  }

  return { condition: null, reason: "ambiguous-condition" };
}

function optionLooksLikeCondition(option: GoogleShoppingSelectedOption) {
  const dimensionText = normalizeToken([option.dimensionId, option.dimensionName].filter(Boolean).join(" "));
  const optionText = normalizeToken([option.optionId, option.optionCode, option.optionLabel].filter(Boolean).join(" "));

  return (
    dimensionText.includes("condition") ||
    /(sealed|unopened|factory sealed|\bnew\b|pristine|mint|played|poor|damaged|raw|graded|used)/.test(optionText)
  );
}

function selectedOptionsToProductDetails(
  selectedOptions: readonly GoogleShoppingSelectedOption[],
): readonly GoogleShoppingProductDetail[] {
  return selectedOptions
    .map((option) => {
      const attributeName = trimToNull(option.dimensionName) ?? trimToNull(option.dimensionId);
      const attributeValue =
        trimToNull(option.optionLabel) ?? trimToNull(option.optionCode) ?? trimToNull(option.optionId);

      return attributeName && attributeValue
        ? {
            sectionName: "Product options",
            attributeName,
            attributeValue,
          }
        : null;
    })
    .filter((entry): entry is GoogleShoppingProductDetail => entry !== null);
}

function collectImageCandidates(input: {
  productAssetSets?: readonly DiscoveryProductAssetSet[] | null;
  imageUrls?: readonly string[] | null;
  imageFallback?: DiscoveryImageFallback | null;
  fallbackImagePolicyApproved?: boolean;
}): GoogleShoppingImageCandidate[] {
  const candidates: GoogleShoppingImageCandidate[] = [];

  for (const assetSet of input.productAssetSets ?? []) {
    const detailVariants = assetSet.variants
      .filter((variant) => variant.role === "catalog-detail")
      .sort((left, right) => right.width - left.width || (right.density ?? 0) - (left.density ?? 0));

    for (const variant of detailVariants) {
      candidates.push({
        url: variant.publicUrl,
        width: variant.width,
        height: variant.height,
        source: "product-asset",
      });
    }
  }

  for (const imageUrl of input.imageUrls ?? []) {
    candidates.push({ url: imageUrl, width: null, height: null, source: "image-url" });
  }

  if (input.imageFallback) {
    candidates.push({
      url: input.imageFallback.url,
      width: null,
      height: null,
      source: "image-fallback",
      fallbackUsage: input.imageFallback.usage,
    });
  }

  return candidates;
}

function validateImageCandidate(
  candidate: GoogleShoppingImageCandidate,
  allowedHosts: readonly string[] | undefined,
): GoogleShoppingExclusionReason[] {
  const url = trimToNull(candidate.url);
  const reasons: GoogleShoppingExclusionReason[] = [];

  if (!url) {
    return ["missing-image"];
  }
  if (candidate.source === "image-fallback" && candidate.fallbackUsage !== "permanent") {
    reasons.push("fallback-image-not-approved");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return uniqueReasons([...reasons, "invalid-image-url"]);
  }

  if (parsed.protocol !== "https:") {
    reasons.push("image-not-public");
  }
  if (isLocalOrNonProductionHost(parsed.hostname)) {
    reasons.push("image-not-public");
  }
  if (allowedHosts?.length && !allowedHosts.includes(parsed.hostname)) {
    reasons.push("image-not-public");
  }
  if ((candidate.width !== null && candidate.width < 100) || (candidate.height !== null && candidate.height < 100)) {
    reasons.push("image-too-small");
  }

  return uniqueReasons(reasons);
}

function isLocalOrNonProductionHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".local") ||
    hostname.includes("staging.chasesets.com")
  );
}

function isPublicHttpsUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !isLocalOrNonProductionHost(parsed.hostname);
  } catch {
    return false;
  }
}

function compactPayload(payload: GoogleShoppingPayloadInput): GoogleShoppingPayloadInput {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  ) as GoogleShoppingPayloadInput;
}

function trimToNull(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function uniqueReasons(reasons: readonly GoogleShoppingExclusionReason[]) {
  return [...new Set(reasons)];
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
