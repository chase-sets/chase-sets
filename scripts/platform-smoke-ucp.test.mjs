import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("./platform-smoke.mjs", import.meta.url), "utf8");
const syntax = ts.createSourceFile("platform-smoke.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functionNode = syntax.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "expectUcpEndpoints",
);

function fixture(checkoutStatus = 400, catalogStatus = "success") {
  const origin = "https://synthetic-marketplace.example";
  const calls = [];
  const fetch = vi.fn(async (_label, url) => {
    calls.push(url);
    if (url.endsWith("/checkout-sessions"))
      return Response.json(
        { messages: [{ code: checkoutStatus === 400 ? "invalid_profile_url" : "signed_request_required" }] },
        { status: checkoutStatus },
      );
    if (url.endsWith("/catalog/search")) return Response.json({ ucp: { status: catalogStatus }, products: [] });
    if (url.endsWith("/ucp/mcp"))
      return Response.json({
        result: { tools: ["search_catalog", "lookup_catalog", "create_checkout"].map((name) => ({ name })) },
      });
    if (url.endsWith("/oauth-authorization-server"))
      return Response.json({
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["refresh_token"],
        introspection_endpoint: `${origin}/ucp/oauth/introspect`,
      });
    return Response.json({
      ucp: {
        version: "2026-08-25",
        payment_handlers: {},
        services: {
          "dev.ucp.shopping": [
            { transport: "rest", endpoint: `${origin}/ucp/v1` },
            { transport: "mcp", endpoint: `${origin}/ucp/mcp` },
          ],
        },
      },
    });
  });
  const probe = runInNewContext(`${functionNode.getText(syntax)}; expectUcpEndpoints`, {
    expectOk: fetch,
    fetchWithRetry: async (...args) => {
      const response = await fetch(...args);
      if (!args[3](response)) throw new Error("UCP REST missing-profile checkout returned an unexpected status.");
      return response;
    },
  });
  return { probe, calls, origin };
}

describe("UCP platform smoke negotiation", () => {
  it("checks profile-less REST checkout refusal and public catalog success", async () => {
    const { probe, calls, origin } = fixture();
    await probe(origin);
    expect(calls).toContain(`${origin}/ucp/v1/checkout-sessions`);
    expect(calls).toContain(`${origin}/ucp/v1/catalog/search`);
  });
  it("detects an unmounted gate even when profile discovery remains green", async () => {
    const { probe, origin } = fixture(200);
    await expect(probe(origin)).rejects.toThrow();
  });
  it("detects a broken profile-less catalog extension", async () => {
    const { probe, origin } = fixture(400, "error");
    await expect(probe(origin)).rejects.toThrow("catalog");
  });
});
