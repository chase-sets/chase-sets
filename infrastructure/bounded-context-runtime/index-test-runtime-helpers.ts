import type { BcApiModule, BcProjectionGroupDeclaration } from "@chase-sets/bounded-context-module";
import type { MockPool } from "./index-test-harness";
import { createSubscriptionRunner, resolveModuleProjectionGroups } from "./index";

export function createProjectionGroupRuntime(
  targetContextName: string,
  targetPool: MockPool,
  projectionGroups: readonly BcProjectionGroupDeclaration[],
  runners: readonly ReturnType<typeof createSubscriptionRunner>[],
) {
  const module: Pick<BcApiModule, "contextName" | "projectionGroups"> = {
    contextName: targetContextName,
    projectionGroups,
  };

  return resolveModuleProjectionGroups(
    [
      {
        contextName: targetContextName,
        module: module as BcApiModule,
        services: {},
        pool: targetPool as never,
        projectionHandlerSets: [],
      },
    ],
    runners,
  );
}

export function createMountedRuntime(
  targetContextName: string,
  targetPool: MockPool,
  projectionGroups: readonly BcProjectionGroupDeclaration[],
  runners: readonly ReturnType<typeof createSubscriptionRunner>[],
) {
  const groupRuntime = createProjectionGroupRuntime(targetContextName, targetPool, projectionGroups, runners);

  return {
    mountedContexts: [
      {
        contextName: targetContextName,
        module: {
          contextName: targetContextName,
          projectionGroups,
        } as unknown as BcApiModule,
        services: {},
        pool: targetPool as never,
        projectionHandlerSets: [],
      },
    ],
    projectionGroups: groupRuntime,
    subscriptionRunners: runners,
  };
}

