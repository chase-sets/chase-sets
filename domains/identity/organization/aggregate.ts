import {
  createPassthroughDomainEventCodec,
  type DomainEventCodec,
} from "../../../contracts/event-core/codec";
import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "../../../contracts/event-core/domain";
import type { OrganizationId } from "../../../contracts/primitives/typed-ids";

export type OrganizationState = Readonly<{
  organizationId?: OrganizationId;
  legalName?: string;
  isCreated: boolean;
}>;

export type CreateOrganizationCommand = Readonly<{
  type: "CreateOrganization";
  organizationId: OrganizationId;
  legalName: string;
}>;

export type RenameOrganizationCommand = Readonly<{
  type: "RenameOrganization";
  legalName: string;
}>;

export type OrganizationCommand =
  | CreateOrganizationCommand
  | RenameOrganizationCommand;

export type OrganizationCreated = DomainEvent<
  "identity.organization.created.v1",
  Readonly<{
    organizationId: OrganizationId;
    legalName: string;
  }>
>;

export type OrganizationRenamed = DomainEvent<
  "identity.organization.renamed.v1",
  Readonly<{
    legalName: string;
  }>
>;

export type OrganizationEvent = OrganizationCreated | OrganizationRenamed;

export function initialOrganizationState(): OrganizationState {
  return {
    isCreated: false,
  };
}

export const evolveOrganization: AggregateEvolver<
  OrganizationState,
  OrganizationEvent
> = (state, event) => {
  switch (event.type) {
    case "identity.organization.created.v1":
      return {
        organizationId: event.data.organizationId,
        legalName: event.data.legalName,
        isCreated: true,
      };
    case "identity.organization.renamed.v1":
      return {
        ...state,
        legalName: event.data.legalName,
      };
    default:
      return assertNever(event);
  }
};

export const decideOrganization: AggregateDecider<
  OrganizationState,
  OrganizationCommand,
  OrganizationEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateOrganization":
      if (state.isCreated) {
        throw new Error("Organization already exists.");
      }

      return [
        {
          type: "identity.organization.created.v1",
          data: {
            organizationId: command.organizationId,
            legalName: command.legalName,
          },
        },
      ];

    case "RenameOrganization":
      if (!state.isCreated) {
        throw new Error("Organization does not exist.");
      }

      if (state.legalName === command.legalName) {
        return [];
      }

      return [
        {
          type: "identity.organization.renamed.v1",
          data: {
            legalName: command.legalName,
          },
        },
      ];

    default:
      return assertNever(command);
  }
};

export const organizationEventCodec: DomainEventCodec<OrganizationEvent> =
  createPassthroughDomainEventCodec<OrganizationEvent>();

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
