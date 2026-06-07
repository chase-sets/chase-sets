import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { defaultPostagePolicy, type PostagePolicy, type ProductPhysicalFlag } from "@chase-sets/product-measures";
import {
  OrderingDomainError,
  assert,
  assertNever,
  normalizeRequiredText,
  type ShippingOption,
} from "../../orders/domain/common";

export type PostagePolicyStatus = "draft" | "active" | "retired";

export type OrderingPostagePolicyPayload = PostagePolicy;

export type PostagePolicyState = Readonly<{
  policyId: string | null;
  label: string | null;
  status: PostagePolicyStatus | null;
  payload: OrderingPostagePolicyPayload | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  createdByUserId: string | null;
  activationReason: string | null;
}>;

export const initialPostagePolicyState: PostagePolicyState = {
  policyId: null,
  label: null,
  status: null,
  payload: null,
  effectiveFrom: null,
  effectiveUntil: null,
  createdByUserId: null,
  activationReason: null,
};

export type CreatePostagePolicyCommand = Readonly<{
  type: "CreatePostagePolicy";
  policyId: string;
  label: string;
  payload: Partial<OrderingPostagePolicyPayload>;
  effectiveFrom: string;
  effectiveUntil: string | null;
  createdByUserId: string;
}>;

export type RevisePostagePolicyCommand = Readonly<{
  type: "RevisePostagePolicy";
  label: string;
  payload: Partial<OrderingPostagePolicyPayload>;
  effectiveFrom: string;
  effectiveUntil: string | null;
  revisedByUserId: string;
}>;

export type ActivatePostagePolicyCommand = Readonly<{
  type: "ActivatePostagePolicy";
  activatedByUserId: string;
  activationReason: string;
}>;

export type RetirePostagePolicyCommand = Readonly<{
  type: "RetirePostagePolicy";
  retiredByUserId: string;
  retirementReason: string;
}>;

export type PostagePolicyCommand =
  | CreatePostagePolicyCommand
  | RevisePostagePolicyCommand
  | ActivatePostagePolicyCommand
  | RetirePostagePolicyCommand;

export type PostagePolicyCreatedEvent = DomainEvent<
  "ordering.postage-policy.created",
  Readonly<{
    policyId: string;
    label: string;
    status: PostagePolicyStatus;
    payload: OrderingPostagePolicyPayload;
    effectiveFrom: string;
    effectiveUntil: string | null;
    createdByUserId: string;
  }>
>;

export type PostagePolicyRevisedEvent = DomainEvent<
  "ordering.postage-policy.revised",
  Readonly<{
    policyId: string;
    label: string;
    payload: OrderingPostagePolicyPayload;
    effectiveFrom: string;
    effectiveUntil: string | null;
    revisedByUserId: string;
  }>
>;

export type PostagePolicyActivatedEvent = DomainEvent<
  "ordering.postage-policy.activated",
  Readonly<{
    policyId: string;
    activatedByUserId: string;
    activationReason: string;
  }>
>;

export type PostagePolicyRetiredEvent = DomainEvent<
  "ordering.postage-policy.retired",
  Readonly<{
    policyId: string;
    retiredByUserId: string;
    retirementReason: string;
  }>
>;

export type PostagePolicyEvent =
  | PostagePolicyCreatedEvent
  | PostagePolicyRevisedEvent
  | PostagePolicyActivatedEvent
  | PostagePolicyRetiredEvent;

const shippingOptions: readonly ShippingOption[] = ["standard", "expedited", "priority"];
const physicalFlags: readonly ProductPhysicalFlag[] = [
  "raw-card",
  "slab",
  "sealed",
  "rigid",
  "bendable",
  "metal",
  "jumbo",
  "irregular",
];

