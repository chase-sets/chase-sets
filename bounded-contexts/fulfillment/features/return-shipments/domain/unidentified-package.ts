import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { ReturnShipmentId, UnidentifiedReturnPackageId } from "@chase-sets/primitives/typed-ids";
import { assert, assertNever, ensureIsoTimestamp, normalizeOptionalText, normalizeRequiredText } from "./common";
import {
  normalizeReturnIntakeEvidence,
  returnIntakePackageConditions,
  returnIntakeSealConditions,
  type ReturnIntakeEvidenceAttachment,
  type ReturnIntakePackageCondition,
  type ReturnIntakeSealCondition,
} from "./facility-intake";

export type UnidentifiedReturnPackageState = Readonly<{
  unidentifiedPackageId: UnidentifiedReturnPackageId | null;
  facilityId: string | null;
  stationId: string | null;
  operatorUserId: string | null;
  receivedAt: string | null;
  packageCondition: ReturnIntakePackageCondition | null;
  sealCondition: ReturnIntakeSealCondition | null;
  measuredWeightOunces: number | null;
  evidence: readonly ReturnIntakeEvidenceAttachment[];
  custodyIdentifier: string | null;
  notes: string | null;
  owner: string | null;
  nextAction: string | null;
  returnShipmentId: ReturnShipmentId | null;
  reconciledAt: string | null;
  reconciliationReason: string | null;
}>;

export const initialUnidentifiedReturnPackageState: UnidentifiedReturnPackageState = {
  unidentifiedPackageId: null,
  facilityId: null,
  stationId: null,
  operatorUserId: null,
  receivedAt: null,
  packageCondition: null,
  sealCondition: null,
  measuredWeightOunces: null,
  evidence: [],
  custodyIdentifier: null,
  notes: null,
  owner: null,
  nextAction: null,
  returnShipmentId: null,
  reconciledAt: null,
  reconciliationReason: null,
};

export type RecordUnidentifiedReturnPackageCommand = Readonly<{
  type: "RecordUnidentifiedReturnPackage";
  unidentifiedPackageId: UnidentifiedReturnPackageId;
  facilityId: string;
  stationId: string;
  operatorUserId: string;
  receivedAt: string;
  packageCondition: string;
  sealCondition: string;
  measuredWeightOunces: number | null;
  evidence: readonly ReturnIntakeEvidenceAttachment[];
  custodyIdentifier: string;
  notes: string | null;
  owner: string;
  nextAction: string;
}>;

export type ReconcileUnidentifiedReturnPackageCommand = Readonly<{
  type: "ReconcileUnidentifiedReturnPackage";
  returnShipmentId: ReturnShipmentId;
  reconciledByUserId: string;
  reconciledAt: string;
  reason: string;
}>;

export type UnidentifiedReturnPackageCommand =
  | RecordUnidentifiedReturnPackageCommand
  | ReconcileUnidentifiedReturnPackageCommand;

export type UnidentifiedReturnPackageRecordedEvent = DomainEvent<
  "fulfillment.unidentified-return-package.recorded.v1",
  Readonly<{
    unidentifiedPackageId: UnidentifiedReturnPackageId;
    facilityId: string;
    stationId: string;
    operatorUserId: string;
    receivedAt: string;
    packageCondition: ReturnIntakePackageCondition;
    sealCondition: ReturnIntakeSealCondition;
    measuredWeightOunces: number | null;
    evidence: readonly ReturnIntakeEvidenceAttachment[];
    custodyIdentifier: string;
    notes: string | null;
    owner: string;
    nextAction: string;
  }>
>;

export type UnidentifiedReturnPackageReconciledEvent = DomainEvent<
  "fulfillment.unidentified-return-package.reconciled.v1",
  Readonly<{
    unidentifiedPackageId: UnidentifiedReturnPackageId;
    returnShipmentId: ReturnShipmentId;
    reconciledByUserId: string;
    reconciledAt: string;
    reason: string;
  }>
>;

export type UnidentifiedReturnPackageEvent =
  | UnidentifiedReturnPackageRecordedEvent
  | UnidentifiedReturnPackageReconciledEvent;

