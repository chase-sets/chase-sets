import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
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

type WaitlistRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  notificationOutbox?: NotificationOutbox;
  policies: PolicyRuntime;
  now?: () => Date;
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
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<WaitlistSignupEvent>(),
    initialState: () => initialWaitlistSignupState,
    evolve: evolveWaitlistSignup,
    decide: decideWaitlistSignup,
  });

  return {
    commandHandler,
    async submitWaitlistSignup(params, context) {
      const now = new Date().toISOString();
      const signupId = stableWaitlistSignupId(params.email);
      const result = await commandHandler({
        streamId: `public-presence.waitlist-signup-${signupId}`,
        command: {
          type: "RecordWaitlistSignup",
          email: params.email,
          role: params.role,
          interests: params.interests,
          marketingConsentAcceptedAt: params.marketingConsent ? now : null,
          referredBySignupId: params.referredBySignupId ?? null,
          games: params.games,
          hasStoreLink: params.hasStoreLink,
          storeUrl: params.storeUrl,
          inventorySize: params.inventorySize,
          source: params.source,
          recordedAt: now,
        },
        context,
      });

      return { signupId, version: result.version };
    },
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
