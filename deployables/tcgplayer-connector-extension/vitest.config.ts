import type { Plugin } from "vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { defineWorkspaceTestConfig } from "../../vitest.shared.mjs";

const coordinatorPortRemoved: Plugin = {
  name: "connector-coordinator-port-removed-mutant",
  enforce: "pre",
  transform(source, id) {
    const normalized = id.replaceAll("\\", "/");
    const queryStart = normalized.indexOf("?");
    const file = queryStart < 0 ? normalized : normalized.slice(0, queryStart);
    const query = queryStart < 0 ? "" : normalized.slice(queryStart + 1);
    if (
      !file.endsWith("/tcgplayer-connector-extension/src/compose.ts") ||
      !new URLSearchParams(query).has("coordinator-port-removed")
    )
      return null;
    const anchor = "coordinate: coordinator.coordinate,";
    if (source.split(anchor).length !== 2) throw new Error("coordinator-port-mutant-anchor-moved");
    return source.replace(anchor, "coordinate: undefined,");
  },
};

export default defineWorkspaceTestConfig({
  plugins: [coordinatorPortRemoved],
  resolve: { alias: createWorkspaceSourceAliases() },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/**/*.test.ts", "__tests__/support/**/*.test.ts"],
  },
});
