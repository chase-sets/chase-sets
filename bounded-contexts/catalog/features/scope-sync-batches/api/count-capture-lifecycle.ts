import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { catalogProviderProfileVersionIngestionUnitKey } from "../../source-observations/api/provider-integration-profiles";
import {
  CountCaptureStopped,
  runCountCaptureRequest,
} from "../../source-observations/api/providers/count-capture-transport";
import { runCatalogProviderWork } from "../../source-observations/api/providers/provider-send-admission";
import type { CatalogProviderSendRuntime } from "../../source-observations/api/providers/provider-send-runtime";
import type { CatalogProviderIntegrationProfileVersionReader } from "../../source-observations/api/source-observation-runtime-contracts";
import { countFingerprint, type CountAuthority } from "../domain/count-acquisition";
import { countCaptureUnitKeys } from "../domain/count-capture-plan";
import {
  countCaptureAuthoritySchema,
  validateCountCaptureAuthority,
  type CountCaptureAuthority,
} from "../domain/count-lifecycle-receipt";
import {
  countCaptureSendCap,
  type CountCaptureBaseline,
  type CountCaptureEffects,
  type CountCaptureHost,
  type CountCaptureStore,
} from "../read-model/count-capture-store";
import { countCaptureAdminOrigin, countCaptureSessionOwner, type CountCaptureSession } from "./count-capture-session";
import { retainTargetedCountCaptureUsage } from "./count-capture-usage";
import { resolveScopeSyncCountMembership } from "./planner";

type Instant = string | Date;
// The local rows a baseline reads: the selected scope record, its accepted
// provider mappings and the Scrydex profile versions.
export type CountCaptureRoster = Readonly<{
  records: readonly Readonly<{
    scope_record_id: string;
    product_domain: string;
    scope_kind: string;
    lifecycle_status: string;
    updated_at: Instant;
  }>[];
  mappings: readonly Readonly<{
    mapping_id: string;
    scope_record_id: string;
    provider_key: string;
    unit_key: string;
    set_id: string | null;
    updated_at: Instant;
  }>[];
  profiles: readonly Readonly<{
    profileKey: string;
    profileVersion: string;
    active: boolean;
    lifecycle: string;
    unitKey: string | null;
  }>[];
}>;
export type CountCaptureLifecycle = ReturnType<typeof createCountCaptureLifecycle>;

const iso = (value: Instant) => new Date(value).toISOString();

// Local reads only: the exact selected scope record, its accepted mappings and
// every Scrydex profile version.
export async function readCountCaptureRoster(
  db: PgQueryable,
  profiles: CatalogProviderIntegrationProfileVersionReader,
  scopeRecordId: string,
): Promise<CountCaptureRoster> {
  const membership = await resolveScopeSyncCountMembership(db, { mode: "ids", scopeRecordIds: [scopeRecordId] });
  return {
    records: membership.records,
    mappings: membership.mappings,
    profiles: (await profiles.listProfileVersions("scrydex")).map((version) => ({
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
      active: version.active,
      lifecycle: version.lifecycle,
      unitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    })),
  };
}

// The deployed Scrydex adapter's own usage observation, whose callback persists
// count authority, under whatever provider-send admission the deployment
// enforces. No other provider, raw usage request or cache expiry is involved.
export function observeDeployedScrydexUsage(
  registry: ProviderAdapterRegistry,
  providerSendRuntime: CatalogProviderSendRuntime | null | undefined,
) {
  return async (): Promise<unknown> => {
    const adapter = registry.require("scrydex");
    if (!adapter.getUsageSnapshot) throw new CountCaptureStopped();
    const observe = () => adapter.getUsageSnapshot!();
    return providerSendRuntime ? runCatalogProviderWork(providerSendRuntime.admission, observe) : observe();
  };
}

// The full roster: one active One Piece OP01 set whose accepted mappings are
// exactly the three Scrydex capture units, each with one active profile version.
// An extra, omitted, foreign-provider or other-set unit refuses; none is dropped.
function rosterBaseline(roster: CountCaptureRoster, scopeRecordId: string, accountRevision: string) {
  const record = roster.records[0];
  if (
    roster.records.length !== 1 ||
    !record ||
    record.scope_record_id !== scopeRecordId ||
    record.product_domain !== "one-piece" ||
    record.scope_kind !== "set" ||
    record.lifecycle_status !== "active"
  )
    throw new CountCaptureStopped();
  if (roster.mappings.length !== countCaptureUnitKeys.length) throw new CountCaptureStopped();
  const units = countCaptureUnitKeys.map((unitKey) => {
    const mappings = roster.mappings.filter(
      (mapping) =>
        mapping.scope_record_id === scopeRecordId &&
        mapping.provider_key === "scrydex" &&
        mapping.unit_key === unitKey &&
        mapping.set_id === "OP01",
    );
    const profiles = roster.profiles.filter(
      (profile) => profile.unitKey === unitKey && profile.active && profile.lifecycle === "active",
    );
    const [mapping] = mappings;
    const [profile] = profiles;
    if (mappings.length !== 1 || profiles.length !== 1 || !mapping || !profile) throw new CountCaptureStopped();
    return {
      unitKey,
      profileKey: profile.profileKey,
      profileVersion: profile.profileVersion,
      mappingId: mapping.mapping_id,
      mappingVersion: iso(mapping.updated_at),
      setCoordinate: "OP01" as const,
    };
  });
  return {
    selection: {
      scopeRecordId,
      scopeRecordVersion: iso(record.updated_at),
      accountRevision,
      productDomain: "one-piece" as const,
      parentValue: "OP01" as const,
      languageCode: "en" as const,
    },
    units,
  };
}

