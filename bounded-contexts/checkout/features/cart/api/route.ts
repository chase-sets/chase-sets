import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { parseTypedIdBoundary, TypedIdBoundaryDomainError } from "@chase-sets/http/typed-id";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CheckoutApiEnv } from "../../../api";
import {
  anonymousRequestRateLimitedResponse,
  createAnonymousRailCaptureRateLimiter,
  createCheckoutAccessGuard,
  createGuestCheckoutContext,
} from "../../../support/request-support/checkout-route-guard";
import { CheckoutDomainError, type CartLineId } from "../../../support/runtime-support/common";
import {
  recordCheckoutObservabilityTelemetry,
  type CheckoutObservabilityTelemetry,
} from "../../sessions/api/checkout-observability-telemetry";
import {
  CheckoutCommandAttemptRefusal,
  type CheckoutCartAddCommandInput,
  type CheckoutCartLineCommandInput,
} from "../../command-attempts/api/cart-attempt";
import {
  CHECKOUT_CART_ATTEMPT_CART_TARGET,
  CHECKOUT_CART_ATTEMPT_MAX_COMMANDS,
  computeCheckoutCommandAttemptRequestHash,
  type CheckoutCartAttemptKind,
  type CheckoutCartLineOutcome,
  type CheckoutCommandAttemptResult,
} from "../../command-attempts/api/contracts";
import { recordCartReadinessObservability } from "./cart-readiness-observability";
import { createCartReadinessRead } from "./read";
import { parseCartReadinessDecisionInput } from "../domain/readiness";
import type { CheckoutCartServices } from "./runtime";
import { normalizePresentedAnonymousCartId, toPublicCheckoutCartLines } from "./contracts";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";

