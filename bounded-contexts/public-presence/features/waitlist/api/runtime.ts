import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createNoopTransactionalEmailOutbox,
  type TransactionalEmailOutbox,
} from "@chase-sets/communications-email";
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
import { getWaitlistMetrics, listWaitlistSignups } from "../read-model/queries";
import {
  PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
  buildWaitlistTransactionalEmailProjectionHandlers,
} from "../integrations/transactional-email/transactional-email-projector";

type WaitlistRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  transactionalEmailOutbox?: TransactionalEmailOutbox;
}>;

export type WaitlistServices = Readonly<{
  commandHandler: CommandHandler<
    WaitlistSignupCommand,
    WaitlistSignupState,
    WaitlistSignupEvent
  >;
  submitWaitlistSignup: (
    params: Readonly<{
      email: string;
      role: string;
      interests: readonly string[];
      emailConsent: boolean;
      source: WaitlistSource;
    }>,
    context: EventStoreContext,
  ) => Promise<{ signupId: string; version: number }>;
  listWaitlistSignups: (
    params: Parameters<typeof listWaitlistSignups>[1],
  ) => ReturnType<typeof listWaitlistSignups>;
  getWaitlistMetrics: () => ReturnType<typeof getWaitlistMetrics>;
  projectors: readonly Projector[];
}>;

export function createWaitlistRuntime(deps: WaitlistRuntimeDeps): WaitlistServices {
  const transactionalEmailOutbox =
    deps.transactionalEmailOutbox ?? createNoopTransactionalEmailOutbox();
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<WaitlistSignupEvent>(),
      initialState: () => initialWaitlistSignupState,
      evolve: evolveWaitlistSignup,
    }),
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
          emailConsentAcceptedAt: params.emailConsent ? now : null,
          source: params.source,
          recordedAt: now,
        },
        context,
      });

      return { signupId, version: result.version };
    },
    listWaitlistSignups: (params) => listWaitlistSignups(deps.db, params),
    getWaitlistMetrics: () => getWaitlistMetrics(deps.db),
    projectors: [
      createProjector({
        projectorName: "public-presence-waitlist-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildWaitlistProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildWaitlistTransactionalEmailProjectionHandlers(
          transactionalEmailOutbox,
          PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}
