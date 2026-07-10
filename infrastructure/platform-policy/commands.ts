import type { CreatePolicyDocumentCommand, PolicyDocumentStatus, RevisePolicyDocumentCommand } from "./domain";
import { encodePolicyValue, type PolicyDefinition } from "./define-policy";

export type CreatePolicyDocumentParams<Value> = Readonly<{
  documentId: string;
  value: Value;
  status: PolicyDocumentStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  actorUserId: string;
}>;

export type RevisePolicyDocumentParams<Value> = Readonly<{
  value: Value;
  status: PolicyDocumentStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  actorUserId: string;
}>;

/**
 * Builds a validated `CreatePolicyDocument` command for `definition`. The
 * value is round-tripped through JSON and re-validated with
 * `definition.decodeValue` so what gets persisted is exactly what the
 * resolver will later decode back out -- there is no separate "encoded"
 * shape that could drift from the validated one.
 */
export function buildCreatePolicyDocumentCommand<Value>(
  definition: PolicyDefinition<Value>,
  params: CreatePolicyDocumentParams<Value>,
): CreatePolicyDocumentCommand {
  const value = encodePolicyValue(params.value);
  definition.decodeValue(value);

  return {
    type: "CreatePolicyDocument",
    documentId: params.documentId,
    policyKey: definition.policyKey,
    contextName: definition.contextName,
    schemaSummary: definition.schemaSummary,
    status: params.status,
    value,
    effectiveFrom: params.effectiveFrom,
    effectiveUntil: params.effectiveUntil,
    actorUserId: params.actorUserId,
  };
}

export function buildRevisePolicyDocumentCommand<Value>(
  definition: PolicyDefinition<Value>,
  params: RevisePolicyDocumentParams<Value>,
): RevisePolicyDocumentCommand {
  const value = encodePolicyValue(params.value);
  definition.decodeValue(value);

  return {
    type: "RevisePolicyDocument",
    status: params.status,
    value,
    effectiveFrom: params.effectiveFrom,
    effectiveUntil: params.effectiveUntil,
    actorUserId: params.actorUserId,
  };
}
