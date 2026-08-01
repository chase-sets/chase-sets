import { describe, expect, it } from "vitest";
import { getApiHostEntries } from "@chase-sets/platform-runtime/api";
import { buildMcpHandlersFromModules, type McpModuleHandlerComposition } from "@chase-sets/platform-runtime/mcp";
import { flattenAvailableMcpResources, flattenAvailableMcpTools } from "@chase-sets/platform-runtime/mcp-contracts";
import { apiContextRegistry } from "../src/context-registry";

type MissingMcpHandlers = Readonly<{
  tools: readonly string[];
  resources: readonly string[];
}>;

function createServiceProxy(): unknown {
  const target = () => createServiceProxy();

  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }

      return createServiceProxy();
    },
    has() {
      return true;
    },
    apply() {
      return createServiceProxy();
    },
  });
}

function buildPlatformApiMcpComposition(): McpModuleHandlerComposition {
  return buildMcpHandlersFromModules(
    getApiHostEntries(apiContextRegistry, "platform-api", "public").map((entry) => ({
      module: entry.module,
      services: createServiceProxy(),
    })),
  );
}

function findMissingAvailableMcpHandlers(composition: McpModuleHandlerComposition): MissingMcpHandlers {
  const toolHandlerNames = new Set(Object.keys(composition.toolHandlers));
  const resourceHandlerTemplates = new Set(Object.keys(composition.resourceHandlers));

  return {
    tools: flattenAvailableMcpTools()
      .map((tool) => tool.name)
      .filter((toolName) => !toolHandlerNames.has(toolName))
      .sort(),
    resources: flattenAvailableMcpResources()
      .map((resource) => resource.uriTemplate)
      .filter((uriTemplate) => !resourceHandlerTemplates.has(uriTemplate))
      .sort(),
  };
}

describe("platform-api MCP composition guard", () => {
  it("registers runtime handlers for every available native MCP capability it advertises", () => {
    expect(findMissingAvailableMcpHandlers(buildPlatformApiMcpComposition())).toEqual({
      tools: [],
      resources: [],
    });
  });

  it("fails when an available MCP tool is advertised without a composed platform-api handler", () => {
    const composition = buildPlatformApiMcpComposition();
    const missingToolName = flattenAvailableMcpTools()[0]?.name;

    expect(missingToolName).toBeDefined();

    const toolHandlers = { ...composition.toolHandlers };
    delete toolHandlers[missingToolName as string];

    expect(
      findMissingAvailableMcpHandlers({
        ...composition,
        toolHandlers,
      }).tools,
    ).toEqual([missingToolName]);
  });
});
