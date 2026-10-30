import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogMergeCandidateIdentity } from "../../source-observations/domain/catalog-merge-candidate";
import {
  extractMergeCandidateFieldValue,
  mergeCandidateFieldValuesEqual,
} from "../../source-observations/api/promotion/catalog-merge-candidate-matcher";
import type { SourceObservationListRow } from "../../source-observations/read-model/queries";

export const providerAgreementFactKeys = [
  "name",
  "setName",
  "expansionName",
  "collectorNumber",
  "rarity",
  "releaseDate",
  "releaseYear",
  "productLineName",
  "productForm",
  "barcode",
] as const;

export type ProviderAgreementOutcome = "agreed" | "single-source" | "mismatch" | "absent" | "intra-provider-conflict";

export type ProviderAgreementField = Readonly<{
  agreed: number;
  "single-source": number;
  mismatch: number;
  absent: number;
  "intra-provider-conflict": number;
  mismatchPairs: Readonly<Record<string, number>>;
}>;

export type ProviderAgreement = Readonly<
  Record<
    string,
    Readonly<{
      candidateCount: number;
      fields: Readonly<Record<(typeof providerAgreementFactKeys)[number], ProviderAgreementField>>;
    }>
  >
>;

export type ProviderAgreementCandidate = Readonly<{
  productDomain: string;
  members: readonly Readonly<{
    providerKey: string;
    row: Pick<SourceObservationListRow, "normalized">;
    identity: CatalogMergeCandidateIdentity;
  }>[];
}>;

export function classifyProviderAgreement(
  domains: readonly string[],
  candidates: readonly ProviderAgreementCandidate[],
): ProviderAgreement {
  const result = new Map<string, { candidateCount: number; fields: Record<string, MutableField> }>();
  for (const domain of [...new Set(domains)].sort()) {
    result.set(domain, { candidateCount: 0, fields: createFields() });
  }

  for (const candidate of candidates) {
    const domain = result.get(candidate.productDomain) ?? { candidateCount: 0, fields: createFields() };
    result.set(candidate.productDomain, domain);
    domain.candidateCount += 1;
    for (const factKey of providerAgreementFactKeys) {
      const valuesByProvider = new Map<string, JsonValue[]>();
      for (const member of candidate.members) {
        const extracted = extractMergeCandidateFieldValue(factKey, member.row, member.identity);
        if (!extracted || extracted.fromFallback) continue;
        const values = valuesByProvider.get(member.providerKey) ?? [];
        if (!values.some((value) => mergeCandidateFieldValuesEqual(value, extracted.value))) {
          values.push(extracted.value);
        }
        valuesByProvider.set(member.providerKey, values);
      }
      const providerValues = [...valuesByProvider.entries()].sort(([left], [right]) => left.localeCompare(right));
      let outcome: ProviderAgreementOutcome;
      if (providerValues.some(([, values]) => values.length > 1)) {
        outcome = "intra-provider-conflict";
      } else {
        const values = providerValues.map(([provider, entries]) => ({ provider, value: entries[0]! }));
        if (values.length === 0) outcome = "absent";
        else if (values.length === 1) outcome = "single-source";
        else if (values.every((entry) => mergeCandidateFieldValuesEqual(entry.value, values[0]!.value))) {
          outcome = "agreed";
        } else {
          outcome = "mismatch";
          for (let left = 0; left < values.length; left += 1) {
            for (let right = left + 1; right < values.length; right += 1) {
              const first = values[left]!;
              const second = values[right]!;
              if (!mergeCandidateFieldValuesEqual(first.value, second.value)) {
                const pair = [first.provider, second.provider].sort().join("|");
                domain.fields[factKey]!.mismatchPairs[pair] = (domain.fields[factKey]!.mismatchPairs[pair] ?? 0) + 1;
              }
            }
          }
        }
      }
      domain.fields[factKey]![outcome] += 1;
    }
  }

  return Object.fromEntries(
    [...result.entries()].map(([domain, value]) => [
      domain,
      {
        candidateCount: value.candidateCount,
        fields: Object.fromEntries(providerAgreementFactKeys.map((factKey) => [factKey, value.fields[factKey]])),
      },
    ]),
  ) as ProviderAgreement;
}

type MutableField = {
  agreed: number;
  "single-source": number;
  mismatch: number;
  absent: number;
  "intra-provider-conflict": number;
  mismatchPairs: Record<string, number>;
};

function createFields(): Record<string, MutableField> {
  return Object.fromEntries(
    providerAgreementFactKeys.map((factKey) => [
      factKey,
      {
        agreed: 0,
        "single-source": 0,
        mismatch: 0,
        absent: 0,
        "intra-provider-conflict": 0,
        mismatchPairs: {},
      },
    ]),
  );
}
