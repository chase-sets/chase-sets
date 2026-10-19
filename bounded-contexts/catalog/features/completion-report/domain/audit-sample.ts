import { createHash } from "node:crypto";

// Seeded audit sample of published Catalog Items for the cross-source audit.
// A request names strata as `domain[:language]=singles/sealed`; each stratum
// form takes its allocation from the batch's active items in a seed-ranked
// order, so a seed always reproduces the same sample from the same items in
// any input order. A stratum with no more items than its allocation takes all
// of them for every seed and reports the shortfall. A stratum with slack takes
// exactly its allocation; it has finitely many possible samples, so distinct
// seeds may select the same one. A request totals at most the 275 items of the
// fixed audit allocation. The sample carries only Catalog identifiers and
// relative public paths.

export type CatalogAuditSampleForm = "singles" | "sealed";

export type CatalogAuditSampleStratum = Readonly<{
  productDomain: string;
  // Null samples every language of the domain.
  languageCode: string | null;
  singles: number;
  sealed: number;
}>;

export type CatalogAuditSampleRequest = Readonly<{
  seed: string;
  strata: readonly CatalogAuditSampleStratum[];
}>;

// One active Catalog Item from the report's batch. `productForm` is the merge
// identity's raw form, classified here into singles or sealed.
export type CatalogAuditSamplePopulationItem = Readonly<{
  catalogItemId: string;
  productDomain: string;
  languageCode: string;
  productForm: string | null;
}>;

export type CatalogAuditSampleItem = Readonly<{
  catalogItemId: string;
  productDomain: string;
  languageCode: string;
  productForm: CatalogAuditSampleForm;
  publicPath: string;
}>;

export type CatalogAuditSampleStratumResult = Readonly<{
  productDomain: string;
  languageCode: string | null;
  productForm: CatalogAuditSampleForm;
  allocated: number;
  available: number;
  sampled: number;
  shortfall: number;
}>;

export type CatalogAuditSample = Readonly<{
  seed: string;
  strata: readonly CatalogAuditSampleStratumResult[];
  // Requested-domain items whose form is neither singles nor sealed.
  unclassifiedItemCount: number;
  items: readonly CatalogAuditSampleItem[];
}>;

export class CatalogAuditSampleRequestError extends Error {
  readonly code = "catalog_audit_sample_request_invalid";
  constructor(message: string) {
    super(message);
    this.name = "CatalogAuditSampleRequestError";
  }
}

// The fixed six-stratum audit allocation's total; no request may exceed it.
export const catalogAuditSampleMaxItems = 275;
const stratumEntryPattern = /^([a-z][a-z0-9-]*)(?::([a-z]{2,3}))?=(\d+)\/(\d+)$/;
// The seed is echoed into support-facing evidence, so it is a plain token.
const seedPattern = /^[A-Za-z0-9._-]{1,64}$/;

export function parseCatalogAuditSampleRequest(
  input: Readonly<{ strata: string; seed: string }>,
): CatalogAuditSampleRequest {
  if (!seedPattern.test(input.seed)) {
    throw new CatalogAuditSampleRequestError("The audit sample seed must be 1-64 letters, digits, '.', '_' or '-'.");
  }
  const entries = input.strata
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new CatalogAuditSampleRequestError("The audit sample allocation is empty.");
  }
  const strata: CatalogAuditSampleStratum[] = [];
  for (const entry of entries) {
    const match = stratumEntryPattern.exec(entry);
    if (!match) {
      throw new CatalogAuditSampleRequestError(
        `Audit sample stratum ${entry} is not domain[:language]=singles/sealed.`,
      );
    }
    const [, productDomain, languageCode, singles, sealed] = match;
    const allocation = { singles: Number(singles), sealed: Number(sealed) };
    // A domain is sampled either as a whole or per language, never both, so
    // no item can fall in two strata.
    const sameDomain = strata.filter((stratum) => stratum.productDomain === productDomain);
    if (
      sameDomain.some(
        (stratum) =>
          stratum.languageCode === null || languageCode === undefined || stratum.languageCode === languageCode,
      )
    ) {
      throw new CatalogAuditSampleRequestError(`Audit sample strata for ${productDomain} overlap.`);
    }
    strata.push({ productDomain: productDomain!, languageCode: languageCode ?? null, ...allocation });
  }
  const request = { seed: input.seed, strata };
  assertCatalogAuditSampleEnvelope(request);
  return request;
}

