import type { FormActionContext } from "@chase-sets/platform-runtime/http";
import { data } from "react-router";
import { actionFields, actionTargetField, routeActions, parseAttemptKey } from "../domain/contract";
import type { MutationResult } from "./runtime";

type AccountActionArgs = Pick<FormActionContext, "request" | "params" | "context">;
export function requireInterruptionSafeClient(action: (args: AccountActionArgs) => unknown | Promise<unknown>) {
  return async (args: AccountActionArgs): Promise<unknown> => {
    try {
      parseAttemptKey(args.request.headers.get("Idempotency-Key"));
      if (
        args.request.headers.get("Accept") !== "text/x-script" ||
        args.request.headers.get("Sec-Fetch-Dest") === "document"
      )
        throw new Error("INDETERMINATE");
      const form = await args.request.clone().formData();
      const intent = form.get("intent");
      if (typeof intent !== "string" || !Object.hasOwn(actionFields, intent)) throw new Error("INDETERMINATE");
      const path = new URL(args.request.url).pathname.replace(/\.data$/, "");
      if (
        !Object.hasOwn(routeActions, path) ||
        !(routeActions[path as keyof typeof routeActions] as readonly string[]).includes(intent)
      )
        throw new Error("INDETERMINATE");
      const known = intent as keyof typeof actionFields;
      const allowed = [
        "intent",
        ...actionFields[known].filter((field) => !["userId", "accountId", "invitationId", "expiresAt"].includes(field)),
        ...(actionTargetField[known] ? [actionTargetField[known]] : []),
        ...(intent === "create-api-key" ? ["purpose"] : []),
      ];
      const seen = new Set<string>();
      for (const [name, value] of form) {
        if (!allowed.includes(name) || typeof value !== "string" || value.length > 1000 || seen.has(name))
          throw new Error("INDETERMINATE");
        seen.add(name);
      }
    } catch {
      return Response.json(
        { outcome: "not-recorded", code: "interruption-safe-client-required" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const result = await action(args);
    if (result instanceof Response) {
      result.headers.set("Cache-Control", "no-store");
      return result;
    }
    if (
      result &&
      typeof result === "object" &&
      "type" in result &&
      result.type === "DataWithResponseInit" &&
      "data" in result &&
      "init" in result
    ) {
      const init = result.init as ResponseInit | undefined;
      const headers = new Headers(init?.headers);
      headers.set("Cache-Control", "no-store");
      return data(result.data, { ...init, headers });
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  };
}

export function accountMutationResponse(result: MutationResult, destination: string, freshDestination = destination) {
  if (result.outcome !== "committed")
    return Response.json(result, {
      status: result.outcome === "conflict" ? 409 : result.outcome === "not-recorded" ? 400 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  return Response.json(
    { ...result, destination: result.destination ?? freshDestination },
    { headers: { "Cache-Control": "no-store" } },
  );
}