function oneOf<const T extends readonly string[]>(value: string, values: T, message: string): T[number] {
  const normalized = value.trim().toLowerCase();
  assert(values.includes(normalized), message);
  return normalized as T[number];
}

export const decideUnidentifiedReturnPackage: AggregateDecider<
  UnidentifiedReturnPackageState,
  UnidentifiedReturnPackageCommand,
  UnidentifiedReturnPackageEvent
> = (state, command) => {
  switch (command.type) {
    case "RecordUnidentifiedReturnPackage": {
      if (state.unidentifiedPackageId !== null) {
        assert(
          state.unidentifiedPackageId === command.unidentifiedPackageId,
          "Unidentified package stream cannot be reused for a different package.",
        );
        return [];
      }
      const receivedAt = ensureIsoTimestamp(
        command.receivedAt,
        "Unidentified package receipt must record a timestamp.",
      );
      assert(command.evidence.length > 0, "An unidentified package requires at least one evidence attachment.");
      const evidence = command.evidence.map((attachment) => normalizeReturnIntakeEvidence(attachment, receivedAt));
      assert(
        new Set(evidence.map((attachment) => attachment.attachmentId)).size === evidence.length,
        "Evidence ids must be unique.",
      );
      assert(
        command.measuredWeightOunces === null ||
          (Number.isFinite(command.measuredWeightOunces) && command.measuredWeightOunces > 0),
        "Measured weight must be positive when recorded.",
      );
      return [
        {
          type: "fulfillment.unidentified-return-package.recorded.v1",
          data: {
            unidentifiedPackageId: command.unidentifiedPackageId,
            facilityId: normalizeRequiredText(command.facilityId, "Facility is required."),
            stationId: normalizeRequiredText(command.stationId, "Station is required."),
            operatorUserId: normalizeRequiredText(command.operatorUserId, "Operator is required."),
            receivedAt,
            packageCondition: oneOf(
              command.packageCondition,
              returnIntakePackageConditions,
              "Package condition is invalid.",
            ),
            sealCondition: oneOf(command.sealCondition, returnIntakeSealConditions, "Seal condition is invalid."),
            measuredWeightOunces: command.measuredWeightOunces,
            evidence,
            custodyIdentifier: normalizeRequiredText(command.custodyIdentifier, "Custody identifier is required."),
            notes: normalizeOptionalText(command.notes),
            owner: normalizeRequiredText(command.owner, "An unidentified package requires an owner."),
            nextAction: normalizeRequiredText(command.nextAction, "An unidentified package requires a next action."),
          },
        },
      ];
    }
    case "ReconcileUnidentifiedReturnPackage":
      assert(state.unidentifiedPackageId !== null, "Unidentified package must be recorded first.");
      if (state.returnShipmentId !== null) {
        assert(
          state.returnShipmentId === command.returnShipmentId,
          "Package is already reconciled to another return shipment.",
        );
        return [];
      }
      return [
        {
          type: "fulfillment.unidentified-return-package.reconciled.v1",
          data: {
            unidentifiedPackageId: state.unidentifiedPackageId,
            returnShipmentId: command.returnShipmentId,
            reconciledByUserId: normalizeRequiredText(
              command.reconciledByUserId,
              "Reconciliation operator is required.",
            ),
            reconciledAt: ensureIsoTimestamp(command.reconciledAt, "Reconciliation must record a timestamp."),
            reason: normalizeRequiredText(command.reason, "Reconciliation reason is required."),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveUnidentifiedReturnPackage: AggregateEvolver<
  UnidentifiedReturnPackageState,
  UnidentifiedReturnPackageEvent
> = (state, event) => {
  switch (event.type) {
    case "fulfillment.unidentified-return-package.recorded.v1":
      return {
        ...initialUnidentifiedReturnPackageState,
        ...event.data,
      };
    case "fulfillment.unidentified-return-package.reconciled.v1":
      return {
        ...state,
        returnShipmentId: event.data.returnShipmentId,
        reconciledAt: event.data.reconciledAt,
        reconciliationReason: event.data.reason,
      };
    default:
      return assertNever(event);
  }
};
