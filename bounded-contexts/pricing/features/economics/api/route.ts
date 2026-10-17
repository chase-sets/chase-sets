import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono, type Context } from "hono";
import { EconomicsContractError } from "../domain/contracts";
import { EconomicsOverrideConflictError } from "../domain/overrides";
import type { EconomicsResolver } from "../domain/resolution";
import { ChannelConnectionNotFoundError } from "../domain/source-resolution";
import type { EconomicsOverrideRuntime } from "./override-runtime";
import {
  parseAuthenticatedClearAllEconomicsOverridesRequest,
  parseAuthenticatedClearEconomicsOverrideRequest,
  parseAuthenticatedResolveEconomicsRequest,
  parseAuthenticatedSetEconomicsOverrideRequest,
} from "./contracts";

export function createEconomicsRoutes(
  resolver: EconomicsResolver,
  overrides: Pick<EconomicsOverrideRuntime, "execute">,
) {
  const app = new Hono<AuthenticatedApiEnv>();

  app.post("/resolve", async (c) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    try {
      const request = parseAuthenticatedResolveEconomicsRequest(await c.req.json(), actor.accountId);
      return c.json(await resolver.resolve(request));
    } catch (error) {
      if (error instanceof ChannelConnectionNotFoundError) {
        return c.json({ error: { code: error.code } }, 404);
      }
      if (error instanceof EconomicsContractError || error instanceof SyntaxError) {
        return c.json({ error: { code: "invalid-economics-request" } }, 400);
      }
      throw error;
    }
  });

  app.post("/overrides/set", async (c) => executeOverride(c, overrides, parseAuthenticatedSetEconomicsOverrideRequest));
  app.post("/overrides/clear", async (c) =>
    executeOverride(c, overrides, parseAuthenticatedClearEconomicsOverrideRequest),
  );
  app.post("/overrides/clear-all", async (c) =>
    executeOverride(c, overrides, parseAuthenticatedClearAllEconomicsOverridesRequest),
  );
  return app;
}

async function executeOverride(
  c: Context<AuthenticatedApiEnv>,
  runtime: Pick<EconomicsOverrideRuntime, "execute">,
  parse: (raw: unknown, accountId: string) => Omit<Parameters<EconomicsOverrideRuntime["execute"]>[0], "context">,
) {
  const actor = c.get("actor");
  const context = c.get("context");
  if (!actor || !context) return c.json({ error: { code: "authentication_required" } }, 401);
  try {
    const input = parse(await c.req.json(), actor.accountId);
    const state = await runtime.execute({ ...input, context });
    return c.json({ version: state.version, entries: state.entries });
  } catch (error) {
    if (error instanceof EconomicsOverrideConflictError) {
      return c.json({ error: { code: "economics-override-version-conflict" } }, 409);
    }
    if (error instanceof EconomicsContractError || error instanceof SyntaxError) {
      return c.json({ error: { code: "invalid-economics-override-request" } }, 400);
    }
    throw error;
  }
}