const MAX_ANONYMOUS_CART_LINES = 50;
const requireCartAccess = createCheckoutAccessGuard({
  authenticationRequiredMessage: t("checkout.features.cart.api.route.authentication.required"),
  authorizationForbiddenMessage: t("checkout.features.cart.api.route.forbidden"),
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("checkout.features.cart.api.route.request.failed");
}

function optionalBodyString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const createGuestCartContext = () =>
  createGuestCheckoutContext({
    performedByUserId: "usr_guest_checkout" as UserId,
    forAccountId: "acc_guest_checkout" as AccountId,
  });

function parseVersionSelection(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((selection): selection is { dimensionId: string; optionId: string } =>
          Boolean(selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

function parseFulfillmentMode(body: Record<string, unknown>) {
  const lockedListingId =
    body.lockedListingId === null || body.lockedListingId === undefined
      ? null
      : String(body.lockedListingId).trim() || null;
  return {
    fulfillmentMode:
      body.fulfillmentMode === "locked-listing" || lockedListingId
        ? ("locked-listing" as const)
        : ("optimize" as const),
    lockedListingId,
    sellerPreferenceId:
      body.sellerPreferenceId === null || body.sellerPreferenceId === undefined
        ? null
        : String(body.sellerPreferenceId).trim() || null,
  };
}

function parseSelectedListingSnapshot(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const listingId = source.listingId === null || source.listingId === undefined ? "" : String(source.listingId).trim();
  if (!listingId) {
    return null;
  }

  return {
    listingId,
    sellerAccountId: optionalBodyString(source.sellerAccountId),
    sellerDisplayName: optionalBodyString(source.sellerDisplayName),
    sellerSlug: optionalBodyString(source.sellerSlug),
    priceAmount: optionalBodyString(source.priceAmount),
    priceCurrencyCode: optionalBodyString(source.priceCurrencyCode),
    listingStreamVersion:
      source.listingStreamVersion === null || source.listingStreamVersion === undefined
        ? null
        : Number(source.listingStreamVersion),
    source: optionalBodyString(source.source),
  };
}

function parseCartLineBody(body: Record<string, unknown>): CheckoutCartAddCommandInput {
  const fulfillment = parseFulfillmentMode(body);

  return {
    type: "add",
    catalogItemId: String(body.catalogItemId ?? ""),
    productId: String(body.productId ?? ""),
    itemTitle: String(body.itemTitle ?? ""),
    itemSubtitle: body.itemSubtitle === null || body.itemSubtitle === undefined ? null : String(body.itemSubtitle),
    itemImageUrl: body.itemImageUrl === null || body.itemImageUrl === undefined ? null : String(body.itemImageUrl),
    itemImageSrcSet: optionalBodyString(body.itemImageSrcSet),
    itemImageLoadingUrl: optionalBodyString(body.itemImageLoadingUrl),
    itemImageLoadingAlt: optionalBodyString(body.itemImageLoadingAlt),
    itemImageLoadingSrcSet: optionalBodyString(body.itemImageLoadingSrcSet),
    selectedOptions: parseVersionSelection(body.selectedOptions),
    productSummary:
      body.productSummary === null || body.productSummary === undefined ? null : String(body.productSummary),
    quantity: Number(body.quantity ?? 0),
    ...fulfillment,
    selectedListingSnapshot: parseSelectedListingSnapshot(body.selectedListingSnapshot),
  };
}

function parseAvailabilityState(body: Record<string, unknown>) {
  return body.availabilityState === "unavailable" ||
    body.availabilityState === "changed" ||
    body.availabilityState === "waiting-for-supply"
    ? body.availabilityState
    : "available";
}

function parseFulfillmentCommand(lineId: CartLineId, body: Record<string, unknown>): CheckoutCartLineCommandInput {
  return {
    type: "fulfillment",
    lineId,
    availabilityState: parseAvailabilityState(body),
    ...parseFulfillmentMode(body),
    selectedListingSnapshot: parseSelectedListingSnapshot(body.selectedListingSnapshot),
  };
}

function parseLineId(value: unknown) {
  return parseTypedIdBoundary(String(value ?? ""), "cli", "lineId") as CartLineId;
}

/**
 * Parses one `/cart/commands` entry. An unknown command type or malformed line
 * id refuses the whole request before any read.
 */
function parseCartCommand(value: unknown): CheckoutCartLineCommandInput {
  if (!value || typeof value !== "object") {
    throw new CheckoutDomainError("Cart commands must be objects.");
  }
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "add":
      return parseCartLineBody(command);
    case "quantity":
      return { type: "quantity", lineId: parseLineId(command.lineId), quantity: Number(command.quantity ?? 0) };
    case "fulfillment":
      return parseFulfillmentCommand(parseLineId(command.lineId), command);
    case "remove":
      return { type: "remove", lineId: parseLineId(command.lineId) };
    default:
      throw new CheckoutDomainError("Cart command type must be add, quantity, fulfillment or remove.");
  }
}

function countCartItems(items: readonly { quantity: number }[]) {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

function anonymousCartLimitExceededResponse() {
  return {
    error: {
      code: "anonymous_cart_limit_exceeded",
      message: t("checkout.features.cart.api.route.anonymous.cart.limit.exceeded", {
        limit: MAX_ANONYMOUS_CART_LINES,
      }),
    },
  };
}

type CartAttemptWrite = Readonly<{
  kind: CheckoutCartAttemptKind;
  target: string;
  commands: readonly CheckoutCartLineCommandInput[];
}>;

type CartWriteResponse = Readonly<{ body: Record<string, unknown>; status: 200 | 201 | 400 | 409 }>;

/** Maps a single-line attempt's one vector entry onto that route's unchanged success or refusal shape. */
function singleLineResponse(
  successStatus: 200 | 201,
  successBody: (line: CheckoutCartLineOutcome) => Record<string, unknown>,
) {
  return (result: CheckoutCommandAttemptResult): CartWriteResponse => {
    const line = result.vector![0]!;
    if (line.outcome === "succeeded") {
      return { status: successStatus, body: { ...successBody(line), attempt: result } };
    }
    return {
      status: line.outcome === "conflict" ? 409 : 400,
      body: {
        error: {
          code: line.outcome === "conflict" ? "cart_line_conflict" : "validation_failed",
          message: line.message ?? t("checkout.features.cart.api.route.request.failed"),
        },
        attempt: result,
      },
    };
  };
}

function bulkAddResponse(result: CheckoutCommandAttemptResult): CartWriteResponse {
  const lines = result.vector!.map((line) => ({
    index: line.index,
    lineId: line.outcome === "succeeded" ? line.lineId : null,
    status: line.outcome === "succeeded" ? (line.status as "added" | "merged") : ("failed" as const),
    message: line.outcome === "succeeded" ? null : line.message,
  }));
  return {
    status: 200,
    body: {
      status: "completed",
      requestedLineCount: lines.length,
      addedLineCount: lines.filter((line) => line.status === "added").length,
      mergedLineCount: lines.filter((line) => line.status === "merged").length,
      failedLineCount: lines.filter((line) => line.status === "failed").length,
      lines,
      attempt: result,
    },
  };
}

function commandsResponse(result: CheckoutCommandAttemptResult): CartWriteResponse {
  return { status: 200, body: { status: "completed", attempt: result } };
}

/**
 * Whole-attempt answers that are not a decided vector: a reused attempt with a
 * changed request, a cart that kept changing under re-decision, and history
 * the owner cannot read completely. Each carries the closed attempt result and
 * nothing else.
 */
function unresolvedAttemptResponse(result: CheckoutCommandAttemptResult): CartWriteResponse | null {
  switch (result.ownerStatus) {
    case "conflict":
      return {
        status: 409,
        body: {
          error: { code: "checkout_attempt_conflict", message: t("checkout.features.cart.api.route.attempt.conflict") },
          attempt: result,
        },
      };
    case "failed-safe":
      return {
        status: 409,
        body: {
          error: { code: "cart_changed", message: t("checkout.features.cart.api.route.cart.changed") },
          attempt: result,
        },
      };
    case "ambiguous":
    case "not-observed":
      return {
        status: 409,
        body: {
          error: {
            code: "checkout_attempt_ambiguous",
            message: t("checkout.features.cart.api.route.attempt.ambiguous"),
          },
          attempt: result,
        },
      };
    case "committed":
      return null;
  }
}

async function readJsonBody(c: Context<CheckoutApiEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/**
 * Runs one cart write as one attempt. The request hash covers the JSON body
 * exactly as received minus `attemptId`, plus the route's kind and target via
 * the fingerprint, so an exact retry replays and any changed field conflicts.
 */
async function runCartAttempt(
  c: Context<CheckoutApiEnv>,
  services: CheckoutCartServices,
  input: Readonly<{
    ownerKey: string;
    context: EventStoreContext;
    body: Record<string, unknown>;
    newLineLimit?: number;
    write: () => CartAttemptWrite;
    respond: (result: CheckoutCommandAttemptResult) => CartWriteResponse;
  }>,
) {
  try {
    const write = input.write();
    const outcome = await services.executeCartAttempt(
      {
        ownerKey: input.ownerKey,
        attemptId: typeof input.body.attemptId === "string" ? input.body.attemptId : "",
        kind: write.kind,
        target: write.target,
        requestHash: await computeCheckoutCommandAttemptRequestHash(input.body),
        commands: write.commands,
        ...(input.newLineLimit === undefined ? {} : { newLineLimit: input.newLineLimit }),
      },
      input.context,
    );
    const response = unresolvedAttemptResponse(outcome.result) ?? input.respond(outcome.result);
    return c.json(response.body, response.status);
  } catch (error) {
    if (error instanceof CheckoutCommandAttemptRefusal && error.code === "anonymous_cart_limit_exceeded") {
      return c.json(anonymousCartLimitExceededResponse(), 400);
    }
    if (error instanceof CheckoutCommandAttemptRefusal) {
      return c.json({ error: { code: error.code, message: error.message } }, 400);
    }
    if (error instanceof CheckoutDomainError || error instanceof TypedIdBoundaryDomainError) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
    throw error;
  }
}

function lineCommandWrites(lineIdParam: string) {
  return {
    quantity: (body: Record<string, unknown>): CartAttemptWrite => {
      const lineId = parseLineId(lineIdParam);
      return {
        kind: "cart.set-quantity",
        target: lineId,
        commands: [{ type: "quantity", lineId, quantity: Number(body.quantity ?? 0) }],
      };
    },
    fulfillment: (body: Record<string, unknown>): CartAttemptWrite => {
      const lineId = parseLineId(lineIdParam);
      return { kind: "cart.set-fulfillment", target: lineId, commands: [parseFulfillmentCommand(lineId, body)] };
    },
    remove: (): CartAttemptWrite => {
      const lineId = parseLineId(lineIdParam);
      return { kind: "cart.remove-line", target: lineId, commands: [{ type: "remove", lineId }] };
    },
  };
}

function addLineWrite(body: Record<string, unknown>): CartAttemptWrite {
  return { kind: "cart.add-line", target: CHECKOUT_CART_ATTEMPT_CART_TARGET, commands: [parseCartLineBody(body)] };
}

function addLinesWrite(body: Record<string, unknown>): CartAttemptWrite {
  const rawLines: unknown[] = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length > CHECKOUT_CART_ATTEMPT_MAX_COMMANDS) {
    throw new CheckoutCommandAttemptRefusal("Bulk cart adds are limited to 250 products.", "cart_attempt_too_large");
  }
  return {
    kind: "cart.add-lines",
    target: CHECKOUT_CART_ATTEMPT_CART_TARGET,
    commands: rawLines
      .filter((line: unknown): line is Record<string, unknown> => Boolean(line && typeof line === "object"))
      .map(parseCartLineBody),
  };
}

function commandsWrite(body: Record<string, unknown>): CartAttemptWrite {
  const rawCommands: unknown[] = Array.isArray(body.commands) ? body.commands : [];
  if (rawCommands.length > CHECKOUT_CART_ATTEMPT_MAX_COMMANDS) {
    throw new CheckoutCommandAttemptRefusal(
      `A cart write carries 1 to ${CHECKOUT_CART_ATTEMPT_MAX_COMMANDS} line commands.`,
      "cart_attempt_too_large",
    );
  }
  return {
    kind: "cart.commands",
    target: CHECKOUT_CART_ATTEMPT_CART_TARGET,
    commands: rawCommands.map(parseCartCommand),
  };
}

const addLineResponse = singleLineResponse(201, (line) => ({
  id: line.lineId,
  version: line.version,
  status: "added",
}));
const quantityResponse = singleLineResponse(200, (line) => ({
  id: line.lineId,
  version: line.version,
  status: "quantity-updated",
}));
const fulfillmentResponse = singleLineResponse(200, (line) => ({
  id: line.lineId,
  version: line.version,
  status: "fulfillment-updated",
}));
const removeResponse = singleLineResponse(200, (line) => ({
  id: line.lineId,
  version: line.version,
  status: "removed",
}));

export function createAccountCartRoutes(
  services: CheckoutCartServices,
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry,
) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/cart", async (c) => {
    const access = requireCartAccess(c, { allowGuestCheckout: true });
    if (access.response) {
      return access.response;
    }

    const presentedAnonymousCartId = normalizePresentedAnonymousCartId(c.req.header("x-checkout-anonymous-cart-id"));
    const cartRead = services.readCart
      ? await services.readCart({
          accountId: access.actor.accountId,
          ...(presentedAnonymousCartId ? { presentedAnonymousCartId } : {}),
        })
      : null;
    const items =
      cartRead?.lines ??
      (await services.listAuthorizedCartLines({
        accountId: access.actor.accountId,
        ...(presentedAnonymousCartId ? { presentedAnonymousCartId } : {}),
      }));
    const readiness =
      cartRead?.readiness ??
      (services.createReadinessRead
        ? await services.createReadinessRead({
            accountId: access.actor.accountId,
            ...(presentedAnonymousCartId ? { presentedAnonymousCartId } : {}),
          })
        : null);
    return c.json({
      items: toPublicCheckoutCartLines(items),
      count: countCartItems(items),
      ...(readiness ? { readiness } : {}),
    });
  });

  app.post("/cart/readiness", async (c) => {
    const access = requireCartAccess(c, { allowGuestCheckout: true });
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const presentedAnonymousCartId = normalizePresentedAnonymousCartId(c.req.header("x-checkout-anonymous-cart-id"));
    const snapshot = await services.createReadinessSnapshot({
      accountId: access.actor.accountId,
      ...(presentedAnonymousCartId ? { presentedAnonymousCartId } : {}),
      decisions: parseCartReadinessDecisionInput(body),
    });
    recordCartReadinessObservability(checkoutObservabilityTelemetry, snapshot, {
      actor: access.actor,
      fallbackActorMode: "signed-in",
    });

    return c.json({ readiness: snapshot });
  });

  /** Resolves the signed-in writer, or the refusal response every account write shares. */
  function accountWriter(c: Context<CheckoutApiEnv>) {
    const access = requireCartAccess(c);
    if (access.response) {
      return { response: access.response } as const;
    }
    const context = c.get("context");
    if (!context) {
      return {
        response: c.json(
          {
            error: {
              code: "authentication_required",
              message: t("checkout.features.cart.api.route.authentication.context.missing"),
            },
          },
          401,
        ),
      } as const;
    }
    return { ownerKey: access.actor.accountId, context } as const;
  }

  app.post("/cart", async (c) => {
    const writer = accountWriter(c);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    return runCartAttempt(c, services, { ...writer, body, write: () => addLineWrite(body), respond: addLineResponse });
  });

  app.post("/cart/bulk", async (c) => {
    const writer = accountWriter(c);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    return runCartAttempt(c, services, { ...writer, body, write: () => addLinesWrite(body), respond: bulkAddResponse });
  });

  app.post("/cart/commands", async (c) => {
    const writer = accountWriter(c);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    return runCartAttempt(c, services, {
      ...writer,
      body,
      write: () => commandsWrite(body),
      respond: commandsResponse,
    });
  });

  app.post("/cart/:lineId/quantity", async (c) => {
    const writer = accountWriter(c);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    const writes = lineCommandWrites(c.req.param("lineId"));
    return runCartAttempt(c, services, {
      ...writer,
      body,
      write: () => writes.quantity(body),
      respond: quantityResponse,
    });
  });

  app.post("/cart/:lineId/fulfillment", async (c) => {
    const writer = accountWriter(c);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    const writes = lineCommandWrites(c.req.param("lineId"));
    return runCartAttempt(c, services, {
      ...writer,
      body,
      write: () => writes.fulfillment(body),
      respond: fulfillmentResponse,
    });
  });

  app.post("/cart/:lineId/remove", async (c) => {
    const writer = accountWriter(c);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    const writes = lineCommandWrites(c.req.param("lineId"));
    return runCartAttempt(c, services, { ...writer, body, write: writes.remove, respond: removeResponse });
  });

  return app;
}

function requireAnonymousCartId(c: { req: { header: (name: string) => string | undefined } }) {
  const ownerId = c.req.header("x-checkout-anonymous-cart-id")?.trim() ?? "";
  if (!ownerId.startsWith("anon_")) {
    return null;
  }

  return ownerId;
}

export function createGuestCartRoutes(
  services: CheckoutCartServices,
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry,
  resolveRateLimitRule?: RateLimitRuleResolver,
) {
  const app = new Hono<CheckoutApiEnv>();
  const anonymousCartCaptureRateLimiter = createAnonymousRailCaptureRateLimiter(
    "checkout:anonymous-cart-capture",
    resolveRateLimitRule,
  );

  app.get("/cart", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({
        items: [],
        count: 0,
        ...(services.readCart ? { readiness: createCartReadinessRead([]) } : {}),
      });
    }

    // A claimed key resolves to zero readable lines, so a refusal returns the
    // byte-identical empty payload a request with no key already returns.
    // Nothing in the response distinguishes claimed, foreign, or absent.
    const cartRead = services.readCart ? await services.readCart({ accountId: ownerId }) : null;
    const items = cartRead?.lines ?? (await services.listAuthorizedCartLines({ accountId: ownerId }));
    const readiness =
      cartRead?.readiness ??
      (services.createReadinessRead ? await services.createReadinessRead({ accountId: ownerId }) : null);
    return c.json({
      items: toPublicCheckoutCartLines(items),
      count: countCartItems(items),
      ...(readiness ? { readiness } : {}),
    });
  });

  app.post("/cart/readiness", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_cart_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const snapshot = await services.createReadinessSnapshot({
      accountId: ownerId,
      decisions: parseCartReadinessDecisionInput(body),
    });
    recordCartReadinessObservability(checkoutObservabilityTelemetry, snapshot, {
      actor: null,
      fallbackActorMode: "guest",
    });

    return c.json({ readiness: snapshot });
  });

  /**
   * Resolves the anonymous writer. Capture routes -- the ones that can grow a
   * guest cart -- are rate limited before any attempt is read or decided.
   */
  async function guestWriter(c: Context<CheckoutApiEnv>, capture: boolean) {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return {
        response: c.json(
          {
            error: {
              code: "anonymous_cart_required",
              message: t("checkout.features.cart.api.route.authentication.required"),
            },
          },
          400,
        ),
      } as const;
    }
    if (capture) {
      const rateLimit = await anonymousCartCaptureRateLimiter.check(c.req.raw);
      if (rateLimit.limited) {
        const response = anonymousRequestRateLimitedResponse(
          t("checkout.features.cart.api.route.anonymous.request.rate.limited"),
          rateLimit.retryAfterSeconds,
        );
        return { response: c.json(response.body, 429, response.headers) } as const;
      }
    }
    return { ownerKey: ownerId, context: c.get("context") ?? createGuestCartContext() } as const;
  }

  app.post("/cart", async (c) => {
    const writer = await guestWriter(c, true);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    return runCartAttempt(c, services, {
      ...writer,
      body,
      newLineLimit: MAX_ANONYMOUS_CART_LINES,
      write: () => addLineWrite(body),
      respond: addLineResponse,
    });
  });

  app.post("/cart/bulk", async (c) => {
    const writer = await guestWriter(c, true);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    return runCartAttempt(c, services, {
      ...writer,
      body,
      newLineLimit: MAX_ANONYMOUS_CART_LINES,
      write: () => addLinesWrite(body),
      respond: bulkAddResponse,
    });
  });

  app.post("/cart/commands", async (c) => {
    const writer = await guestWriter(c, true);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    return runCartAttempt(c, services, {
      ...writer,
      body,
      newLineLimit: MAX_ANONYMOUS_CART_LINES,
      write: () => commandsWrite(body),
      respond: commandsResponse,
    });
  });

  app.post("/cart/:lineId/quantity", async (c) => {
    const writer = await guestWriter(c, false);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    const writes = lineCommandWrites(c.req.param("lineId"));
    return runCartAttempt(c, services, {
      ...writer,
      body,
      write: () => writes.quantity(body),
      respond: quantityResponse,
    });
  });

  app.post("/cart/:lineId/fulfillment", async (c) => {
    const writer = await guestWriter(c, false);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    const writes = lineCommandWrites(c.req.param("lineId"));
    return runCartAttempt(c, services, {
      ...writer,
      body,
      write: () => writes.fulfillment(body),
      respond: fulfillmentResponse,
    });
  });

  app.post("/cart/:lineId/remove", async (c) => {
    const writer = await guestWriter(c, false);
    if ("response" in writer) return writer.response;
    const body = await readJsonBody(c);
    const writes = lineCommandWrites(c.req.param("lineId"));
    return runCartAttempt(c, services, { ...writer, body, write: writes.remove, respond: removeResponse });
  });

  app.post("/cart/merge-to-account", async (c) => {
    const access = requireCartAccess(c, { allowGuestCheckout: true });
    if (access.response) {
      return access.response;
    }

    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({ mergedLineCount: 0 });
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "context_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    let result: Awaited<ReturnType<CheckoutCartServices["mergeCartIntoAccount"]>>;
    try {
      result = await services.mergeCartIntoAccount(
        {
          sourceOwnerId: ownerId,
          targetAccountId: access.actor.accountId as AccountId,
        },
        context,
      );
    } catch (error) {
      try {
        recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
          state: "cart-merge-best-effort-failed",
          entrySource: "cart",
          actorMode: access.actor.roleKey === "guest-buyer" ? "guest" : "signed-in",
          scenarioState: "reconciliation",
          visibleState: "entry-continues",
          sideEffectStatus: "merge-failed",
        });
      } catch {
        // Telemetry must never replace the merge response consumed by the
        // best-effort entry caller.
      }
      return c.json(
        {
          error: {
            code: "cart_merge_failed",
            message: t("checkout.features.cart.api.route.request.failed"),
          },
        },
        500,
      );
    }

    return c.json(result);
  });

  return app;
}
