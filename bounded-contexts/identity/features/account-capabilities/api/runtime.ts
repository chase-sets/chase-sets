import type { BcAccountCapabilityDeclaration } from "@chase-sets/bounded-context-module";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { consumeAccountCapabilityAssignmentAdmission, type AccountCapabilityAssignmentAdmission } from "./admission";
import {
  createCapabilityAdministration,
  type CapabilityAdministrationOptions,
  type CapabilityAssignmentInput,
} from "./administration";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import { assert } from "../../../support/runtime-support/common";
import {
  assertAssignableAccountCapabilityKey,
  decideAccountCapabilityAssignment,
  evolveAccountCapabilityAssignment,
  initialAccountCapabilityAssignmentState,
  toAccountCapabilityAssignmentStreamId,
  type AccountCapabilityAssignmentCommand,
  type AccountCapabilityAssignmentEvent,
  type AccountCapabilityAssignmentState,
  type AccountCapabilityAssignmentTarget,
  type AssignableAccountCapabilityKey,
} from "../domain/domain";

export type { AccountCapabilityAssignmentAdmission } from "./admission";

/** Structural view of the host's complete Account Capability Registry. */
export type AccountCapabilityCatalog = readonly Readonly<BcAccountCapabilityDeclaration & { owningContext: string }>[];

export type AccountCapabilityAssignmentRequest = Readonly<{
  admission: AccountCapabilityAssignmentAdmission;
  accountCapabilityRegistry: AccountCapabilityCatalog;
  accountId: string;
  capabilityKey: string;
  expectedVersion: number;
}>;

export type AccountCapabilityAssignmentResult = Readonly<{
  state: AccountCapabilityAssignmentState;
  version: number;
  appended: boolean;
}>;

export function createAccountCapabilityRuntime(
  deps: IdentityRuntimeDeps,
  administrationOptions?: CapabilityAdministrationOptions,
) {
  const { repository } = createAggregateCommandHandler<
    AccountCapabilityAssignmentState,
    AccountCapabilityAssignmentCommand,
    AccountCapabilityAssignmentEvent
  >({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<AccountCapabilityAssignmentEvent>(),
    initialState: () => initialAccountCapabilityAssignmentState,
    evolve: evolveAccountCapabilityAssignment,
    decide: decideAccountCapabilityAssignment,
  });

  const administration = createCapabilityAdministration(deps.eventStore, administrationOptions);
  const runtime = {
    initializeAdministrationAuthority: administration.initialize,
    attemptAccountCapabilityAssignment: (
      action: "grant" | "revoke",
      actor: ResolvedActor | null,
      input: CapabilityAssignmentInput | null,
      context: EventStoreContext,
    ) =>
      administration.attempt(action, actor, input, context, (admission) => {
        assert(input !== null, "Invalid assignment input.");
        return (action === "grant" ? runtime.grantAccountCapability : runtime.revokeAccountCapability)(
          { ...input, admission, accountCapabilityRegistry: administrationOptions?.registry ?? [] },
          context,
        );
      }),
    grantAccountCapability: (request: AccountCapabilityAssignmentRequest, context: EventStoreContext) =>
      assign(request, context, (target) => ({
        type: "GrantAccountCapability",
        ...target,
        assignmentId: createId("acap"),
        expectedVersion: request.expectedVersion,
      })),
    revokeAccountCapability: (request: AccountCapabilityAssignmentRequest, context: EventStoreContext) =>
      assign(request, context, (target) => ({
        type: "RevokeAccountCapability",
        ...target,
        expectedVersion: request.expectedVersion,
      })),
    loadAccountCapabilityAssignment: async (target: AccountCapabilityAssignmentTarget) =>
      (await repository.load(toAccountCapabilityAssignmentStreamId(target))).state,
  };
  return runtime;

  async function assign(
    request: AccountCapabilityAssignmentRequest,
    context: EventStoreContext,
    toCommand: (target: AccountCapabilityAssignmentTarget) => AccountCapabilityAssignmentCommand,
  ): Promise<AccountCapabilityAssignmentResult> {
    assertAdmittedFor(request.admission, context);
    const target: AccountCapabilityAssignmentTarget = {
      tenantId: context.tenantId,
      accountId: request.accountId,
      capabilityKey: requireDeclaredBooleanDefaultOff(request.accountCapabilityRegistry, request.capabilityKey),
    };
    const participants = consumeAccountCapabilityAssignmentAdmission(request.admission);
    const streamId = toAccountCapabilityAssignmentStreamId(target);
    const loaded = await repository.load(streamId);
    const events = decideAccountCapabilityAssignment(loaded.state, toCommand(target));
    const state = events.reduce(evolveAccountCapabilityAssignment, loaded.state);
    const audit = participants[1];
    const auditWithVersion = {
      ...audit,
      events: audit.events.map((event) => ({
        ...event,
        payload: { ...event.payload, assignmentVersion: state.version },
      })),
    };
    assert(deps.eventStore.appendToStreams !== undefined, "Account Capability assignment requires atomic append.");
    await deps.eventStore.appendToStreams([
      participants[0],
      auditWithVersion,
      {
        streamId,
        expectedVersion: loaded.version,
        context,
        events: events.map(createPassthroughDomainEventCodec<AccountCapabilityAssignmentEvent>().encode),
      },
    ]);
    return { state, version: state.version, appended: events.length > 0 };
  }
}

export type AccountCapabilityRuntime = ReturnType<typeof createAccountCapabilityRuntime>;

function assertAdmittedFor(admission: AccountCapabilityAssignmentAdmission | undefined, context: EventStoreContext) {
  assert(
    typeof admission === "object" && admission !== null,
    "Account Capability assignment requires an administration admission.",
  );
  assert(
    admission.tenantId === context.tenantId && admission.administratorUserId === context.audit.performedByUserId,
    "Account Capability administration admission does not match the request's tenant and administrator.",
  );
}

function requireDeclaredBooleanDefaultOff(
  registry: AccountCapabilityCatalog,
  capabilityKey: string,
): AssignableAccountCapabilityKey {
  assertAssignableAccountCapabilityKey(capabilityKey);
  const declaration = Array.isArray(registry) ? registry.find((entry) => entry.key === capabilityKey) : undefined;
  assert(
    declaration?.kind === "boolean" && declaration.defaultValue === false,
    `Account Capability ${capabilityKey} is not declared as a default-false boolean in the Account Capability Registry.`,
  );
  return capabilityKey;
}
