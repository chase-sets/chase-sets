import { createHash } from "node:crypto";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { z } from "zod";
import { resolveScopeSyncCountMembership } from "../../scope-sync-batches/api/planner";
import { parseSelection } from "../../scope-sync-batches/api/route";
import {
  catalogSyncAcceptedScopeMappingFromRow,
  catalogSyncProfileEligibilityBlockers,
  type CatalogSyncScope,
} from "../../source-observations/api/providers/catalog-sync-scope-planner";
import { catalogProviderProfileVersionIngestionUnitKey } from "../../source-observations/api/providers/registry";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import {
  parseProductionCatalogCompletionManifest,
  providerUnitKey,
  unitKey,
  type ManifestExclusion,
  type ManifestExpectedUnit,
  type ManifestProviderUnit,
  type ManifestScope,
  type ProductionCatalogCompletionManifest,
} from "../domain/manifest";
import { assertSupportSafe } from "../domain/redaction";
import {
  classifyProviderProductionClass,
  readProductionCatalogCompletionFacts,
  withCatalogCompletionReadSnapshot,
} from "./query";

const browserProvider = "tcgplayer";
const repreviewOn = ["expiry", "release", "scope", "mapping", "profile", "rollout", "provider-authority", "cost"];
export const completionManifestFilename = "catalog-completion-manifest.json";

