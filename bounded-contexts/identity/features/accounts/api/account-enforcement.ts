import {
  accountEnforcementReasonCodes,
  accountEnforcementReversalReasonCodes,
  type AccountEnforcementReference,
} from "@chase-sets/event-core";
import { createId, parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountCommand } from "../domain/domain";
import type { AccountServices } from "./runtime";
import type { AccountEnforcementRequest } from "./contracts";

export type AccountEnforcementAction = "suspend" | "reactivate" | "close";

export async function readAccountEnforcementRequest<Reason extends string>(
  request: Request,
  allowedReasons: readonly Reason[],
): Promise<AccountEnforcementRequest<Reason>> {
  const rawBody = await request.text();
  if (rawBody.length === 0) {
    return { reason: "operator-other" as Reason, reference: null };
  }

  const value: unknown = JSON.parse(rawBody);
  if (!isRecord(value)) {
    throw new Error("Account enforcement request must be a JSON object.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    return { reason: "operator-other" as Reason, reference: null };
  }
  if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "reference") {
    throw new Error("Account enforcement request must contain exactly reason and reference.");
  }
  if (typeof value.reason !== "string" || !allowedReasons.includes(value.reason as Reason)) {
    throw new Error("Account enforcement reason is invalid for this action.");
  }

  return {
    reason: value.reason as Reason,
    reference: readAccountEnforcementReference(value.reference),
  };
}

export function readAccountEnforcementReference(value: unknown): AccountEnforcementReference | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("Account enforcement reference is invalid.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "supportRequestId") {
    throw new Error("Account enforcement reference is invalid.");
  }
  if (value.kind !== "support-request" || typeof value.supportRequestId !== "string") {
    throw new Error("Account enforcement reference is invalid.");
  }
  return {
    kind: "support-request",
    supportRequestId: parseStrictTypedUlid(value.supportRequestId, "sup"),
  };
}

export function accountEnforcementCommand<Reason extends string>(
  action: AccountEnforcementAction,
  request: AccountEnforcementRequest<Reason>,
): AccountCommand {
  const enforcement = { version: 1 as const, enforcementActionId: createId("enf"), ...request };
  switch (action) {
    case "suspend":
      return { type: "SuspendAccount", enforcement } as AccountCommand;
    case "reactivate":
      return { type: "ReactivateAccount", enforcement } as AccountCommand;
    case "close":
      return { type: "CloseAccount", enforcement } as AccountCommand;
  }
}

export async function submitAccountEnforcement<Reason extends string>(
  services: Pick<AccountServices, "commandHandler">,
  accountId: string,
  action: AccountEnforcementAction,
  request: AccountEnforcementRequest<Reason>,
  context: EventStoreContext,
) {
  return services.commandHandler({
    streamId: `identity.account-${accountId}`,
    command: accountEnforcementCommand(action, request),
    context,
  });
}

export const accountEnforcementReasons = {
  suspend: accountEnforcementReasonCodes,
  reactivate: accountEnforcementReversalReasonCodes,
  close: accountEnforcementReasonCodes,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
