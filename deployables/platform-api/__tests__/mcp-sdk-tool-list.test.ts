import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { UCP_MCP_TOOLS, UCP_VERSION } from "@chase-sets/platform-runtime/ucp-contracts";
import { buildPlatformApiApp } from "../src/app";

function createApp() {
  const runtime = {
    mountedContexts: [],
    mountedModules: [],
    services: {
      auth: {},
      identity: {},
      discovery: {
        items: {
          search: {
            searchItems: async () => ({
              items: [{ catalog_item_id: "cat_1", slug: "cat-1", title: "Synthetic card" }],
              total: 1,
              nextCursor: null,
            }),
          },
          detail: {
            getItemDetail: async (id: string) => ({
              catalog_item_id: id,
              slug: `${id}-slug`,
              title: "Synthetic card",
              description: "A synthetic product.",
              market_listings: [
                {
                  listing_id: `${id}_listing`,
                  listing_slug: `${id}-listing`,
                  price_amount: "20.00",
                  price_currency_code: "USD",
                },
              ],
            }),
          },
        },
      },
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as never;
  return buildPlatformApiApp(runtime, {
    mcp: { allowInMemoryIdempotencyStoreForTests: true },
    ucp: { allowInMemoryIdempotencyStoreForTests: true },
  });
}

async function withDefaultSdkClient<T>(endpoint: "/mcp" | "/ucp/mcp", run: (client: Client) => Promise<T>) {
  const app = createApp();
  const client = new Client({ name: "chase-sets-tool-list-agent", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint, "https://platform-api.test"), {
    fetch: async (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init)),
  });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}

describe("default MCP SDK client tool listing", () => {
  it("lists the nine UCP tools with object-rooted output schemas and validates search_catalog results on /ucp/mcp", async () => {
    await withDefaultSdkClient("/ucp/mcp", async (client) => {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual(UCP_MCP_TOOLS.map((tool) => tool.name));
      expect(tools).toHaveLength(9);
      for (const tool of tools) expect(tool.outputSchema?.type, tool.name).toBe("object");

      const found = await client.callTool({ name: "search_catalog", arguments: { catalog: { query: "cards" } } });
      expect(found.structuredContent).toMatchObject({
        ucp: { version: UCP_VERSION, status: "success" },
        products: [{ id: "cat_1", title: "Synthetic card" }],
      });

      const rejected = await client.callTool({ name: "search_catalog", arguments: { query: "cards", limit: 3 } });
      expect(rejected.structuredContent).toEqual({
        ucp: { version: UCP_VERSION, status: "error" },
        messages: [
          { type: "error", code: "invalid_request", content: "The UCP request is invalid.", severity: "recoverable" },
        ],
      });
    });
  });

  it("lists the native catalog without UCP tools on /mcp", async () => {
    await withDefaultSdkClient("/mcp", async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);

      expect(names).toContain("discovery.search-market");
      for (const tool of UCP_MCP_TOOLS) expect(names).not.toContain(tool.name);
    });
  });
});
