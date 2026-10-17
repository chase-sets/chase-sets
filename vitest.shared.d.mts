import type { UserWorkspaceConfig } from "vitest/config";

export const boundedContextTestInclude: readonly string[];

export function resolveVitestLaneProfile(env?: NodeJS.ProcessEnv): {
  hookTimeout?: number;
  testTimeout?: number;
  maxWorkers?: number;
};

export function defineWorkspaceTestConfig(overrides?: UserWorkspaceConfig): UserWorkspaceConfig;

export function defineBoundedContextTestConfig(overrides?: UserWorkspaceConfig): UserWorkspaceConfig;
