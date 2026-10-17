import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { PostagePolicy, ProductPhysicalFlag, ShippingOption } from "@chase-sets/product-measures";
import type { PostagePolicyServices } from "./runtime";

export type OrderingPostagePolicyMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

type Actor = Parameters<typeof createActorEventStoreContext>[0];

function requiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function requiredNumber(args: Readonly<Record<string, unknown>>, key: string) {
  const raw = args[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be numeric.`);
  return value;
}

function parsedNumber(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return requiredNumber(args, key);
}

function optionalNumber(args: Readonly<Record<string, unknown>>, key: string) {
  const raw = args[key];
  if (raw === undefined || raw === "") return undefined;
  if (raw === null) return null;
  return requiredNumber(args, key);
}

function requiredArray<T extends string>(args: Readonly<Record<string, unknown>>, key: string): T[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array.`);
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) throw new Error(`${key} must contain strings.`);
    return entry.trim() as T;
  });
}

function optionalPositiveInteger(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
  return value;
}

function optionalNonNegativeInteger(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer.`);
  return value;
}

function numericWithDefault(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  return parsedNumber(args, key, fallback);
}

function requirePermission(actor: Actor | null, permission: string): Actor {
  if (!actor || !actor.permissions.includes(permission)) throw new Error(`Missing required permission: ${permission}.`);
  return actor;
}

function policyPayload(args: Readonly<Record<string, unknown>>): Partial<PostagePolicy> {
  return {
    policyVersion: readMcpStringArgument(args, "policyVersion") ?? "",
    maxLetterUnits: parsedNumber(args, "maxLetterUnits", 0),
    maxLetterWeightOunces: parsedNumber(args, "maxLetterWeightOunces", 0),
    maxLetterThicknessInches: parsedNumber(args, "maxLetterThicknessInches", 0),
    maxLetterDeclaredValueAmount: parsedNumber(args, "maxLetterDeclaredValueAmount", 0),
    letterEnvelopeWeightOunces: parsedNumber(args, "letterEnvelopeWeightOunces", 0),
    parcelPackagingWeightOunces: parsedNumber(args, "parcelPackagingWeightOunces", 0),
    parcelRequiredShippingOptions: requiredArray<ShippingOption>(args, "parcelRequiredShippingOptions"),
    letterRequiredPhysicalFlags: requiredArray<ProductPhysicalFlag>(args, "letterRequiredPhysicalFlags"),
    parcelRequiredPhysicalFlags: requiredArray<ProductPhysicalFlag>(args, "parcelRequiredPhysicalFlags"),
    signatureRequiredShippingOptions: requiredArray<ShippingOption>(args, "signatureRequiredShippingOptions"),
    signatureRequiredDeclaredValueAmount: optionalNumber(args, "signatureRequiredDeclaredValueAmount"),
    signatureRequiredPhysicalFlags: requiredArray<ProductPhysicalFlag>(args, "signatureRequiredPhysicalFlags"),
    insuranceRequiredDeclaredValueAmount: optionalNumber(args, "insuranceRequiredDeclaredValueAmount"),
  };
}

function policyCommand(args: Readonly<Record<string, unknown>>) {
  return {
    label: readMcpStringArgument(args, "label") ?? "",
    payload: policyPayload(args),
    effectiveFrom: typeof args.effectiveFrom === "string" ? args.effectiveFrom : new Date().toISOString(),
    effectiveUntil: args.effectiveUntil === null ? null : readMcpStringArgument(args, "effectiveUntil"),
  };
}

function receipt(result: Readonly<{ policyId: string; version: number }>, status: "draft" | "active" | "retired") {
  return {
    id: result.policyId,
    policyId: result.policyId,
    version: result.version,
    status,
  };
}

export function createOrderingPostagePolicyMcpHandlers(
  services: PostagePolicyServices,
): OrderingPostagePolicyMcpHandlers {
  const listPolicies: McpToolHandler = async ({ actor, arguments: args }) => {
    requirePermission(actor, "postage-policies.view");
    const result = await services.listPolicies({
      limit: optionalPositiveInteger(args, "limit", 50),
      offset: optionalNonNegativeInteger(args, "offset", 0),
    });
    return { items: result.items, total: result.total, count: result.items.length };
  };

  const getPolicy: McpToolHandler = async ({ actor, arguments: args }) => {
    requirePermission(actor, "postage-policies.view");
    const policy = await services.getPolicy(readMcpTypedIdArgument(args, "id", "opp"));
    if (!policy) throw new Error("Postage policy not found.");
    return { policy };
  };

  const previewPolicy: McpToolHandler = ({ actor, arguments: args }) => {
    requirePermission(actor, "postage-policies.manage");
    const policy = args.policy;
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      throw new Error("policy is required.");
    }
    const policyArgs = policy as Readonly<Record<string, unknown>>;
    return {
      packagePlan: services.previewPolicy({
        policy: policyPayload(policyArgs),
        shippingOption: (readMcpStringArgument(args, "shippingOption") ?? "standard") as ShippingOption,
        itemSubtotalAmount: readMcpStringArgument(args, "itemSubtotalAmount") ?? "0",
        quantity: numericWithDefault(args, "quantity", 1),
        unitLengthInches: numericWithDefault(args, "unitLengthInches", 3.5),
        unitWidthInches: numericWithDefault(args, "unitWidthInches", 2.5),
        unitHeightInches: numericWithDefault(args, "unitHeightInches", 0.016),
        unitWeightOunces: numericWithDefault(args, "unitWeightOunces", 0.05),
        physicalFlags:
          requiredArray<ProductPhysicalFlag>(args, "physicalFlags").length > 0
            ? requiredArray<ProductPhysicalFlag>(args, "physicalFlags")
            : ["raw-card"],
      }),
    };
  };

  const createPolicy: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requirePermission(actor, "postage-policies.manage");
    const result = await services.createPolicy(
      { ...policyCommand(args), createdByUserId: scopedActor.userId },
      createActorEventStoreContext(scopedActor),
    );
    return receipt(result, "draft");
  };

  const revisePolicy: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requirePermission(actor, "postage-policies.manage");
    const policyId = readMcpTypedIdArgument(args, "id", "opp");
    const current = await services.getPolicy(policyId);
    if (!current) throw new Error("Postage policy not found.");
    const result = await services.revisePolicy(
      policyId,
      { ...policyCommand(args), revisedByUserId: scopedActor.userId },
      createActorEventStoreContext(scopedActor),
    );
    return receipt(result, current.status === "active" ? "active" : "draft");
  };

  const activatePolicy: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requirePermission(actor, "postage-policies.manage");
    const result = await services.activatePolicy(
      readMcpTypedIdArgument(args, "id", "opp"),
      { activatedByUserId: scopedActor.userId, activationReason: requiredString(args, "activationReason") },
      createActorEventStoreContext(scopedActor),
    );
    return receipt(result, "active");
  };

  const retirePolicy: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requirePermission(actor, "postage-policies.manage");
    const result = await services.retirePolicy(
      readMcpTypedIdArgument(args, "id", "opp"),
      { retiredByUserId: scopedActor.userId, retirementReason: requiredString(args, "retirementReason") },
      createActorEventStoreContext(scopedActor),
    );
    return receipt(result, "retired");
  };

  const clonePolicy: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requirePermission(actor, "postage-policies.manage");
    const policyId = readMcpTypedIdArgument(args, "id", "opp");
    const source = await services.getPolicy(policyId);
    if (!source) throw new Error("Postage policy not found.");
    const result = await services.clonePolicy(
      policyId,
      {
        label: typeof args.label === "string" ? args.label : "Rollback postage policy draft",
        effectiveFrom: typeof args.effectiveFrom === "string" ? args.effectiveFrom : new Date().toISOString(),
        effectiveUntil: args.effectiveUntil === null ? null : readMcpStringArgument(args, "effectiveUntil"),
        createdByUserId: scopedActor.userId,
      },
      createActorEventStoreContext(scopedActor),
    );
    return receipt(result, "draft");
  };

  return {
    toolHandlers: {
      "ordering.list-postage-policies": listPolicies,
      "ordering.get-postage-policy": getPolicy,
      "ordering.preview-postage-policy": previewPolicy,
      "ordering.create-postage-policy": createPolicy,
      "ordering.revise-postage-policy": revisePolicy,
      "ordering.activate-postage-policy": activatePolicy,
      "ordering.retire-postage-policy": retirePolicy,
      "ordering.clone-postage-policy": clonePolicy,
    },
    resourceHandlers: {},
  };
}