function normalizeNumber(value: unknown, fieldName: string, options: Readonly<{ allowZero?: boolean }> = {}) {
  const numeric = typeof value === "number" ? value : Number(value);
  assert(Number.isFinite(numeric), `${fieldName} must be numeric.`);
  assert(
    options.allowZero ? numeric >= 0 : numeric > 0,
    `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
  );
  return numeric;
}

function normalizeOptionList(value: readonly unknown[] | undefined, allowed: readonly string[], fieldName: string) {
  const list = [
    ...new Set((value ?? []).map((entry) => normalizeRequiredText(String(entry), `${fieldName} is required.`))),
  ];
  for (const entry of list) {
    assert(allowed.includes(entry), `${fieldName} includes an unsupported value.`);
  }
  return list;
}

function normalizePolicyPayload(payload: Partial<OrderingPostagePolicyPayload>): OrderingPostagePolicyPayload {
  return {
    ...defaultPostagePolicy,
    policyVersion: normalizeRequiredText(
      payload.policyVersion ?? defaultPostagePolicy.policyVersion,
      "Policy version is required.",
    ),
    maxLetterUnits: normalizeNumber(payload.maxLetterUnits ?? defaultPostagePolicy.maxLetterUnits, "Max letter units"),
    maxLetterWeightOunces: normalizeNumber(
      payload.maxLetterWeightOunces ?? defaultPostagePolicy.maxLetterWeightOunces,
      "Max letter weight",
    ),
    maxLetterThicknessInches: normalizeNumber(
      payload.maxLetterThicknessInches ?? defaultPostagePolicy.maxLetterThicknessInches,
      "Max letter thickness",
    ),
    maxLetterDeclaredValueAmount: normalizeNumber(
      payload.maxLetterDeclaredValueAmount ?? defaultPostagePolicy.maxLetterDeclaredValueAmount,
      "Max letter declared value",
      { allowZero: true },
    ),
    letterEnvelopeWeightOunces: normalizeNumber(
      payload.letterEnvelopeWeightOunces ?? defaultPostagePolicy.letterEnvelopeWeightOunces,
      "Letter envelope weight",
      { allowZero: true },
    ),
    parcelPackagingWeightOunces: normalizeNumber(
      payload.parcelPackagingWeightOunces ?? defaultPostagePolicy.parcelPackagingWeightOunces,
      "Parcel packaging weight",
      { allowZero: true },
    ),
    parcelRequiredShippingOptions: normalizeOptionList(
      payload.parcelRequiredShippingOptions,
      shippingOptions,
      "Parcel-required shipping option",
    ) as ShippingOption[],
    letterRequiredPhysicalFlags: normalizeOptionList(
      payload.letterRequiredPhysicalFlags,
      physicalFlags,
      "Letter-required physical flag",
    ) as ProductPhysicalFlag[],
    parcelRequiredPhysicalFlags: normalizeOptionList(
      payload.parcelRequiredPhysicalFlags,
      physicalFlags,
      "Parcel-required physical flag",
    ) as ProductPhysicalFlag[],
    signatureRequiredShippingOptions: normalizeOptionList(
      payload.signatureRequiredShippingOptions,
      shippingOptions,
      "Signature-required shipping option",
    ) as ShippingOption[],
    signatureRequiredDeclaredValueAmount:
      payload.signatureRequiredDeclaredValueAmount == null
        ? null
        : normalizeNumber(payload.signatureRequiredDeclaredValueAmount, "Signature-required declared value", {
            allowZero: true,
          }),
    signatureRequiredPhysicalFlags: normalizeOptionList(
      payload.signatureRequiredPhysicalFlags,
      physicalFlags,
      "Signature-required physical flag",
    ) as ProductPhysicalFlag[],
  };
}

function normalizeEffectiveFrom(value: string) {
  const normalized = normalizeRequiredText(value, "Effective from is required.");
  const parsed = Date.parse(normalized);
  assert(Number.isFinite(parsed), "Effective from must be an ISO timestamp.");
  return normalized;
}

function normalizeEffectiveUntil(effectiveFrom: string, effectiveUntil: string | null) {
  if (!effectiveUntil || effectiveUntil.trim().length === 0) {
    return null;
  }
  const normalized = effectiveUntil.trim();
  assert(Number.isFinite(Date.parse(normalized)), "Effective until must be an ISO timestamp.");
  assert(Date.parse(normalized) > Date.parse(effectiveFrom), "Effective until must be after effective from.");
  return normalized;
}

export const decidePostagePolicy: AggregateDecider<PostagePolicyState, PostagePolicyCommand, PostagePolicyEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "CreatePostagePolicy": {
      assert(state.policyId === null, "Postage policy has already been created.");
      const effectiveFrom = normalizeEffectiveFrom(command.effectiveFrom);
      return [
        {
          type: "ordering.postage-policy.created",
          data: {
            policyId: normalizeRequiredText(command.policyId, "Policy id is required."),
            label: normalizeRequiredText(command.label, "Policy label is required."),
            status: "draft",
            payload: normalizePolicyPayload(command.payload),
            effectiveFrom,
            effectiveUntil: normalizeEffectiveUntil(effectiveFrom, command.effectiveUntil),
            createdByUserId: normalizeRequiredText(command.createdByUserId, "Created by user is required."),
          },
        },
      ];
    }
    case "RevisePostagePolicy": {
      assert(state.policyId !== null, "Postage policy must be created before it can be revised.");
      assert(state.status !== "retired", "Retired postage policies cannot be revised.");
      const effectiveFrom = normalizeEffectiveFrom(command.effectiveFrom);
      return [
        {
          type: "ordering.postage-policy.revised",
          data: {
            policyId: state.policyId,
            label: normalizeRequiredText(command.label, "Policy label is required."),
            payload: normalizePolicyPayload(command.payload),
            effectiveFrom,
            effectiveUntil: normalizeEffectiveUntil(effectiveFrom, command.effectiveUntil),
            revisedByUserId: normalizeRequiredText(command.revisedByUserId, "Revised by user is required."),
          },
        },
      ];
    }
    case "ActivatePostagePolicy":
      assert(state.policyId !== null, "Postage policy must be created before it can be activated.");
      assert(state.status !== "retired", "Retired postage policies cannot be activated.");
      return [
        {
          type: "ordering.postage-policy.activated",
          data: {
            policyId: state.policyId,
            activatedByUserId: normalizeRequiredText(command.activatedByUserId, "Activated by user is required."),
            activationReason: normalizeRequiredText(command.activationReason, "Activation reason is required."),
          },
        },
      ];
    case "RetirePostagePolicy":
      assert(state.policyId !== null, "Postage policy must be created before it can be retired.");
      assert(state.status !== "retired", "Postage policy is already retired.");
      return [
        {
          type: "ordering.postage-policy.retired",
          data: {
            policyId: state.policyId,
            retiredByUserId: normalizeRequiredText(command.retiredByUserId, "Retired by user is required."),
            retirementReason: normalizeRequiredText(command.retirementReason, "Retirement reason is required."),
          },
        },
      ];
    default:
      throw assertNever(command as never);
  }
};

export const evolvePostagePolicy: AggregateEvolver<PostagePolicyState, PostagePolicyEvent> = (state, event) => {
  switch (event.type) {
    case "ordering.postage-policy.created":
      return {
        policyId: event.data.policyId,
        label: event.data.label,
        status: event.data.status,
        payload: event.data.payload,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
        createdByUserId: event.data.createdByUserId,
        activationReason: null,
      };
    case "ordering.postage-policy.revised":
      return {
        ...state,
        label: event.data.label,
        payload: event.data.payload,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    case "ordering.postage-policy.activated":
      return {
        ...state,
        status: "active",
        activationReason: event.data.activationReason,
      };
    case "ordering.postage-policy.retired":
      return {
        ...state,
        status: "retired",
      };
    default:
      throw assertNever(event as never);
  }
};

export function mapPostagePolicyDomainError(error: unknown) {
  return error instanceof OrderingDomainError
    ? error.message
    : error instanceof Error
      ? error.message
      : "Request failed.";
}
