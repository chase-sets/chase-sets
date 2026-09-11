import { Hono, type Context } from "hono";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PlatformStripeEffectiveMode } from "./config-schema";
import { verifyPlatformInternalAuthSecret } from "./internal-auth";

export const EVIDENCE_WINDOW_ADMISSION_HEADER = "x-evidence-window-admission";
export const EVIDENCE_WINDOW_ID_PATTERN = /^[0-9a-f]{32}$/;
export const EVIDENCE_WINDOW_MIN_RETENTION_SECONDS = 3_600;
export const EVIDENCE_WINDOW_MAX_RETENTION_SECONDS = 82_800;
export const EVIDENCE_WINDOW_MAX_VERSION = 2_147_483_647;

export type EvidenceWindowCurrent = Readonly<{
  windowId: string;
  expiresAt: string;
  version: number;
}>;

export type EvidenceWindowCorrelation = Readonly<{
  currentOpenWindow: () => Promise<Readonly<{ windowId: string; expiresAt: string }> | null>;
}>;

export type EvidenceWindowRegistration = Readonly<{
  open: (input: Readonly<{ windowId: string; retentionSeconds: number }>) => Promise<
    Readonly<{
      windowId: string;
      state: "open";
      openedAt: string;
      expiresAt: string;
      version: number;
    }>
  >;
  current: () => Promise<EvidenceWindowCurrent | null>;
  close: (input: Readonly<{ windowId: string; expectedVersion: number }>) => Promise<
    Readonly<{
      windowId: string;
      state: "closed";
      closedAt: string;
      version: number;
    }>
  >;
}>;

export type EvidenceWindowRegistrationErrorCode =
  | "evidence-window-already-open"
  | "evidence-window-unknown"
  | "evidence-window-stale-write-rejected"
  | "evidence-window-storage-failed";

export class EvidenceWindowRegistrationError extends Error {
  readonly code: EvidenceWindowRegistrationErrorCode;

  constructor(code: EvidenceWindowRegistrationErrorCode) {
    super(code);
    this.name = "EvidenceWindowRegistrationError";
    this.code = code;
  }
}

type EvidenceWindowOpenRow = Readonly<{
  window_id: string;
  opened_at: Date | string;
  expires_at: Date | string;
  version: string | number;
}>;

type EvidenceWindowClosedRow = Readonly<{
  window_id: string;
  closed_at: Date | string;
  version: string | number;
}>;

type EvidenceWindowCurrentRow = Readonly<{
  window_id: string;
  expires_at: Date | string;
  version: string | number;
}>;

type EvidenceWindowStateRow = Readonly<{
  window_id: string;
  state: "open" | "closed";
  closed_at: Date | string | null;
  version: string | number;
}>;

