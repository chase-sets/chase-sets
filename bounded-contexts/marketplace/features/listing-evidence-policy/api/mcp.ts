import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { readMcpStringArgument, type McpToolHandler, type McpToolHandlerInput } from "@chase-sets/platform-runtime/mcp";
import type { ListingEvidencePolicyRule } from "../domain/policy";
import type { ListingEvidencePolicyRuntime } from "./runtime";

export type ListingEvidencePolicyMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
}>;

function requireOperatorActor(actor: McpToolHandlerInput["actor"], permission: string) {
  if (!actor) {
    throw new Error("An authenticated operator actor is required.");
  }
  if (!actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
  return actor;
}

function requiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function requiredRules(args: Readonly<Record<string, unknown>>): readonly ListingEvidencePolicyRule[] {
  if (!Array.isArray(args.rules)) throw new Error("rules must be a list.");
  return args.rules as readonly ListingEvidencePolicyRule[];
}

function rejectUnknownArguments(args: Readonly<Record<string, unknown>>, allowed: readonly string[]) {
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown Listing Evidence Policy argument '${unknown}'.`);
}

export function createListingEvidencePolicyMcpHandlers(
  runtime: ListingEvidencePolicyRuntime,
): ListingEvidencePolicyMcpHandlers {
  const getOverview: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectUnknownArguments(args, []);
    requireOperatorActor(actor, "listing-evidence-policy.view");
    return runtime.getOverview();
  };

  const getSelectors: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectUnknownArguments(args, []);
    requireOperatorActor(actor, "listing-evidence-policy.view");
    return runtime.loadSelectorCatalog();
  };

  const createDraft: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectUnknownArguments(args, ["policyName", "rules", "idempotencyKey", "confirmationText"]);
    const scopedActor = requireOperatorActor(actor, "listing-evidence-policy.draft");
    const result = await runtime.createDraft(
      {
        policyName: requiredString(args, "policyName"),
        rules: requiredRules(args),
        actorUserId: scopedActor.userId,
      },
      createActorEventStoreContext(scopedActor),
    );
    return { policyId: result.documentId, version: result.version, lifecycle: "draft" };
  };

  const validateDraft: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectUnknownArguments(args, ["policyId", "idempotencyKey", "confirmationText"]);
    const scopedActor = requireOperatorActor(actor, "listing-evidence-policy.validate");
    return runtime.validateDraft(
      requiredString(args, "policyId"),
      scopedActor.userId,
      createActorEventStoreContext(scopedActor),
    );
  };

  const rejectDraft: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectUnknownArguments(args, ["policyId", "idempotencyKey", "confirmationText"]);
    const scopedActor = requireOperatorActor(actor, "listing-evidence-policy.draft");
    return runtime.rejectDraft(
      requiredString(args, "policyId"),
      scopedActor.userId,
      createActorEventStoreContext(scopedActor),
    );
  };

  const createRollbackDraft: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectUnknownArguments(args, ["policyId", "idempotencyKey", "confirmationText"]);
    const scopedActor = requireOperatorActor(actor, "listing-evidence-policy.draft");
    const result = await runtime.createRollbackDraft(
      requiredString(args, "policyId"),
      scopedActor.userId,
      createActorEventStoreContext(scopedActor),
    );
    return { policyId: result.documentId, version: result.version, lifecycle: "draft" };
  };

  const activateDraft: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectUnknownArguments(args, [
      "policyId",
      "effectiveFrom",
      "effectiveUntil",
      "impactAcknowledgmentHash",
      "idempotencyKey",
      "confirmationText",
    ]);
    const scopedActor = requireOperatorActor(actor, "listing-evidence-policy.activate");
    return runtime.activateDraft(
      requiredString(args, "policyId"),
      {
        effectiveFrom: requiredString(args, "effectiveFrom"),
        effectiveUntil: readMcpStringArgument(args, "effectiveUntil"),
        impactAcknowledgmentHash: requiredString(args, "impactAcknowledgmentHash"),
        actorUserId: scopedActor.userId,
      },
      createActorEventStoreContext(scopedActor),
    );
  };

  return {
    toolHandlers: {
      "marketplace.activate-listing-evidence-policy-draft": activateDraft,
      "marketplace.create-listing-evidence-policy-draft": createDraft,
      "marketplace.create-listing-evidence-policy-rollback-draft": createRollbackDraft,
      "marketplace.get-listing-evidence-policy-overview": getOverview,
      "marketplace.get-listing-evidence-policy-selectors": getSelectors,
      "marketplace.reject-listing-evidence-policy-draft": rejectDraft,
      "marketplace.validate-listing-evidence-policy-draft": validateDraft,
    },
  };
}