// The host's declaration, retained as declared. The server checked its
// consistency and freshness; it never observed the deployment or pods it names.
function declaredHost(authority: CountCaptureAuthority): CountCaptureHost {
  const { budget, deployment } = authority;
  return {
    fingerprint: countFingerprint(authority),
    dispatchId: authority.dispatchId,
    packetHash: authority.packetHash,
    runnerSha: authority.runnerSha,
    deployment: { runId: deployment.runId, jobId: deployment.jobId, sha: deployment.sha, digest: deployment.digest },
    netCredits: budget.remainingCredits - budget.unreflectedCredits - budget.reservedCredits,
  };
}

// The pre-spend half of one staging count capture. Each handler resolves the run
// from the session owner; every step refuses without the owner's admitted run.
export function createCountCaptureLifecycle(deps: {
  environment: string;
  accountRevision: string;
  store: CountCaptureStore;
  readRoster(scopeRecordId: string): Promise<CountCaptureRoster>;
  readEffects(at: string): Promise<CountCaptureEffects>;
  countAuthority(): Promise<CountAuthority>;
  // The deployed adapter's usage observation, whose callback persists authority.
  observeUsage(): Promise<unknown>;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const owner = (session: CountCaptureSession) => countCaptureSessionOwner(session, deps.environment);

  return {
    // Admits one run under a valid host authority envelope, then reads its
    // baseline locally inside the run's zero-send baseline phase.
    async baseline(session: CountCaptureSession, input: Readonly<{ scopeRecordId: string; authority: unknown }>) {
      const ownerHash = owner(session);
      const at = now();
      if (!validateCountCaptureAuthority(input.authority, at).ok) throw new CountCaptureStopped();
      const host = declaredHost(countCaptureAuthoritySchema.parse(input.authority));
      const run = await deps.store.admit({ ownerHash, scopeRecordId: input.scopeRecordId, host });
      const binding = await deps.store.begin(run.runId, "baseline");
      const baseline: CountCaptureBaseline = await runCountCaptureRequest(
        { binding, ledger: deps.store.ledger },
        async () => {
          const roster = rosterBaseline(
            await deps.readRoster(run.scopeRecordId),
            run.scopeRecordId,
            deps.accountRevision,
          );
          const recorded = await deps.store.recordBaseline(binding, {
            recordedAt: now(),
            ...roster,
            countAuthority: await deps.countAuthority(),
            effects: await deps.readEffects(now()),
          });
          await deps.store.finish(binding);
          return recorded;
        },
      );
      return {
        admittedAt: run.admittedAt,
        expiresAt: run.expiresAt,
        host: run.host,
        access: {
          originHost: new URL(countCaptureAdminOrigin).host,
          role: "platform-admin" as const,
          permissions: ["catalog.view", "catalog.manage"] as const,
          ownerMatch: true as const,
          checkedAt: at,
        },
        baseline,
        providerSends: (await deps.store.read(run.runId)).sends.length,
      };
    },
    // Records the pre-spend notice, then returns it as read back from the store.
    async initialNotice(session: CountCaptureSession) {
      const run = await deps.store.activeRun(owner(session));
      const recorded = await deps.store.recordInitialNotice(run.runId);
      const notice = (await deps.store.read(run.runId)).notice;
      if (!notice || notice.fingerprint !== recorded.fingerprint) throw new CountCaptureStopped();
      return { notice };
    },
    // The bootstrap phase. Usage reads are not count debits, so durable authority
    // must cover the whole run cap, including this phase's own possible send.
    async usage(session: CountCaptureSession) {
      const run = await deps.store.activeRun(owner(session));
      const binding = await deps.store.begin(run.runId, "bootstrap");
      const usage = await runCountCaptureRequest({ binding, ledger: deps.store.ledger }, async () => {
        const outcome = await retainTargetedCountCaptureUsage(
          { authority: deps.countAuthority, getUsageSnapshot: deps.observeUsage },
          countCaptureSendCap,
        );
        const recorded = await deps.store.recordUsage(binding, outcome);
        await deps.store.finish(binding);
        return recorded;
      });
      return { usage };
    },
  };
}