export function createPostgresEvidenceWindowRegistration(db: PgTransactionalPool): EvidenceWindowRegistration {
  return {
    open: async (input) => {
      try {
        return await withPgTransaction(db, async (transaction) => {
          await transaction.query(
            `UPDATE evidence_window
             SET state = 'closed',
                 closed_at = expires_at,
                 version = version + 1
             WHERE state = 'open'
               AND expires_at <= statement_timestamp()`,
          );

          const result = await transaction.query<EvidenceWindowOpenRow>(
            `WITH authority AS (
               SELECT statement_timestamp() AS opened_at
             )
             INSERT INTO evidence_window (
               window_id,
               state,
               opened_at,
               expires_at,
               retention_seconds,
               closed_at,
               observed_mode,
               version
             )
             SELECT
               $1,
               'open',
               authority.opened_at,
               authority.opened_at + ($2::integer * interval '1 second'),
               $2,
               NULL,
               'test',
               1
             FROM authority
             RETURNING window_id, opened_at, expires_at, version`,
            [input.windowId, input.retentionSeconds],
          );
          const row = requireRow(result.rows[0]);
          return {
            windowId: row.window_id,
            state: "open" as const,
            openedAt: formatInstant(row.opened_at),
            expiresAt: formatInstant(row.expires_at),
            version: Number(row.version),
          };
        });
      } catch (error) {
        throw sanitizeStorageError(error);
      }
    },
    current: async () => {
      try {
        const result = await db.query<EvidenceWindowCurrentRow>(
          `SELECT window_id, expires_at, version
           FROM evidence_window
           WHERE state = 'open'
             AND expires_at > statement_timestamp()
           LIMIT 1`,
        );
        const row = result.rows[0];
        return row
          ? {
              windowId: row.window_id,
              expiresAt: formatInstant(row.expires_at),
              version: Number(row.version),
            }
          : null;
      } catch (error) {
        throw sanitizeStorageError(error);
      }
    },
    close: async (input) => {
      try {
        const result = await db.query<EvidenceWindowClosedRow>(
          `UPDATE evidence_window
           SET state = 'closed',
               closed_at = LEAST(expires_at, statement_timestamp()),
               version = version + 1
           WHERE window_id = $1
             AND state = 'open'
             AND version = $2
           RETURNING window_id, closed_at, version`,
          [input.windowId, input.expectedVersion],
        );
        const closed = result.rows[0];
        if (closed) {
          return mapClosedRow(closed);
        }

        const reread = await db.query<EvidenceWindowStateRow>(
          `SELECT window_id, state, closed_at, version
           FROM evidence_window
           WHERE window_id = $1`,
          [input.windowId],
        );
        const row = reread.rows[0];
        if (!row) {
          throw new EvidenceWindowRegistrationError("evidence-window-unknown");
        }
        if (row.state === "closed" && row.closed_at) {
          return mapClosedRow({ window_id: row.window_id, closed_at: row.closed_at, version: row.version });
        }
        throw new EvidenceWindowRegistrationError("evidence-window-stale-write-rejected");
      } catch (error) {
        throw sanitizeStorageError(error);
      }
    },
  };
}

export function createEvidenceWindowCorrelation(
  registration: Pick<EvidenceWindowRegistration, "current">,
): EvidenceWindowCorrelation {
  return {
    currentOpenWindow: async () => {
      const current = await registration.current();
      return current ? { windowId: current.windowId, expiresAt: current.expiresAt } : null;
    },
  };
}

export function createNullEvidenceWindowCorrelation(): EvidenceWindowCorrelation {
  return { currentOpenWindow: async () => null };
}

export type EvidenceWindowAuthoritySnapshot = Readonly<{
  effectiveMode: PlatformStripeEffectiveMode;
  gatewayKinds: Readonly<{
    paymentProcessor: "fake" | "stripe";
    moneyMovement: "fake" | "stripe";
  }>;
}>;

export type EvidenceWindowAuthorityProbe = (
  observation: EvidenceWindowAuthoritySnapshot & Readonly<{ operation: "open" | "current" | "close" }>,
) => void;

export type EvidenceWindowRoutesOptions = Readonly<{
  admissionSecret: string;
  authority: EvidenceWindowAuthoritySnapshot;
  registration: EvidenceWindowRegistration;
  authorityProbe?: EvidenceWindowAuthorityProbe;
}>;

export function createEvidenceWindowRegistrationRoutes(options: EvidenceWindowRoutesOptions) {
  const routes = new Hono();

  routes.post("/open", async (context) => {
    const refusal = authorizeRequest(context.req.header(EVIDENCE_WINDOW_ADMISSION_HEADER), options);
    if (refusal) return context.json(refusal.body, refusal.status);

    const input = await readOpenInput(context.req.raw);
    if (!input) return invalidRequest(context);
    observeAuthority(options, "open");

    try {
      return context.json(await options.registration.open(input));
    } catch (error) {
      return registrationErrorResponse(context, error);
    }
  });

  routes.get("/current", async (context) => {
    const refusal = authorizeRequest(context.req.header(EVIDENCE_WINDOW_ADMISSION_HEADER), options);
    if (refusal) return context.json(refusal.body, refusal.status);

    const url = new URL(context.req.url);
    if (url.search.length > 0 || (await context.req.text()).length > 0) return invalidRequest(context);
    observeAuthority(options, "current");

    try {
      return context.json({ current: await options.registration.current() });
    } catch (error) {
      return registrationErrorResponse(context, error);
    }
  });

  routes.post("/:windowId/close", async (context) => {
    const refusal = authorizeRequest(context.req.header(EVIDENCE_WINDOW_ADMISSION_HEADER), options);
    if (refusal) return context.json(refusal.body, refusal.status);

    const input = await readCloseInput(context.req.raw, context.req.param("windowId"));
    if (!input) return invalidRequest(context);
    observeAuthority(options, "close");

    try {
      return context.json(await options.registration.close(input));
    } catch (error) {
      return registrationErrorResponse(context, error);
    }
  });

  return routes;
}