// Refuses a request whose allocation totals more than the audit envelope. The
// parser and the database read both call it, so no caller reaches the read
// with a larger request. A non-numeric total from a hand-built request fails
// the comparison and is refused too.
export function assertCatalogAuditSampleEnvelope(request: CatalogAuditSampleRequest): void {
  const total = request.strata.reduce((sum, stratum) => sum + stratum.singles + stratum.sealed, 0);
  if (!(total <= catalogAuditSampleMaxItems)) {
    throw new CatalogAuditSampleRequestError(
      `The audit sample allocation totals ${total} items; the audit envelope is at most ${catalogAuditSampleMaxItems}.`,
    );
  }
}

const sealedForms = new Set([
  "sealed",
  "sealed-product",
  "booster-pack",
  "booster-box",
  "elite-trainer-box",
  "bundle",
  "tin",
  "deck",
  "starter-deck",
  "gift-set",
  "trove",
]);
const singleForms = new Set(["single", "single-card", "card"]);

// Merge identities carry a declared form, a sealed product form, or the
// normalized kind (`*-card`, `*-card-print`, `*-sealed-product`). Anything
// else, such as a set reference, is neither singles nor sealed.
export function catalogAuditSampleForm(productForm: string | null): CatalogAuditSampleForm | null {
  const form = productForm?.trim().toLowerCase() ?? "";
  if (sealedForms.has(form) || form.endsWith("-sealed-product")) return "sealed";
  if (singleForms.has(form) || form.endsWith("-card") || form.endsWith("-card-print")) return "singles";
  return null;
}

// Discovery's public item path, as bounded-contexts/discovery/routes/set.tsx
// builds it. Catalog stores no slug (Discovery derives it), so the sample uses
// the id branch, which the item route resolves to the canonical slug.
export function catalogAuditSamplePublicPath(item: Readonly<{ slug?: string | null; catalogItemId: string }>): string {
  return `/items/${item.slug || item.catalogItemId}`;
}

export function selectCatalogAuditSample(
  request: CatalogAuditSampleRequest,
  population: readonly CatalogAuditSamplePopulationItem[],
): CatalogAuditSample {
  const rank = (catalogItemId: string) => createHash("sha256").update(`${request.seed}:${catalogItemId}`).digest("hex");
  const ranked = population
    .map((item) => ({ item, rank: rank(item.catalogItemId), form: catalogAuditSampleForm(item.productForm) }))
    .sort(
      (left, right) => compare(left.rank, right.rank) || compare(left.item.catalogItemId, right.item.catalogItemId),
    );

  const strata: CatalogAuditSampleStratumResult[] = [];
  const items: CatalogAuditSampleItem[] = [];
  let unclassifiedItemCount = 0;
  for (const stratum of request.strata) {
    const members = ranked.filter(
      ({ item }) =>
        item.productDomain === stratum.productDomain &&
        (stratum.languageCode === null || item.languageCode.toLowerCase() === stratum.languageCode),
    );
    unclassifiedItemCount += members.filter((member) => member.form === null).length;
    for (const productForm of ["singles", "sealed"] as const) {
      const available = members.filter((member) => member.form === productForm);
      const allocated = stratum[productForm];
      const chosen = available.slice(0, allocated);
      strata.push({
        productDomain: stratum.productDomain,
        languageCode: stratum.languageCode,
        productForm,
        allocated,
        available: available.length,
        sampled: chosen.length,
        shortfall: allocated - chosen.length,
      });
      items.push(
        ...chosen.map(({ item }) => ({
          catalogItemId: item.catalogItemId,
          productDomain: item.productDomain,
          languageCode: item.languageCode,
          productForm,
          publicPath: catalogAuditSamplePublicPath({ catalogItemId: item.catalogItemId }),
        })),
      );
    }
  }
  return { seed: request.seed, strata, unclassifiedItemCount, items };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
