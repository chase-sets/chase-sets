import { createHash } from "node:crypto";
import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import { resolveRecentAuthenticationStatus } from "@chase-sets/auth-context";
import {
  apiErrorResponse,
  authenticationRequiredResponse,
  conflictResponse,
  forbiddenResponse,
  notFoundResponse,
  validationFailedResponse,
} from "@chase-sets/http/responses";
import { parseTypedIdBoundary, TypedIdBoundaryDomainError } from "@chase-sets/http/typed-id";
import type { AccountId, UserId, WalletAdjustmentId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { SettlementApiEnv } from "../../../api";
import type { WalletServices } from "./runtime";
import {
  StaleWalletBalanceError,
  WalletAdjustmentHaltedError,
  WalletAdjustmentLimitExceededError,
  type WalletAdjustmentServices,
} from "./wallet-adjustment-runtime";
import { normalizeWalletAdjustmentReasonCode, type WalletAdjustmentReasonCode } from "../domain/wallet-adjustment";
import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeLedgerEntryDirection,
  normalizeMoneyAmount,
  SettlementDomainError,
  type CurrencyCode,
  type LedgerEntryDirection,
} from "../../../support/runtime-support/common";

/**
 * Purpose-specific wallet-adjustment permissions ratified by ADR 0020, distinct
 * from `payouts.*`: an ordinary account operator with payout authority can never
 * reach the platform adjustment surface. Granted to platform-admin only (see
 * `ROLE_PERMISSIONS`/`AUTH_ROLE_PERMISSIONS`, contract-tested there). Posting
 * (`create`), approval, and reversal additionally require the acting session
 * to be recently authenticated -- see `requireRecentAuthentication` below.
 */
export const WALLET_ADJUSTMENT_PERMISSIONS = {
  view: "wallet-adjustments.view",
  create: "wallet-adjustments.create",
  approve: "wallet-adjustments.approve",
  reverse: "wallet-adjustments.reverse",
} as const;

export type WalletAdjustmentPermission =
  (typeof WALLET_ADJUSTMENT_PERMISSIONS)[keyof typeof WALLET_ADJUSTMENT_PERMISSIONS];

const MAX_ADJUSTMENT_AMOUNT = "1000000.00";
const MAX_EXPLANATION_LENGTH = 500;
const MAX_EVIDENCE_REFERENCES = 20;
const MAX_EVIDENCE_REFERENCE_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 50;

const ADJUSTMENT_STATUSES = ["requested", "approved", "rejected", "posted", "reversed"] as const;
type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

/** A bounded, machine-coded input rejection surfaced as a 400 validation error. */
class WalletAdjustmentInputError extends Error {
  public constructor(
    public readonly field: string,
    public readonly detailCode: string,
    message: string,
  ) {
    super(message);
    this.name = "WalletAdjustmentInputError";
  }
}

type ResolvedActor = NonNullable<SettlementApiEnv["Variables"]["actor"]>;

type Access =
  | { actor: ResolvedActor; context: EventStoreContext; response: null }
  | { actor: null; context: null; response: Response };

function requireAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
    get(key: "context"): SettlementApiEnv["Variables"]["context"];
  },
  permission: WalletAdjustmentPermission,
): Access {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      context: null,
      response: jsonResponse(
        authenticationRequiredResponse(
          t("settlement.features.wallets.api.wallet-adjustment-route.authentication.required"),
        ),
        401,
      ),
    };
  }
  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      context: null,
      response: jsonResponse(
        forbiddenResponse(t("settlement.features.wallets.api.wallet-adjustment-route.forbidden")),
        403,
      ),
    };
  }
  const context = c.get("context");
  if (!context) {
    return {
      actor: null,
      context: null,
      response: jsonResponse(
        authenticationRequiredResponse(
          t("settlement.features.wallets.api.wallet-adjustment-route.authentication.context.missing"),
        ),
        401,
      ),
    };
  }
  return { actor, context, response: null };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A machine-coded 401 distinct from `authentication_required`: the actor is
 * authenticated, but their session did not authenticate recently enough for
 * this specific high-risk action. The client's remedy is step-up
 * re-authentication, not sign-in from scratch.
 */
function stepUpRequiredResponse(message: string): Response {
  return jsonResponse({ error: { code: "step_up_required", message } }, 401);
}

