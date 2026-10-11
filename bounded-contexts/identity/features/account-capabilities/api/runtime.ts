import type { BcAccountCapabilityDeclaration } from "@chase-sets/bounded-context-module";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
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

declare const accountCapabilityAssignmentAdmissionBrand: unique symbol;

/**
 * The result of admitting one grant or revoke attempt. Only the dedicated
 * Capability Administration Authority (#9385) produces it; this slice ships no
 * route, seed, fixture or other producer, so nothing can assign before then.
 */
export type AccountCapabilityAssignmentAdmission = Readonly<{
  [accountCapabilityAssignmentAdmissionBrand]: true;
  tenantId: string;
  administratorUserId: string;
}>;

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

export function createAccountCapabilityRuntime(deps: IdentityRuntimeDeps) {
  const { commandHandler, repository } = createAggregateCommandHandler<
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

  return {
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
    const result = await commandHandler({
      streamId: toAccountCapabilityAssignmentStreamId(target),
      command: toCommand(target),
      context,
    });
    return { state: result.state, version: result.version, appended: result.storedEvents.length > 0 };
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