function authorizeRequest(headerValue: string | undefined, options: EvidenceWindowRoutesOptions) {
  if (!timingSafeSecretMatches(headerValue ?? "", options.admissionSecret)) {
    return {
      status: 403 as const,
      body: { error: { code: "evidence-window-admission-rejected" as const } },
    };
  }
  if (options.authority.effectiveMode !== "test") {
    return {
      status: 409 as const,
      body: { error: { code: "evidence-window-mode-not-test" as const } },
    };
  }
  return null;
}

function timingSafeSecretMatches(actual: string, expected: string) {
  return verifyPlatformInternalAuthSecret(actual, expected);
}

function observeAuthority(options: EvidenceWindowRoutesOptions, operation: "open" | "current" | "close") {
  options.authorityProbe?.({ operation, ...options.authority });
}

async function readOpenInput(request: Request) {
  const body = await readClosedJsonObject(request, ["retentionSeconds", "windowId"]);
  if (!body) return null;
  const windowId = body.windowId;
  const retentionSeconds = body.retentionSeconds;
  return typeof windowId === "string" &&
    EVIDENCE_WINDOW_ID_PATTERN.test(windowId) &&
    Number.isInteger(retentionSeconds) &&
    Number(retentionSeconds) >= EVIDENCE_WINDOW_MIN_RETENTION_SECONDS &&
    Number(retentionSeconds) <= EVIDENCE_WINDOW_MAX_RETENTION_SECONDS
    ? { windowId, retentionSeconds: Number(retentionSeconds) }
    : null;
}

async function readCloseInput(request: Request, windowId: string) {
  if (!EVIDENCE_WINDOW_ID_PATTERN.test(windowId)) return null;
  const body = await readClosedJsonObject(request, ["expectedVersion"]);
  if (!body) return null;
  return Number.isInteger(body.expectedVersion) &&
    Number(body.expectedVersion) >= 1 &&
    Number(body.expectedVersion) <= EVIDENCE_WINDOW_MAX_VERSION
    ? { windowId, expectedVersion: Number(body.expectedVersion) }
    : null;
}

async function readClosedJsonObject(request: Request, expectedKeys: readonly string[]) {
  try {
    const value: unknown = await request.json();
    if (!isRecord(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return null;
    return value;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(context: Context) {
  return context.json({ error: { code: "evidence-window-request-invalid" } }, 400);
}

function registrationErrorResponse(context: Context, error: unknown) {
  const code =
    error instanceof EvidenceWindowRegistrationError ? error.code : ("evidence-window-storage-failed" as const);
  if (code === "evidence-window-unknown") return context.json({ error: { code } }, 404);
  if (code === "evidence-window-storage-failed") return context.json({ error: { code } }, 500);
  return context.json({ error: { code } }, 409);
}

function sanitizeStorageError(error: unknown): EvidenceWindowRegistrationError {
  if (error instanceof EvidenceWindowRegistrationError) return error;
  if (isUniqueViolation(error)) return new EvidenceWindowRegistrationError("evidence-window-already-open");
  return new EvidenceWindowRegistrationError("evidence-window-storage-failed");
}

function isUniqueViolation(error: unknown) {
  return isRecord(error) && error.code === "23505" && error.constraint === "evidence_window_single_open_idx";
}

function requireRow<Row>(row: Row | undefined): Row {
  if (!row) throw new EvidenceWindowRegistrationError("evidence-window-storage-failed");
  return row;
}

function mapClosedRow(row: EvidenceWindowClosedRow) {
  return {
    windowId: row.window_id,
    state: "closed" as const,
    closedAt: formatInstant(row.closed_at),
    version: Number(row.version),
  };
}

function formatInstant(value: Date | string) {
  return new Date(value).toISOString();
}
