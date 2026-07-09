import type { WorkerHostRuntime } from "@chase-sets/platform-runtime/worker";
import { describe, expect, it } from "vitest";
import { createAgentWebhookDispatchRunners } from "../src/agent-webhook-runners";

describe("agent webhook worker runners", () => {
  it("registers the Auth agent webhook dispatcher as a platform-worker job", () => {
    const runners = createAgentWebhookDispatchRunners(createRuntimeWithAuth(), { workerId: "worker_1" });

    expect(runners).toHaveLength(1);
    expect(runners[0]).toMatchObject({
      name: "auth.agent-webhook-dispatcher",
      kind: "job",
    });
  });

  it("does not register the dispatcher when Auth is not mounted", () => {
    const runtime = {
      mountedContexts: [],
      services: {},
      projectionGroups: [],
      subscriptionRunners: [],
    } as unknown as WorkerHostRuntime;

    expect(createAgentWebhookDispatchRunners(runtime, { workerId: "worker_1" })).toEqual([]);
  });
});

function createRuntimeWithAuth(): WorkerHostRuntime {
  const fail = () => {
    throw new Error("agent webhook runner registration test must not query the database");
  };

  return {
    mountedContexts: [
      {
        contextName: "auth",
        services: {},
        module: {} as never,
        pool: {
          query: fail,
          connect: fail,
        } as never,
        projectionHandlerSets: [],
      },
    ],
    services: {},
    projectionGroups: [],
    subscriptionRunners: [],
  } as unknown as WorkerHostRuntime;
}
