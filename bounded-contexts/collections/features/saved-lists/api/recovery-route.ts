import { Hono } from "hono";
import type { CollectionsApiEnv } from "../../../api";
import type { SavedListRecoveryServices } from "./recovery-runtime";
import { SavedListRecoveryError } from "./recovery-runtime";
import type {
  ConfirmSavedListOperation,
  PrepareSavedListOperation,
  SavedListOperationReference,
} from "./recovery-contracts";

export function createSavedListRecoveryRoutes(services: SavedListRecoveryServices) {
  const app = new Hono<CollectionsApiEnv>();
  app.use("/account/list-operations/*", async (c, next) => {
    const actor = c.get("actor");
    const context = c.get("context");
    if (!actor || !context || actor.accountId !== context.audit.forAccountId)
      return c.json({ error: { code: "authentication_required" } }, 401);
    if (!actor.permissions.includes("accounts.view"))
      return c.json({ error: { code: "authorization_forbidden" } }, 403);
    // Snapshot admission authority before parsing or awaiting work.
    c.set("context", { ...context, audit: { ...context.audit } });
    await next();
  });
  app.onError((error, c) => {
    const code = error instanceof SavedListRecoveryError ? error.code : "invalid-request";
    const status =
      code === "disabled" || code === "catalog-unavailable"
        ? 503
        : code === "not-found"
          ? 404
          : code === "expired"
            ? 410
            : code === "conflict" || code === "limit"
              ? 409
              : 400;
    return c.json({ error: { code: `saved-list-recovery-${code}` } }, status);
  });
  app.get("/account/list-operations", async (c) =>
    c.json(await services.list({ cursor: c.req.query("cursor") }, c.get("context"))),
  );
  app.get("/account/list-operations/:id", async (c) => c.json(await services.get(c.req.param("id"), c.get("context"))));
  app.post("/account/list-operations", async (c) => {
    const input: PrepareSavedListOperation = await c.req.json();
    return c.json(await services.prepare(input, c.get("context")), 201);
  });
  app.post("/account/list-operations/:id/confirm", async (c) => {
    const input: Omit<ConfirmSavedListOperation, "operationId"> = await c.req.json();
    return c.json(
      await services.confirm(
        { operationId: c.req.param("id"), revision: input.revision, destination: input.destination },
        c.get("context"),
      ),
    );
  });
  app.post("/account/list-operations/:id/begin-send", async (c) => {
    const input: Pick<SavedListOperationReference, "revision"> = await c.req.json();
    return c.json(
      await services.beginSend({ operationId: c.req.param("id"), revision: input.revision }, c.get("context")),
    );
  });
  app.post("/account/list-operations/:id/apply", async (c) => {
    const input: Pick<SavedListOperationReference, "revision"> = await c.req.json();
    return c.json(await services.apply({ operationId: c.req.param("id"), revision: input.revision }, c.get("context")));
  });
  app.post("/account/list-operations/anonymous", async (c) => {
    const input: Omit<Parameters<SavedListRecoveryServices["reserveAnonymous"]>[0], "anonymousOwnerId"> =
      await c.req.json();
    return c.json(
      await services.reserveAnonymous(
        {
          intentId: input.intentId,
          destination: input.destination,
          trackedQuantity: input.trackedQuantity,
          anonymousOwnerId: c.req.header("x-collections-anonymous-saved-list-id") ?? "",
        },
        c.get("context"),
      ),
      201,
    );
  });
  return app;
}