/**
 * ADR 0020's recent-authentication ("step-up") requirement for posting a
 * Wallet Adjustment request, approving/rejecting it, and reversing it. Uses
 * Auth's own session-authentication fact on the resolved actor
 * (`ResolvedActor.authenticatedAt`, via `resolveRecentAuthenticationStatus`)
 * rather than a new Settlement-owned session concept, gated by the same
 * `settlement.wallet-adjustment-controls` policy window `services.approve`/
 * `reverse` themselves resolve -- so the API boundary and the domain always
 * agree on the window in force. Fails closed: policy or actor-fact
 * resolution failures are surfaced as `step_up_required`, never silently
 * allowed through.
 */
async function requireRecentAuthentication(
  actor: ResolvedActor,
  services: Pick<WalletAdjustmentServices, "resolveControls">,
): Promise<Response | null> {
  const controls = await services.resolveControls();
  const status = resolveRecentAuthenticationStatus(actor, { maxAgeMinutes: controls.recentAuthMaxAgeMinutes });
  if (status.recentlyAuthenticated) {
    return null;
  }
  return stepUpRequiredResponse(t("settlement.features.wallets.api.wallet-adjustment-route.step.up.required"));
}

/**
 * Attributes the money-movement audit trail to the affected account while
 * preserving the operator as the acting user.
 */
function contextForTargetAccount(context: EventStoreContext, targetAccountId: AccountId): EventStoreContext {
  return {
    ...context,
    audit: { ...context.audit, forAccountId: targetAccountId as EventStoreContext["audit"]["forAccountId"] },
  };
}

function parseAccountId(value: unknown): AccountId {
  return parseTypedIdBoundary(value, "acc", "accountId");
}

function parseAdjustmentId(value: unknown): WalletAdjustmentId {
  return parseTypedIdBoundary(value, "wad", "adjustmentId");
}

function parseUserId(value: unknown, fieldName: string): UserId {
  return parseTypedIdBoundary(value, "usr", fieldName);
}

function parseDirection(value: unknown): LedgerEntryDirection {
  if (value !== "credit" && value !== "debit") {
    throw new WalletAdjustmentInputError(
      "direction",
      "invalid_direction",
      "Direction must be either 'credit' or 'debit'.",
    );
  }
  return normalizeLedgerEntryDirection(value);
}

function parseCurrency(value: unknown): CurrencyCode {
  try {
    return normalizeCurrencyCode(typeof value === "string" && value.trim() !== "" ? value : "usd");
  } catch {
    throw new WalletAdjustmentInputError("currencyCode", "unsupported_currency", "Currency is not supported.");
  }
}

function parseReasonCode(value: unknown): WalletAdjustmentReasonCode {
  if (typeof value !== "string") {
    throw new WalletAdjustmentInputError(
      "reasonCode",
      "invalid_reason_code",
      "A wallet-adjustment reason code is required.",
    );
  }
  try {
    return normalizeWalletAdjustmentReasonCode(value);
  } catch {
    throw new WalletAdjustmentInputError(
      "reasonCode",
      "invalid_reason_code",
      "Reason code is not in the supported taxonomy.",
    );
  }
}

function parseAmount(value: unknown): string {
  let amount: string;
  try {
    amount = normalizeMoneyAmount(typeof value === "string" ? value : String(value ?? ""), {
      fieldName: "Wallet Adjustment amount",
    });
  } catch {
    throw new WalletAdjustmentInputError("amount", "invalid_amount", "Amount must be a positive money value.");
  }
  if (compareMoney(amount, MAX_ADJUSTMENT_AMOUNT) > 0) {
    throw new WalletAdjustmentInputError(
      "amount",
      "amount_out_of_bounds",
      "Amount exceeds the maximum permitted adjustment.",
    );
  }
  return amount;
}

function parseExplanation(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new WalletAdjustmentInputError("explanation", "invalid_explanation", "Explanation must be text.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_EXPLANATION_LENGTH) {
    throw new WalletAdjustmentInputError(
      "explanation",
      "explanation_too_long",
      "Explanation exceeds the maximum length.",
    );
  }
  return trimmed.length > 0 ? trimmed : null;
}

