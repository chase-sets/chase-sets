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
import { boundCountCaptureRequest } from "../../source-observations/api/providers/count-capture-transport";
import {
  CountAcquisitionRefused,
  CountPeriodCapRefused,
  countFingerprint,
  countQueryKey,
  type CountAdmission,
  type CountPeriodAuthority,
  type CountPreparationView,
  type CountQuote,
  type CountTarget,
} from "../domain/count-acquisition";
import { scrydexPeriodReserveSchema } from "../domain/scrydex-billing-period";
import type { ScopeSyncBatchSelection } from "../domain/batch";
import { createCountStore, lockCountHeadroom } from "../read-model/count-store";
import { createScopeSyncBatchStore } from "../read-model/store";
import { createCountAcquisition } from "./count-acquisition";
import { resolveScopeSyncCountMembership } from "./planner";

/**
 * Resolves a staging acquisition's period gate before anything is read or sent.
 * A capture run is honored, ungated here, only inside its own bound acquisition
 * request, where its bootstrap decision and per-debit store check gate every
 * send; anything but a well-formed reserve is unknown U and refuses.
 */
function stagingPeriod(authority: CountPeriodAuthority | undefined) {
  if (authority?.kind === "capture-run") {
    const bound = boundCountCaptureRequest();
    if (bound?.runId !== authority.runId || bound.phase !== "acquisition") throw new CountPeriodCapRefused(null);
    return null;
  }
  const reserve = authority?.kind === "reserve" ? scrydexPeriodReserveSchema.safeParse(authority.reserve) : null;
  if (!reserve?.success) throw new CountPeriodCapRefused(null);
  return { reserve: reserve.data, runId: reserve.data.runId };
}

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
      admit: (quote, owner, authority, period) => deps.store.admit(deps.pool, quote, owner, authority, period),
      admitPeriod: (quote, owner, period) => deps.store.admitPeriod(deps.pool, quote, owner, period),
      approve: (id, fingerprint, owner) => deps.store.approve(deps.pool, id, fingerprint, owner),
      claim: (quote, target, owner, authority, executionId, period) =>
        deps.store.claim(deps.pool, quote, target, owner, authority, executionId, period),
      end: (quoteId, executionId, owner, state) => deps.store.end(deps.pool, quoteId, executionId, owner, state),
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
    acquireCounts: async ({
      periodAuthority,
      ...input
    }: {
      quoteId: string;
      fingerprint: string;
      admission?: CountAdmission;
      periodAuthority?: CountPeriodAuthority;
      context: EventStoreContext;
    }) => {
      // Whole-quote admission exists for staging count preparation only.
      if (input.admission && deps.environment !== "staging") throw new CountAcquisitionRefused();
      // Outside staging nothing is period-gated, and a period reserve is refused.
      if (deps.environment !== "staging") {
        if (periodAuthority?.kind === "reserve") throw new CountAcquisitionRefused();
        return engine.acquire({ ...input, owner: owner(input.context) });
      }
      return engine.acquire({ ...input, owner: owner(input.context), period: stagingPeriod(periodAuthority) });
    },
    getCountQuote: async (input: {
      quoteId: string;
      view?: "preparation";
      context: EventStoreContext;
    }): Promise<CountQuote | CountPreparationView> => {
      // The preparation read serves staging count preparation only.
      if (input.view === "preparation" && deps.environment !== "staging") throw new CountAcquisitionRefused();
      const quote = await deps.store.loadQuote(input.quoteId, owner(input.context));
      return input.view === "preparation" ? deps.store.preparationView(quote) : deps.store.retainedQuote(quote);
    },
    countSpend: (input: { before?: string; limit?: number }) => deps.store.history(input.limit, input.before),
    reserveBatch: (input: Parameters<ReturnType<typeof createScopeSyncBatchStore>["create"]>[0]) =>
      withPgTransaction(deps.pool, async (tx) => {
        await lockCountHeadroom(tx, deps.store.slot);
        if (await deps.store.allocationConflict(tx)) throw new CountAcquisitionRefused();
        for (const plan of input.plans)
          for (const unit of plan.participationPreview.units.filter(
            (unit) => unit.selected && unit.providerKey === "scrydex",
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
