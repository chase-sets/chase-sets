import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore, EventStoreError } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import { roundDownWaitlistCounterForDisplay, stableWaitlistSignupId, type WaitlistSource } from "../domain/common";
import {
  decideWaitlistSignup,
  evolveWaitlistSignup,
  initialWaitlistSignupState,
  type WaitlistSignupCommand,
  type WaitlistSignupEvent,
  type WaitlistSignupState,
} from "../domain/domain";
import {
  evaluateWaveOneAdmissionBar,
  WAVE_ONE_ADMISSION_BAR,
  type WaveOneAdmissionBarStatus,
} from "../read-model/campaign-admission-bar-policy";
import { buildWaitlistProjectionHandlers } from "../read-model/projection";
import {
  getCampaignChannelAttribution,
  getCampaignQualityMetrics,
  getWaitlistMetrics,
  getWaitlistReferralSummary,
  getWaitlistSignupCount,
  listWaitlistSignups,
  listWaveAdmissionCandidates,
} from "../read-model/queries";
import { betaWavePolicy } from "../domain/wave-policy";
import { selectWaveCohort } from "../read-model/wave-cohort-policy";
import type { CampaignChannelAttributionRow, CampaignQualityMetrics, WaitlistCounter } from "./contracts";
import {
  PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
  buildWaitlistTransactionalEmailProjectionHandlers,
} from "../integrations/transactional-email/transactional-email-projector";
import {
  buildReferralLink,
  createReferralLinkProvisioningReceipt,
  generatePublicReferralCode,
  generateReferralLinkProvisioningId,
  jcsStringify,
  normalizeReferralLinkProvisioningRequest,
  publicReferralCodeDigest,
  sha256Hex,
  type CreatorUtmTuple,
  type ReferralLinkProvisioningReceipt,
  type SecureRandomBytes,
} from "../domain/public-referral-code";
import { createPublicReferralCodeReconciliation } from "./referral-code-reconciliation";

type WaitlistRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  notificationOutbox?: NotificationOutbox;
  policies: PolicyRuntime;
  now?: () => Date;
  randomBytes?: SecureRandomBytes;
  pool?: PgTransactionalPool;
}>;

