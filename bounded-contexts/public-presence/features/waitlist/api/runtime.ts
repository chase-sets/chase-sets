import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import { stableWaitlistSignupId, type WaitlistSource } from "../domain/common";
import {
  decideWaitlistSignup,
  evolveWaitlistSignup,
  initialWaitlistSignupState,
  type WaitlistSignupCommand,
  type WaitlistSignupEvent,
  type WaitlistSignupState,
} from "../domain/domain";
import { buildWaitlistProjectionHandlers } from "../read-model/projection";
import { getWaitlistMetrics, getWaitlistReferralSummary, listWaitlistSignups } from "../read-model/queries";
import {
  PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
  buildWaitlistTransactionalEmailProjectionHandlers,
} from "../integrations/transactional-email/transactional-email-projector";

type WaitlistRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  notificationOutbox?: NotificationOutbox;
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
      source: WaitlistSource;
    }>,
    context: EventStoreContext,
  ) => Promise<{ signupId: string; version: number }>;
  listWaitlistSignups: (params: Parameters<typeof listWaitlistSignups>[1]) => ReturnType<typeof listWaitlistSignups>;
  getWaitlistMetrics: () => ReturnType<typeof getWaitlistMetrics>;
  getWaitlistReferralSummary: (signupId: string) => ReturnType<typeof getWaitlistReferralSummary>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createWaitlistRuntime(deps: WaitlistRuntimeDeps): WaitlistServices {
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
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
          source: params.source,
          recordedAt: now,
        },
        context,
      });

      return { signupId, version: result.version };
    },
    listWaitlistSignups: (params) => listWaitlistSignups(deps.db, params),
    getWaitlistMetrics: () => getWaitlistMetrics(deps.db),
    getWaitlistReferralSummary: (signupId) => getWaitlistReferralSummary(deps.db, signupId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "public-presence-waitlist-projection",
        handlers: buildWaitlistProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildWaitlistTransactionalEmailProjectionHandlers(
          notificationOutbox,
          PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}