function parseEvidenceReferences(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new WalletAdjustmentInputError(
      "evidenceReferences",
      "invalid_evidence_references",
      "Evidence references must be a list.",
    );
  }
  if (value.length > MAX_EVIDENCE_REFERENCES) {
    throw new WalletAdjustmentInputError(
      "evidenceReferences",
      "too_many_evidence_references",
      "Too many evidence references were provided.",
    );
  }
  const references: string[] = [];
  for (const reference of value) {
    if (typeof reference !== "string") {
      throw new WalletAdjustmentInputError(
        "evidenceReferences",
        "invalid_evidence_references",
        "Each evidence reference must be text.",
      );
    }
    const trimmed = reference.trim();
    if (trimmed.length > MAX_EVIDENCE_REFERENCE_LENGTH) {
      throw new WalletAdjustmentInputError(
        "evidenceReferences",
        "evidence_reference_too_long",
        "An evidence reference exceeds the maximum length.",
      );
    }
    if (trimmed.length > 0) {
      references.push(trimmed);
    }
  }
  return references;
}

function parseStatusFilter(value: string | undefined): AdjustmentStatus | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!(ADJUSTMENT_STATUSES as readonly string[]).includes(value)) {
    throw new WalletAdjustmentInputError(
      "status",
      "invalid_status",
      "Status filter is not a recognized adjustment status.",
    );
  }
  return value as AdjustmentStatus;
}

function parseBoundedLimit(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PAGE_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new WalletAdjustmentInputError("limit", "invalid_limit", "Limit must be a positive whole number.");
  }
  return Math.min(parsed, MAX_PAGE_LIMIT);
}

function parseBoundedOffset(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new WalletAdjustmentInputError("offset", "invalid_offset", "Offset must be a non-negative whole number.");
  }
  return parsed;
}

function parseOptionalString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new WalletAdjustmentInputError(fieldName, "invalid_value", "Field must be text.");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Server-owned idempotency identity: retries of the same operator, target,
 * command, and canonical request return the original adjustment. An optional
 * standards-based Idempotency-Key header further scopes it; operators never
 * choose the raw ledger-entry key.
 */
function requestIdempotencyKey(
  actorUserId: string,
  canonical: Readonly<Record<string, unknown>>,
  headerKey: string | null,
): string {
  const canonicalDigest = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex").slice(0, 32);
  const scoped = `${actorUserId}:request:${canonicalDigest}`;
  return headerKey ? `${scoped}:${headerKey}` : scoped;
}

function readIdempotencyHeader(c: { req: { header(name: string): string | undefined } }): string | null {
  const header = c.req.header("Idempotency-Key");
  if (header === undefined || header.trim() === "") {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new WalletAdjustmentInputError(
      "Idempotency-Key",
      "idempotency_key_too_long",
      "Idempotency-Key header exceeds the maximum length.",
    );
  }
  return trimmed;
}

function handleWriteError(c: { json: (body: unknown, status: number) => Response }, error: unknown): Response {
  if (error instanceof TypedIdBoundaryDomainError) {
    return c.json(error.body, 400);
  }
  if (error instanceof WalletAdjustmentInputError) {
    return c.json(
      validationFailedResponse(error.message, [{ field: error.field, code: error.detailCode, message: error.message }]),
      400,
    );
  }
  if (error instanceof StaleWalletBalanceError) {
    return c.json(apiErrorResponse("conflict", error.message, [{ code: error.code, message: error.message }]), 409);
  }
  if (error instanceof WalletAdjustmentHaltedError) {
    return c.json({ error: { code: error.code, message: error.message } }, 503);
  }
  if (error instanceof WalletAdjustmentLimitExceededError) {
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.violations.map((violation) => ({ code: violation.code, message: violation.message })),
        },
      },
      429,
    );
  }
  if (error instanceof SettlementDomainError) {
    return c.json(conflictResponse(error.message), 409);
  }
  if (error instanceof Error) {
    return c.json(conflictResponse(error.message), 409);
  }
  return c.json(
    validationFailedResponse(t("settlement.features.wallets.api.wallet-adjustment-route.command.failed")),
    400,
  );
}