export type WaitlistServices = Readonly<{
  commandHandler: CommandHandler<WaitlistSignupCommand, WaitlistSignupState, WaitlistSignupEvent>;
  submitWaitlistSignup: (
    params: Readonly<{
      email: string;
      role: string;
      interests: readonly string[];
      marketingConsent?: boolean;
      referredBySignupId?: string | null;
      games?: readonly string[];
      hasStoreLink?: boolean;
      storeUrl?: string | null;
      inventorySize?: string | null;
      source: WaitlistSource;
    }>,
    context: EventStoreContext,
  ) => Promise<{ signupId: string; version: number }>;
  provisionReferralLink: (
    params: Readonly<{ signupId: string; tuple: CreatorUtmTuple }>,
    context: EventStoreContext,
  ) => Promise<ReferralLinkProvisioningReceipt>;
  reconcilePublicReferralCodes: ReturnType<typeof createPublicReferralCodeReconciliation>;
  /**
   * Progressive welcome-page cohort-quality save. Only fields present on
   * `params` are updated (individual saves, never a submit-wall); the domain
   * merges them into the signup's existing cohort-quality record.
   */
  provideWaitlistCohortQuality: (
    params: Readonly<{
      signupId: string;
      games?: readonly string[];
      inventorySize?: string | null;
      hasStoreLink?: boolean;
      storeUrl?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ signupId: string; version: number }>;
  listWaitlistSignups: (params: Parameters<typeof listWaitlistSignups>[1]) => ReturnType<typeof listWaitlistSignups>;
  getWaitlistMetrics: () => ReturnType<typeof getWaitlistMetrics>;
  getWaitlistReferralSummary: (signupId: string) => ReturnType<typeof getWaitlistReferralSummary>;
  getWaitlistCounter: () => Promise<WaitlistCounter>;
  getCampaignQualityMetrics: () => Promise<CampaignQualityMetrics>;
  getCampaignChannelAttribution: () => Promise<readonly CampaignChannelAttributionRow[]>;
  getWaveOneAdmissionBarStatus: () => Promise<WaveOneAdmissionBarStatus>;
  admitWave: (
    params: Readonly<{
      waveNumber: 1 | 2 | 3;
      checkoutFailureRatePercent?: number;
      projectionsNearRealTime?: boolean;
      supportWithinSoloOperatorCapacity?: boolean;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    waveNumber: 1 | 2 | 3;
    configuredInviteCount: number;
    admittedCount: number;
    rolloutExposurePercent: number;
    policyDocumentId: string | null;
  }>;
  projectors: readonly ProjectionHandlerSet[];
}>;

const WAITLIST_COUNTER_CACHE_TTL_MS = 60_000;

export function createWaitlistRuntime(deps: WaitlistRuntimeDeps): WaitlistServices {
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  let counterCache: { readAt: number; counter: WaitlistCounter } | null = null;
  const now = deps.now ?? (() => new Date());
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<WaitlistSignupEvent>(),
    initialState: () => initialWaitlistSignupState,
    evolve: evolveWaitlistSignup,
    decide: decideWaitlistSignup,
    commitSourceContextName: "public-presence",
  });
  const reconcilePublicReferralCodes = createPublicReferralCodeReconciliation({
    eventStore: deps.eventStore,
    pool: deps.pool,
    now,
    randomBytes: deps.randomBytes,
  });

  return {
    commandHandler,
    async submitWaitlistSignup(params, context) {
      const appendToStreams = deps.eventStore.appendToStreams;
      if (!appendToStreams) {
        throw new Error("Recording a Waitlist Signup requires EventStore.appendToStreams.");
      }
      const recordedAt = now().toISOString();
      const signupId = stableWaitlistSignupId(params.email);
      const streamId = `public-presence.waitlist-signup-${signupId}`;
      const command: WaitlistSignupCommand = {
        type: "RecordWaitlistSignup",
        email: params.email,
        role: params.role,
        interests: params.interests,
        marketingConsentAcceptedAt: params.marketingConsent ? recordedAt : null,
        referredBySignupId: params.referredBySignupId ?? null,
        games: params.games,
        hasStoreLink: params.hasStoreLink,
        storeUrl: params.storeUrl,
        inventorySize: params.inventorySize,
        source: params.source,
        recordedAt,
      };

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const loaded = await repository.load(streamId);
        if (loaded.state.signupId !== null) {
          const result = await commandHandler({ streamId, command, context });
          return { signupId, version: result.version };
        }

        const recorded = decideWaitlistSignup(loaded.state, command);
        const publicReferralCode = generatePublicReferralCode(deps.randomBytes);
        const codeDigest = publicReferralCodeDigest(publicReferralCode);
        try {
          const results = await appendToStreams([
            {
              streamId: `public-presence.waitlist-referral-code-${codeDigest}`,
              wakeSourceContextName: "public-presence",
              expectedVersion: "no_stream",
              context,
              events: [
                {
                  eventType: "public-presence.waitlist-referral-code.reserved",
                  payload: { codeDigest, reservedAt: recordedAt },
                },
              ],
            },
            {
              streamId,
              wakeSourceContextName: "public-presence",
              expectedVersion: loaded.version,
              context,
              events: [
                ...recorded.map((event) => ({ eventType: event.type, payload: event.data })),
                {
                  eventType: "public-presence.waitlist-referral-code.issued",
                  payload: { signupId, publicReferralCode, issuedAt: recordedAt },
                },
              ],
            },
          ]);
          // The atomic append has committed; this bypasses the command handler, so
          // this write path owes the read-after-write commit recording itself.
          recordCommittedEvents(
            results.flatMap((result) => result.storedEvents),
            "public-presence",
          );
          const signupEvents = results.find((result) => result.streamId === streamId)?.storedEvents ?? [];
          return { signupId, version: signupEvents.at(-1)?.streamVersion ?? loaded.version };
        } catch (error) {
          if (isConcurrencyConflict(error)) continue;
          throw error;
        }
      }
      throw new Error("Waitlist Signup recording could not settle concurrent Public Referral Code issuance.");
    },
    async provisionReferralLink(params, context) {
      const request = normalizeReferralLinkProvisioningRequest(params);
      const streamId = `public-presence.waitlist-signup-${request.signupId}`;
      const tupleSha256 = sha256Hex(jcsStringify(request.tuple));
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const loaded = await repository.load(streamId);
        if (loaded.state.signupId !== request.signupId || !loaded.state.publicReferralCode) {
          throw new Error("Waitlist Signup does not have an issued Public Referral Code.");
        }
        const referralLink = buildReferralLink(loaded.state.publicReferralCode, request.tuple);
        const referralLinkSha256 = sha256Hex(referralLink);
        const existing = loaded.state.referralLinkProvisionings.find(
          (entry) => entry.tupleSha256 === tupleSha256 && entry.referralLinkSha256 === referralLinkSha256,
        );
        if (existing) {
          return createReferralLinkProvisioningReceipt({
            provisioningId: existing.provisioningId,
            publicReferralCode: loaded.state.publicReferralCode,
            tuple: request.tuple,
            referralLink,
            issuedAt: existing.issuedAt,
          });
        }

        const issuedAt = now().toISOString();
        const provisioningId = generateReferralLinkProvisioningId(deps.randomBytes);
        try {
          const storedEvents = await repository.append({
            streamId,
            wakeSourceContextName: "public-presence",
            expectedVersion: loaded.version,
            context,
            events: [
              {
                type: "public-presence.waitlist-referral-link.provisioned",
                data: {
                  signupId: request.signupId,
                  provisioningId,
                  tupleSha256,
                  referralLinkSha256,
                  performedByUserId: context.audit.performedByUserId,
                  issuedAt,
                },
              },
            ],
          });
          // Same bypass as the first-time signup append: the provisioning write goes
          // straight through the repository, so it records its own committed events.
          recordCommittedEvents(storedEvents, "public-presence");
          return createReferralLinkProvisioningReceipt({
            provisioningId,
            publicReferralCode: loaded.state.publicReferralCode,
            tuple: request.tuple,
            referralLink,
            issuedAt,
          });
        } catch (error) {
          if (isConcurrencyConflict(error)) continue;
          throw error;
        }
      }
      throw new Error("Referral Link provisioning could not settle concurrent history.");
    },
    reconcilePublicReferralCodes,
    async provideWaitlistCohortQuality(params, context) {
      const result = await commandHandler({
        streamId: `public-presence.waitlist-signup-${params.signupId}`,
        command: {
          type: "ProvideWaitlistCohortQuality",
          games: params.games,
          inventorySize: params.inventorySize,
          hasStoreLink: params.hasStoreLink,
          storeUrl: params.storeUrl,
          providedAt: new Date().toISOString(),
        },
        context,
      });

      return { signupId: params.signupId, version: result.version };
    },
    listWaitlistSignups: (params) => listWaitlistSignups(deps.db, params),
    async getWaitlistMetrics() {
      const resolved = await deps.policies.resolvePolicy(betaWavePolicy, { at: now().toISOString() });
      return getWaitlistMetrics(deps.db, resolved.value.waves);
    },
    getWaitlistReferralSummary: (signupId) => getWaitlistReferralSummary(deps.db, signupId),
    getCampaignQualityMetrics: () => getCampaignQualityMetrics(deps.db),
    getCampaignChannelAttribution: () => getCampaignChannelAttribution(deps.db),
    async getWaveOneAdmissionBarStatus() {
      const quality = await getCampaignQualityMetrics(deps.db);
      return evaluateWaveOneAdmissionBar({
        totalSignups: quality.totalSignups,
        qualifiedSellerCount: quality.qualifiedSellerCount,
        qualifiedSellersByGame: quality.qualifiedSellersByGame,
      });
    },
    async admitWave(params, context) {
      const admittedAt = now().toISOString();
      const resolved = await deps.policies.resolvePolicy(betaWavePolicy, { at: admittedAt });
      const wave = resolved.value.waves.find((candidate) => candidate.waveNumber === params.waveNumber);
      if (!wave) {
        throw new Error(`Wave ${params.waveNumber} is not configured.`);
      }
      if (Date.parse(admittedAt) < Date.parse(wave.opensAt)) {
        throw new Error(`Wave ${params.waveNumber} cannot open before ${wave.opensAt}.`);
      }
      const quality = await getCampaignQualityMetrics(deps.db);
      const operationsGates = resolved.value.operationsGates;
      if (params.waveNumber === 1) {
        if (!evaluateWaveOneAdmissionBar(quality).admitted) {
          throw new Error("Wave 1 admission bar has not passed.");
        }
      } else if (
        !Number.isFinite(params.checkoutFailureRatePercent) ||
        Number(params.checkoutFailureRatePercent) >= operationsGates.maxCheckoutFailureRatePercent ||
        (operationsGates.requireNearRealTimeProjections && params.projectionsNearRealTime !== true) ||
        (operationsGates.requireSupportWithinSoloOperatorCapacity && params.supportWithinSoloOperatorCapacity !== true)
      ) {
        throw new Error("Between-wave operations gates have not passed.");
      }

      const selected = selectWaveCohort(
        await listWaveAdmissionCandidates(deps.db, params.waveNumber),
        params.waveNumber,
        wave.inviteCount,
        WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame,
      );
      let admittedCount = 0;
      for (const candidate of selected) {
        const invitationId = `wvi_${params.waveNumber}_${candidate.signupId.slice("wls_".length)}`;
        const result = await commandHandler({
          streamId: `public-presence.waitlist-signup-${candidate.signupId}`,
          command: { type: "AdmitWaitlistSignup", waveNumber: params.waveNumber, invitationId, admittedAt },
          context,
        });
        if (result.state.admission?.invitationId === invitationId) {
          admittedCount += 1;
        }
      }
      return {
        waveNumber: params.waveNumber,
        configuredInviteCount: wave.inviteCount,
        admittedCount,
        rolloutExposurePercent: wave.rolloutExposurePercent,
        policyDocumentId: resolved.documentId,
      };
    },
    async getWaitlistCounter() {
      // The counter renders on every landing view and is bucketed to 25s for display,
      // so a briefly stale value is invisible; the TTL keeps this public unauthenticated
      // endpoint from running COUNT(*) once per request.
      const readAt = Date.now();
      if (!counterCache || readAt - counterCache.readAt >= WAITLIST_COUNTER_CACHE_TTL_MS) {
        const signupCount = await getWaitlistSignupCount(deps.db);
        counterCache = { readAt, counter: { displayCount: roundDownWaitlistCounterForDisplay(signupCount) } };
      }
      return counterCache.counter;
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "public-presence-waitlist-projection",
        handlers: buildWaitlistProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildWaitlistTransactionalEmailProjectionHandlers(
          deps.db,
          notificationOutbox,
          PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}

function isConcurrencyConflict(error: unknown): error is EventStoreError {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as EventStoreError).code === "concurrency_conflict",
  );
}
