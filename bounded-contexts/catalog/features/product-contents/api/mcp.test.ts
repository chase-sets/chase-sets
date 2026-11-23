import { resolveRolePermissions, type ResolvedActor } from "@chase-sets/auth-context";
import { createMcpRoutes } from "@chase-sets/platform-runtime/mcp";
import { createId } from "@chase-sets/primitives/typed-ids";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { createProductContentsMcpHandlers } from "./mcp";
import type { ProductContentServices } from "./runtime";

it("MCP source-call contract coverage", async () => {
  const services = createCatalogServices({
    query: async () => {
      throw new Error("Unexpected database query in Product Contents MCP test.");
    },
    connect: async () => {
      throw new Error("Unexpected database connection in Product Contents MCP test.");
    },
  });
  const containerCatalogItemId = createId("cat");
  const containedCatalogItemId = createId("cat");
  const containedSelectedOptions = [{ dimensionId: createId("dim"), optionId: createId("chc") }];
  const authoring = { containerCatalogItemId, containerSelectedOptions: null, lines: [], version: 7 };
  const contents = {
    ...services.productContents,
    listProductContentTypes: vi.fn<ProductContentServices["listProductContentTypes"]>().mockResolvedValue([]),
    listProductContentInclusionPolicies: vi
      .fn<ProductContentServices["listProductContentInclusionPolicies"]>()
      .mockResolvedValue([]),
    listProductContentsForContainer: vi
      .fn<ProductContentServices["listProductContentsForContainer"]>()
      .mockResolvedValue([]),
    listProductContainersForContained: vi
      .fn<ProductContentServices["listProductContainersForContained"]>()
      .mockResolvedValue([]),
    readProductContentsAuthoringState: vi
      .fn<ProductContentServices["readProductContentsAuthoringState"]>()
      .mockResolvedValue(authoring),
    replaceProductContents: vi.fn<ProductContentServices["replaceProductContents"]>().mockResolvedValue({
      ...authoring,
      version: 8,
      containerProductId: null,
      resolvedFactHash: "fixture",
      resolverVersion: 1,
      resolvedAt: "2026-11-22T00:00:00Z",
    }),
  };
  const actor: ResolvedActor = {
    roleKey: "platform-admin",
    permissions: resolveRolePermissions("platform-admin"),
    accountId: "account_operator",
    userId: "user_operator",
    sessionId: "session",
    tenantId: "tenant",
    membershipId: "membership",
    agentGrant: {
      grantId: "grant",
      platformProfileUrl: "https://example.test/platform",
      scopes: ["operations:write"],
      rolePermissions: resolveRolePermissions("platform-admin"),
    },
  };
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route(
    "/mcp",
    createMcpRoutes({
      toolHandlers: createProductContentsMcpHandlers(contents).toolHandlers,
      operatorAuthority: async () => ({
        kind: "granted",
        membershipId: actor.membershipId,
        roleKey: "platform-admin",
        rolePermissions: actor.permissions,
      }),
      allowInMemoryIdempotencyStoreForTests: true,
    }),
  );
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request",
        method: "tools/call",
        params: { name: `catalog.${name}`, arguments: args },
      }),
    });
    const body = (await response.json()) as {
      error?: unknown;
      result: { isError?: boolean; structuredContent?: unknown };
    };
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    return body.result;
  }

  const emptyPage = { items: [], total: 0, count: 0 };
  expect((await call("list-product-content-types")).structuredContent).toEqual(emptyPage);
  expect((await call("list-product-content-inclusion-policies")).structuredContent).toEqual(emptyPage);
  expect(contents.listProductContentTypes).toHaveBeenCalledOnce();
  expect(contents.listProductContentInclusionPolicies).toHaveBeenCalledOnce();
  expect((await call("list-product-containers-for-contained", { containedCatalogItemId })).structuredContent).toEqual(
    emptyPage,
  );
  expect(contents.listProductContainersForContained).toHaveBeenCalledWith(containedCatalogItemId);
  expect((await call("list-product-contents-for-container", { containerCatalogItemId })).structuredContent).toEqual(
    emptyPage,
  );
  expect(contents.listProductContentsForContainer).toHaveBeenCalledWith(containerCatalogItemId);
  expect(
    (await call("list-product-contents-for-container", { containerCatalogItemId, containerSelectedOptions: [] }))
      .structuredContent,
  ).toEqual(authoring);
  expect(contents.readProductContentsAuthoringState).toHaveBeenCalledWith(containerCatalogItemId, []);
  expect(
    (
      await call("list-product-contents-for-container", {
        containerCatalogItemId,
        containerSelectedOptions: [{ dimensionId: "incomplete" }],
      })
    ).isError,
  ).toBe(true);
  expect(contents.readProductContentsAuthoringState).toHaveBeenCalledTimes(1);

  const write = {
    containerCatalogItemId,
    confirmed: true,
    confirmationText: "Replace Product Contents.",
    idempotencyKey: "replace",
  };
  const line = {
    containedCatalogItemId,
    containedSelectedOptions,
    contentTypeId: "content-type",
    inclusionPolicyId: null,
    provenance: { source: "operator", detail: { sample: false } },
  };
  for (const args of [
    { ...write, lines: [line] },
    { ...write, expectedVersion: 7 },
    { ...write, expectedVersion: -1, lines: [], idempotencyKey: "negative-version" },
    { ...write, expectedVersion: 7, lines: [], confirmed: false },
  ]) {
    expect((await call("replace-product-contents", args)).isError).toBe(true);
  }
  expect(contents.replaceProductContents).not.toHaveBeenCalled();
  const args = { ...write, expectedVersion: 7, containerSelectedOptions: [], lines: [line] };
  const first = await call("replace-product-contents", args);
  expect(first.isError, JSON.stringify(first)).not.toBe(true);
  expect(await call("replace-product-contents", args)).toEqual(first);
  expect(contents.replaceProductContents).toHaveBeenCalledOnce();
  expect(contents.replaceProductContents).toHaveBeenCalledWith(
    {
      containerCatalogItemId,
      containerSelectedOptions: [],
      expectedVersion: 7,
      lines: [{ ...line, quantity: 1 }],
    },
    expect.objectContaining({ audit: { performedByUserId: actor.userId, forAccountId: actor.accountId } }),
  );
  expect(
    (
      await call("replace-product-contents", {
        ...args,
        expectedVersion: 8,
        lines: [],
        idempotencyKey: "remove-final-line",
      })
    ).isError,
  ).not.toBe(true);
  expect(contents.replaceProductContents).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedVersion: 8, lines: [] }),
    expect.anything(),
  );
});