export function createWalletAdjustmentRoutes(
  services: WalletAdjustmentServices,
  wallets: Pick<WalletServices, "listWalletEntries">,
) {
  const app = new Hono<SettlementApiEnv>();

  // --- Account-targeted reads (platform operator only) ---

  app.get("/wallet-adjustments/accounts/:accountId/summary", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.view);
    if (access.response) {
      return access.response;
    }
    let accountId: AccountId;
    try {
      accountId = parseAccountId(c.req.param("accountId"));
    } catch (error) {
      return handleWriteError(c, error);
    }
    const summary = await services.getAccountSummary(accountId);
    if (!summary.opened_at && summary.updated_at === null) {
      return c.json(
        notFoundResponse(t("settlement.features.wallets.api.wallet-adjustment-route.account.not-found")),
        404,
      );
    }
    return c.json(summary);
  });

  app.get("/wallet-adjustments/accounts/:accountId/adjustments", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.view);
    if (access.response) {
      return access.response;
    }
    try {
      const accountId = parseAccountId(c.req.param("accountId"));
      const limit = parseBoundedLimit(c.req.query("limit"));
      const offset = parseBoundedOffset(c.req.query("offset"));
      const status = parseStatusFilter(c.req.query("status"));
      const result = await services.listAdjustments({
        targetAccountId: accountId,
        ...(status ? { status } : {}),
        limit,
        offset,
      });
      return c.json({ items: result.items, total: result.total, count: result.items.length });
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  app.get("/wallet-adjustments/accounts/:accountId/ledger", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.view);
    if (access.response) {
      return access.response;
    }
    try {
      const accountId = parseAccountId(c.req.param("accountId"));
      const limit = parseBoundedLimit(c.req.query("limit"));
      const offset = parseBoundedOffset(c.req.query("offset"));
      const result = await wallets.listWalletEntries({ accountId, limit, offset });
      return c.json({ items: result.items, total: result.total, count: result.items.length });
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  // Registered before the `:adjustmentId` route below (and re-checked by
  // `parseAdjustmentId`'s "wad_"-prefix format even if router precedence
  // ever changed) so this static segment is never shadowed by the dynamic
  // one. Bounded/paginated reconciliation report -- always available under
  // the money-operations kill switch, alongside every other read.
  app.get("/wallet-adjustments/reconciliation", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.view);
    if (access.response) {
      return access.response;
    }
    try {
      const limit = parseBoundedLimit(c.req.query("limit"));
      const offset = parseBoundedOffset(c.req.query("offset"));
      const report = await services.runReconciliation({ limit, offset });
      return c.json(report);
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  app.get("/wallet-adjustments/:adjustmentId", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.view);
    if (access.response) {
      return access.response;
    }
    let adjustmentId: WalletAdjustmentId;
    try {
      adjustmentId = parseAdjustmentId(c.req.param("adjustmentId"));
    } catch (error) {
      return handleWriteError(c, error);
    }
    const adjustment = await services.getAdjustment(adjustmentId);
    if (!adjustment) {
      return c.json(
        notFoundResponse(t("settlement.features.wallets.api.wallet-adjustment-route.adjustment.not-found")),
        404,
      );
    }
    return c.json(adjustment);
  });

  app.get("/wallet-adjustments", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.view);
    if (access.response) {
      return access.response;
    }
    try {
      const limit = parseBoundedLimit(c.req.query("limit"));
      const offset = parseBoundedOffset(c.req.query("offset"));
      const status = parseStatusFilter(c.req.query("status"));
      const targetAccountId = c.req.query("targetAccountId");
      const result = await services.listAdjustments({
        ...(targetAccountId ? { targetAccountId: parseAccountId(targetAccountId) } : {}),
        ...(status ? { status } : {}),
        limit,
        offset,
      });
      return c.json({ items: result.items, total: result.total, count: result.items.length });
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  // --- Preview and commands ---

  app.post("/wallet-adjustments/preview", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.create);
    if (access.response) {
      return access.response;
    }
    try {
      const body = await c.req.json().catch(() => ({}));
      const targetAccountId = parseAccountId(body.targetAccountId);
      const preview = await services.preview({
        targetAccountId,
        direction: parseDirection(body.direction),
        amount: parseAmount(body.amount),
        currencyCode: parseCurrency(body.currencyCode),
        reasonCode: parseReasonCode(body.reasonCode),
        selfBenefiting: targetAccountId === access.actor.accountId,
      });
      return c.json(preview);
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  app.post("/wallet-adjustments", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.create);
    if (access.response) {
      return access.response;
    }
    const stepUp = await requireRecentAuthentication(access.actor, services);
    if (stepUp) {
      return stepUp;
    }
    try {
      const body = await c.req.json().catch(() => ({}));
      const targetAccountId = parseAccountId(body.targetAccountId);
      const direction = parseDirection(body.direction);
      const amount = parseAmount(body.amount);
      const currencyCode = parseCurrency(body.currencyCode);
      const reasonCode = parseReasonCode(body.reasonCode);
      const explanation = parseExplanation(body.explanation);
      const evidenceReferences = parseEvidenceReferences(body.evidenceReferences);
      const expectedBalanceRevision = parseOptionalString(body.expectedBalanceRevision, "expectedBalanceRevision");
      const headerKey = readIdempotencyHeader(c);
      const idempotencyKey = requestIdempotencyKey(
        access.actor.userId,
        { targetAccountId, direction, amount, currencyCode, reasonCode, explanation, evidenceReferences },
        headerKey,
      );
      const snapshot = await services.request(
        {
          idempotencyKey,
          targetAccountId,
          direction,
          amount,
          currencyCode,
          reasonCode,
          explanation,
          evidenceReferences,
          requestedBy: access.actor.userId as UserId,
          selfBenefiting: targetAccountId === access.actor.accountId,
          ...(expectedBalanceRevision ? { expectedBalanceRevision } : {}),
        },
        contextForTargetAccount(access.context, targetAccountId),
      );
      return c.json(snapshot, 201);
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  app.post("/wallet-adjustments/:adjustmentId/approve", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.approve);
    if (access.response) {
      return access.response;
    }
    const stepUp = await requireRecentAuthentication(access.actor, services);
    if (stepUp) {
      return stepUp;
    }
    try {
      const adjustmentId = parseAdjustmentId(c.req.param("adjustmentId"));
      const existing = await services.getAdjustment(adjustmentId);
      if (!existing) {
        return c.json(
          notFoundResponse(t("settlement.features.wallets.api.wallet-adjustment-route.adjustment.not-found")),
          404,
        );
      }
      const body = await c.req.json().catch(() => ({}));
      const elevationApprovedByUserId =
        body.elevationApprovedByUserId === undefined || body.elevationApprovedByUserId === null
          ? null
          : parseUserId(body.elevationApprovedByUserId, "elevationApprovedByUserId");
      const snapshot = await services.approveAndPost(
        {
          adjustmentId,
          approvedBy: access.actor.userId as UserId,
          ...(elevationApprovedByUserId ? { elevationApprovedBy: elevationApprovedByUserId } : {}),
        },
        contextForTargetAccount(access.context, existing.target_account_id as AccountId),
      );
      return c.json(snapshot);
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  app.post("/wallet-adjustments/:adjustmentId/reject", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.approve);
    if (access.response) {
      return access.response;
    }
    try {
      const adjustmentId = parseAdjustmentId(c.req.param("adjustmentId"));
      const existing = await services.getAdjustment(adjustmentId);
      if (!existing) {
        return c.json(
          notFoundResponse(t("settlement.features.wallets.api.wallet-adjustment-route.adjustment.not-found")),
          404,
        );
      }
      const body = await c.req.json().catch(() => ({}));
      const rejectionReason = parseExplanation(body.rejectionReason);
      const snapshot = await services.reject(
        {
          adjustmentId,
          rejectedBy: access.actor.userId as UserId,
          rejectionReason,
        },
        contextForTargetAccount(access.context, existing.target_account_id as AccountId),
      );
      return c.json(snapshot);
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  app.post("/wallet-adjustments/:adjustmentId/reverse", async (c) => {
    const access = requireAccess(c, WALLET_ADJUSTMENT_PERMISSIONS.reverse);
    if (access.response) {
      return access.response;
    }
    const stepUp = await requireRecentAuthentication(access.actor, services);
    if (stepUp) {
      return stepUp;
    }
    try {
      const adjustmentId = parseAdjustmentId(c.req.param("adjustmentId"));
      const existing = await services.getAdjustment(adjustmentId);
      if (!existing) {
        return c.json(
          notFoundResponse(t("settlement.features.wallets.api.wallet-adjustment-route.adjustment.not-found")),
          404,
        );
      }
      const body = await c.req.json().catch(() => ({}));
      const approvedBy = parseUserId(body.approvedByUserId, "approvedByUserId");
      const elevationApprovedBy = parseUserId(body.elevationApprovedByUserId, "elevationApprovedByUserId");
      const explanation = parseExplanation(body.explanation);
      const result = await services.reverse(
        {
          adjustmentId,
          requestedBy: access.actor.userId as UserId,
          approvedBy,
          elevationApprovedBy,
          ...(explanation ? { explanation } : {}),
        },
        contextForTargetAccount(access.context, existing.target_account_id as AccountId),
      );
      return c.json(result, 201);
    } catch (error) {
      return handleWriteError(c, error);
    }
  });

  return app;
}
