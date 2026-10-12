import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogProviderIntegrationProfileVersionReader } from "../../source-observations/api/source-observation-runtime-contracts";
import { catalogProviderProfileVersionIngestionUnitKey } from "../../source-observations/api/provider-integration-profiles";
import { isActiveProviderOptionQueryProfileVersion } from "../../source-observations/api/governance/catalog-integration-control-plane-readiness";
import { createCatalogIntegrationRolloutControlPolicyFromEnv } from "../../source-observations/api/governance/catalog-integration-rollout-controls";
import {
  acquireScrydexPageOneCount,
  readScrydexCountSource,
  scrydexCountQuery,
  type ScrydexOnePieceProviderAdapterOptions,
} from "../../source-observations/api/providers/scrydex/adapter";
import {
  runCatalogProviderWork,
  runProviderSendRequest,
} from "../../source-observations/api/providers/provider-send-admission";
import type { CatalogProviderSendRuntime } from "../../source-observations/api/providers/provider-send-runtime";
import {
  CountAcquisitionRefused,
  countFingerprint,
  countQueryKey,
  type CountTarget,
} from "../domain/count-acquisition";
import type { ScopeSyncBatchSelection } from "../domain/batch";
import { createCountStore, lockCountHeadroom } from "../read-model/count-store";
import { createScopeSyncBatchStore } from "../read-model/store";
import { createCountAcquisition } from "./count-acquisition";
import { resolveScopeSyncCountMembership } from "./planner";

