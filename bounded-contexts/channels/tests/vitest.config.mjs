import { defineBoundedContextTestConfig } from "../../../vitest.shared.mjs";
import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";

export default defineBoundedContextTestConfig({ resolve: { alias: createWorkspaceSourceAliases() } });
