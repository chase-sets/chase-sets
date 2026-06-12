import type { UserWorkspaceConfig } from "vitest/config";

export const boundedContextTestInclude: readonly string[];

export function defineWorkspaceTestConfig(overrides?: UserWorkspaceConfig): UserWorkspaceConfig;

export function defineBoundedContextTestConfig(overrides?: UserWorkspaceConfig): UserWorkspaceConfig;