export function createScopeSyncCountRuntime(deps: {
  pool: PgTransactionalPool;
  store: ReturnType<typeof createCountStore>;
  environment: string;
  accountRevision: string;
  profiles: CatalogProviderIntegrationProfileVersionReader;
  adapterOptions: ScrydexOnePieceProviderAdapterOptions;
  providerSendRuntime?: CatalogProviderSendRuntime | null;
  now?: () => string;
}) {
  const policy = createCatalogIntegrationRolloutControlPolicyFromEnv();
  async function resolve(selection: unknown) {
    const membership = await resolveScopeSyncCountMembership(deps.pool, selection as ScopeSyncBatchSelection);
    const versions = await deps.profiles.listProfileVersions("scrydex");
    const targets = new Map<string, CountTarget>();
    const mappingsByScope = new Map<string, (typeof membership.mappings)[number][]>();
    for (const mapping of membership.mappings.filter((mapping) => mapping.provider_key === "scrydex")) {
      const entries = mappingsByScope.get(mapping.scope_record_id) ?? [];
      entries.push(mapping);
      mappingsByScope.set(mapping.scope_record_id, entries);
    }
    for (const record of membership.records) {
      const mappings = mappingsByScope.get(record.scope_record_id) ?? [];
      for (const mapping of mappings) {
        const kind = mapping.unit_key.includes(":single-card:")
          ? "cards"
          : mapping.unit_key.includes(":sealed-product:")
            ? "sealed"
            : null;
        if (!kind) continue;
        if (record.product_domain !== "one-piece" && record.product_domain !== "lorcana")
          throw new CountAcquisitionRefused();
        if (kind === "sealed" && record.product_domain === "lorcana") throw new CountAcquisitionRefused();
        if (
          mapping.unit_key !==
          `scrydex:${record.product_domain}:${kind === "cards" ? "single-card" : "sealed-product"}:source-observation-import`
        )
          throw new CountAcquisitionRefused();
        const matches = versions.filter(
          (version) =>
            isActiveProviderOptionQueryProfileVersion(version) &&
            catalogProviderProfileVersionIngestionUnitKey(version) === mapping.unit_key,
        );
        const version = matches.length === 1 ? matches[0] : null;
        if (
          !version ||
          !version.profile.optionQueries.some(
            (entry) => entry.queryKind === (kind === "sealed" ? "sealed-products" : "cards"),
          ) ||
          !mapping.set_id ||
          !["set", "expansion"].includes(record.scope_kind)
        )
          throw new CountAcquisitionRefused();
        for (const capability of ["provider-transport", "provider-option-query", "import"] as const) {
          policy.assertAllowed({
            capability,
            providerKey: "scrydex",
            unitKey: mapping.unit_key,
            profileKey: version.profileKey,
            profileVersion: version.profileVersion,
          });
        }
        const query = scrydexCountQuery({
          environment: deps.environment,
          accountRevision: deps.accountRevision,
          productDomain: record.product_domain,
          profileKey: version.profileKey,
          profileVersion: version.profileVersion,
          unitKey: mapping.unit_key,
          kind,
          languageCode:
            (membership.selection.mode === "matching-scope" ? membership.selection.query.languageCode : null) ?? "en",
          parentValue: mapping.set_id,
        });
        const source = await readScrydexCountSource(query, { ...deps.adapterOptions, countReader: deps.store });
        const blocked = !source && (await deps.store.blocked(query));
        targets.set(`${record.scope_record_id}:${countQueryKey(query)}`, {
          scopeRecordId: record.scope_record_id,
          query,
          source,
          blocked,
        });
      }
    }
    return {
      membershipFingerprint: countFingerprint({
        selection: membership.selection,
        records: membership.records,
        mappings: membership.mappings,
        profiles: versions.map((version) => ({
          key: version.profileKey,
          version: version.profileVersion,
          lifecycle: version.lifecycle,
          active: version.active,
        })),
      }),
      targets: [...targets.values()].sort(
        (a, b) => a.scopeRecordId.localeCompare(b.scopeRecordId) || a.query.kind.localeCompare(b.query.kind),
      ),
    };
  }
  const engine = createCountAcquisition({
    ledger: {
      ...deps.store,
      approve: (id, fingerprint, owner) => deps.store.approve(deps.pool, id, fingerprint, owner),
      claim: (quote, target, owner, authority) => deps.store.claim(deps.pool, quote, target, owner, authority),
    },
    resolve,
    now: deps.now,
    allowed: () => Boolean(deps.adapterOptions.credentials?.apiKey && deps.adapterOptions.credentials?.teamId),
    send: (query) => {
      const send = () =>
        runProviderSendRequest(
          {
            provider: "scrydex",
            category: "card-force",
            unitKey: query.unitKey,
            coordinate: query.parentValue,
            language: query.languageCode,
          },
          () => acquireScrydexPageOneCount(query, deps.adapterOptions),
        );
      return deps.providerSendRuntime ? runCatalogProviderWork(deps.providerSendRuntime.admission, send) : send();
    },
  });
  const owner = (context: EventStoreContext) =>
    countFingerprint({
      tenantId: context.tenantId,
      account: context.audit.forAccountId,
      user: context.audit.performedByUserId,
    });
  return {
    quoteCounts: (input: { selection: ScopeSyncBatchSelection; cap?: number; context: EventStoreContext }) =>
      engine.quote({ ...input, owner: owner(input.context) }),
    acquireCounts: (input: { quoteId: string; fingerprint: string; context: EventStoreContext }) =>
      engine.acquire({ ...input, owner: owner(input.context) }),
    getCountQuote: async (input: { quoteId: string; context: EventStoreContext }) => {
      const quote = await deps.store.loadQuote(input.quoteId, owner(input.context));
      return deps.store.retainedQuote(quote);
    },
    countSpend: (input: { before?: string; limit?: number }) => deps.store.history(input.limit, input.before),
    reserveBatch: (input: Parameters<ReturnType<typeof createScopeSyncBatchStore>["create"]>[0]) =>
      withPgTransaction(deps.pool, async (tx) => {
        await lockCountHeadroom(tx, deps.store.slot);
        const authority = await deps.store.authority(tx);
        const requested = input.preview.budget.creditedProviderRequestLimits.scrydex ?? 0;
        if (input.preview.providerUnitTotals.scrydex && (!authority.allowed || requested > authority.headroom!))
          throw new CountAcquisitionRefused();
        for (const plan of input.plans)
          for (const unit of plan.participationPreview.units.filter(
            (unit) => unit.selected && unit.providerKey === "scrydex" && unit.unitKey.includes(":single-card:"),
          )) {
            const original = unit.estimate.countSource;
            if (original) {
              const current = await readScrydexCountSource(original.query, {
                ...deps.adapterOptions,
                countReader: deps.store,
              });
              if (!current || countFingerprint(current) !== countFingerprint(original))
                throw new CountAcquisitionRefused();
            }
          }
        return createScopeSyncBatchStore(tx).create(input);
      }),
  };
}
