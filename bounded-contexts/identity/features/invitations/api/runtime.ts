import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideInvitation,
  evolveInvitation,
  initialInvitationState,
  type InvitationCommand,
  type InvitationEvent,
  type InvitationState,
} from "../domain/domain";
import { getInvitation, getPendingInvitationByEmail, listInvitations, type InvitationRow } from "../read-model/queries";
import { buildInvitationProjectionHandlers } from "../read-model/projection";

export type InvitationServices = Readonly<{
  commandHandler: CommandHandler<InvitationCommand, InvitationState, InvitationEvent>;
  listInvitations: (params?: Parameters<typeof listInvitations>[1]) => ReturnType<typeof listInvitations>;
  getInvitation: (invitationId: string) => ReturnType<typeof getInvitation>;
  getInvitationForRead: (invitationId: string) => Promise<InvitationRow | null>;
  getInvitationState: (invitationId: string) => Promise<InvitationState | null>;
  getPendingInvitationByEmail: (email: string) => ReturnType<typeof getPendingInvitationByEmail>;
  projectors: readonly ProjectionHandlerSet[];
}>;

function invitationRowFromState(state: InvitationState, projected: InvitationRow | null = null): InvitationRow | null {
  if (!state.id || !state.accountId || !state.email || !state.roleKey || !state.expiresAt) {
    return null;
  }

  return {
    invitation_id: state.id,
    account_id: state.accountId,
    account_display_name: projected?.account_display_name ?? null,
    account_name: projected?.account_name ?? null,
    email: state.email,
    role_key: state.roleKey,
    status: state.status,
    expires_at: state.expiresAt,
    accepted_by_user_id: state.acceptedByUserId,
    accepted_by_user_display_name: projected?.accepted_by_user_display_name ?? null,
    accepted_by_user_primary_email: projected?.accepted_by_user_primary_email ?? null,
    updated_at: projected?.updated_at ?? "",
  };
}

export function createInvitationRuntime(deps: IdentityRuntimeDeps): InvitationServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<InvitationEvent>(),
    initialState: () => initialInvitationState,
    evolve: evolveInvitation,
    decide: decideInvitation,
  });

  return {
    commandHandler,
    listInvitations: (params) => listInvitations(deps.db, params),
    getInvitation: (invitationId) => getInvitation(deps.db, invitationId),
    getInvitationForRead: async (invitationId) => {
      const [projected, state] = await Promise.all([
        getInvitation(deps.db, invitationId),
        loadInvitationState(invitationId),
      ]);
      return invitationRowFromState(state, projected) ?? projected;
    },
    getInvitationState: async (invitationId) => {
      const state = await loadInvitationState(invitationId);
      return state.id ? state : null;
    },
    getPendingInvitationByEmail: (email) => getPendingInvitationByEmail(deps.db, email),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-invitation-projection",
        handlers: buildInvitationProjectionHandlers(deps.db),
      }),
    ],
  };

  async function loadInvitationState(invitationId: string) {
    const aggregate = await repository.load(`identity.invitation-${invitationId}`);
    return aggregate.state;
  }
}