const freezeInput = z.object({
  batchId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  mainCommit: z.string().regex(/^[a-f0-9]{40}$/),
  launchCutoff: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export function completionManifestWindow(input: z.input<typeof freezeInput>, now: () => Date) {
  const parsed = freezeInput.parse(input);
  const frozenAt = now().toISOString();
  const launchCutoff = new Date(parsed.launchCutoff).toISOString();
  const expiresAt = new Date(parsed.expiresAt).toISOString();
  if (expiresAt <= frozenAt || expiresAt <= launchCutoff) {
    throw new Error("manifest-window-invalid: expiry must be after generation and the launch cutoff.");
  }
  return { ...parsed, frozenAt, launchCutoff, expiresAt };
}

const storedPlan = z.object({
  scopeRecordVersion: z.string(),
  scope: z.object({ languageCode: z.string().nullish() }),
  mappingVersions: z.array(z.object({ mappingId: z.string(), version: z.string() })),
  participationPreview: z.object({
    units: z.array(
      z.object({
        providerKey: z.string(),
        unitKey: z.string(),
        profileKey: z.string(),
        profileVersion: z.string(),
        selected: z.boolean(),
        eligibility: z.enum(["eligible", "ineligible"]),
      }),
    ),
  }),
});

type FreezeEvidence = NonNullable<ProductionCatalogCompletionManifest["freezeEvidence"]>;

export async function produceProductionCatalogCompletionManifest(
  pool: PgTransactionalPool,
  window: ReturnType<typeof completionManifestWindow>,
) {
  return withCatalogCompletionReadSnapshot(pool, async (tx) => {
    const { batchId, frozenAt, launchCutoff, mainCommit, expiresAt } = window;
    const profileVersions = new Map<string, FreezeEvidence["profileVersions"][number]>();
    const mappingVersions: FreezeEvidence["mappingVersions"][number][] = [];
    const scopeVersions: FreezeEvidence["scopeVersions"][number][] = [];
    const domains: string[] = [];
    const languages: string[] = [];
    const kinds: string[] = [];

    const facts = await readProductionCatalogCompletionFacts(tx, { batchId, observedAt: frozenAt }, async (stored) => {
      const { records, mappings } = await resolveScopeSyncCountMembership(tx, parseSelection(stored.selection));
      const plans = new Map(stored.units.map((row) => [row.scope_record_id, storedPlan.parse(row.plan)]));
      if (records.length === 0 || records.length !== plans.size) throw planDrift("scope membership");

      const versions = await createCatalogProviderIntegrationProfileVersionStore(tx).listProfileVersions();
      const profiles = new Map<string, (typeof versions)[number]>();
      const browserUnits = new Set<string>();
      const exclusions: ManifestExclusion[] = [];
      const providerUnits = new Map<string, ManifestProviderUnit>();
      const expectedUnits: ManifestExpectedUnit[] = [];
      const scopes: ManifestScope[] = [];

      for (const profile of versions) {
        const key = catalogProviderProfileVersionIngestionUnitKey(profile);
        if (profile.providerKey === browserProvider) {
          browserUnits.add(key);
          continue;
        }
        const unit = providerUnitKey(profile.providerKey, key);
        const previous = profiles.get(unit);
        const active = profile.active && profile.lifecycle === "active";
        const previousActive = previous?.active && previous.lifecycle === "active";
        if (active && previousActive) throw planDrift("ambiguous active profiles");
        if (!previous || active || (!previousActive && compareProfile(profile, previous) > 0)) {
          profiles.set(unit, profile);
        }
      }

      const mappingsByScope = new Map<string, ReturnType<typeof catalogSyncAcceptedScopeMappingFromRow>[]>();
      for (const row of mappings) {
        if (row.provider_key === browserProvider) {
          browserUnits.add(row.unit_key);
          continue;
        }
        const mapping = catalogSyncAcceptedScopeMappingFromRow(row);
        const list = mappingsByScope.get(mapping.scopeRecordId) ?? [];
        list.push(mapping);
        mappingsByScope.set(mapping.scopeRecordId, list);
      }

      for (const record of sortedBy(records, (row) => row.scope_record_id)) {
        const scopeRecordId = record.scope_record_id;
        const plan = plans.get(scopeRecordId);
        const version = new Date(record.updated_at).toISOString();
        if (!plan || plan.scopeRecordVersion !== version) throw planDrift("scope version");
        const languageCode = plan.scope.languageCode ?? null;
        const scope: CatalogSyncScope = {
          scopeVersion: "catalog-sync-scope-v2",
          productDomain: record.product_domain,
          languageCode,
          reference: { kind: record.scope_kind, scopeRecordId },
        };
        const planned = new Map(
          plan.participationPreview.units
            .filter((unit) => unit.selected && unit.eligibility === "eligible" && unit.providerKey !== browserProvider)
            .map((unit) => [providerUnitKey(unit.providerKey, unit.unitKey), unit]),
        );
        const plannedMappingVersions = new Map(plan.mappingVersions.map((row) => [row.mappingId, row.version]));
        const acceptedMappings: ManifestScope["acceptedMappings"][number][] = [];
        const seen = new Set<string>();

        for (const mapping of sortedBy(mappingsByScope.get(scopeRecordId) ?? [], (row) => row.mappingId)) {
          const { providerKey, unitKey: key } = mapping;
          const pair = providerUnitKey(providerKey, key);
          const profile = profiles.get(pair);
          const coordinates = { scopeRecordId, providerKey, unitKey: key };
          if (seen.has(pair)) throw planDrift("ambiguous accepted mappings");
          seen.add(pair);
          const productionClass = profile ? classifyProviderProductionClass(profile) : "unapproved";
          if (!profile || productionClass !== "production") {
            exclusions.push({
              ...coordinates,
              reason: productionClass === "production" ? "unapproved" : productionClass,
              note: null,
            });
            continue;
          }
          if (
            !profile.profile.capabilities.includes("source-observation-import") ||
            (languageCode && mapping.languageCode && mapping.languageCode !== languageCode) ||
            catalogSyncProfileEligibilityBlockers(profile, key, scope, mapping).length > 0
          ) {
            exclusions.push({ ...coordinates, reason: "ineligible", note: null });
            continue;
          }
          const { profileKey, profileVersion } = profile;
          const plannedUnit = planned.get(pair);
          if (
            plannedUnit?.profileKey !== profileKey ||
            plannedUnit.profileVersion !== profileVersion ||
            plannedMappingVersions.get(mapping.mappingId) !== mapping.mappingVersion
          )
            throw planDrift("provider pair or source version");

          planned.delete(pair);
          expectedUnits.push(coordinates);
          acceptedMappings.push({ providerKey, unitKey: key });
          providerUnits.set(pair, { providerKey, unitKey: key, productionClass, active: true, lifecycle: "active" });
          profileVersions.set(pair, { providerKey, unitKey: key, profileKey, profileVersion });
          mappingVersions.push({ mappingId: mapping.mappingId, version: mapping.mappingVersion });
        }

        if (planned.size > 0 || acceptedMappings.length === 0) throw planDrift("required scope coverage");
        scopes.push({ scopeRecordId, eligible: true, acceptedMappings: sortedBy(acceptedMappings, unitOrder) });
        scopeVersions.push({ scopeRecordId, version });
        domains.push(scope.productDomain);
        kinds.push(record.scope_kind);
        languages.push(...scopeLanguages(record.language_editions, languageCode));
      }

      for (const key of browserUnits) {
        exclusions.push({
          scopeRecordId: null,
          providerKey: browserProvider,
          unitKey: key,
          reason: "browser-extension-only",
          note: null,
        });
      }
      return {
        frozenAt,
        launchCutoff,
        batch: stored.batch,
        providerUnits: sortedBy([...providerUnits.values()], unitOrder),
        scopes,
        expectedUnits: sortedBy(expectedUnits, pairOrder),
        exclusions: sortedBy(exclusions, (row) =>
          unitKey(row.scopeRecordId ?? "", row.providerKey ?? "", row.unitKey ?? ""),
        ),
      };
    });
    const manifest = parseProductionCatalogCompletionManifest({
      ...facts.manifest,
      observedUnits: sortedBy(
        facts.manifest.observedUnits.filter((row) => row.providerKey !== browserProvider),
        pairOrder,
      ),
      mergeCandidates: sortedBy(facts.manifest.mergeCandidates, (row) => row.candidateId),
      providerUsage: sortedBy(
        facts.manifest.providerUsage.filter((row) => row.providerKey !== browserProvider),
        (row) => row.providerKey,
      ),
      freezeEvidence: {
        mainCommit,
        expiresAt,
        repreviewOn,
        scopeVersions,
        mappingVersions: sortedBy(mappingVersions, (row) => row.mappingId),
        profileVersions: sortedBy([...profileVersions.values()], unitOrder),
        counts: {
          scopesByDomain: counts(domains),
          scopesByLanguage: counts(languages),
          scopesByKind: counts(kinds),
          pairsByProvider: counts(facts.manifest.expectedUnits.map((row) => row.providerKey)),
          pairsByUnit: counts(facts.manifest.expectedUnits.map((row) => row.unitKey)),
        },
        snapshotUnknownFactCount: facts.unknownFacts.length,
      },
    });
    assertSupportSafe(manifest);
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    return { manifest, json, sha256: createHash("sha256").update(json).digest("hex") };
  });
}

function planDrift(part: string): Error {
  return new Error(
    `manifest-plan-drift: ${part} differs from or cannot be proved for the stored batch; re-preview before freezing.`,
  );
}

function scopeLanguages(editions: unknown, selected: string | null): readonly string[] {
  if (selected) return [selected];
  const parsed = z.array(z.string()).parse(editions);
  return parsed.length ? [...new Set(parsed)] : ["unrecorded"];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareProfile(
  a: { profileKey: string; profileVersion: string },
  b: { profileKey: string; profileVersion: string },
): number {
  return compare(a.profileVersion, b.profileVersion) || compare(a.profileKey, b.profileKey);
}

function sortedBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => compare(key(a), key(b)));
}

function unitOrder(row: Pick<ManifestExpectedUnit, "providerKey" | "unitKey">) {
  return providerUnitKey(row.providerKey, row.unitKey);
}

function pairOrder(row: ManifestExpectedUnit) {
  return unitKey(row.scopeRecordId, row.providerKey, row.unitKey);
}

function counts(values: readonly string[]) {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return Object.fromEntries(sortedBy([...result], ([key]) => key));
}
