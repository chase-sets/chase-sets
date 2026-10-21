import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { createReferenceRecord } from "./route";
import type { ReferenceDataServices } from "./runtime";

export type ReferenceDataMcpHandlers = Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }>;
function operator(actor: ResolvedActor | null): ResolvedActor {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes("catalog.manage")) {
    throw new Error("Missing required operator permission: catalog.manage.");
  }
  return actor;
}
function required(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}
export function createReferenceDataMcpHandlers(services: ReferenceDataServices): ReferenceDataMcpHandlers {
  const create: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor);
    const result = await createReferenceRecord(services, args, createActorEventStoreContext(scoped));
    return { referenceRecordId: result.referenceRecordId, ...result.result };
  };
  const publish: McpToolHandler = async ({ actor, arguments: args }) => {
    const scoped = operator(actor);
    const referenceRecordId = required(args, "referenceRecordId");
    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: { type: "PublishReferenceRecord" },
      context: createActorEventStoreContext(scoped),
    });
    return { referenceRecordId, ...result };
  };
  return { toolHandlers: { "catalog.create-reference-record": create, "catalog.publish-reference-record": publish } };
}
