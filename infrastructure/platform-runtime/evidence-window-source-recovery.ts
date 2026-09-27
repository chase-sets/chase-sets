import { Hono } from "hono";
import type { OrderingOrderServices } from "@chase-sets/ordering/server";
import { verifyPlatformInternalAuthSecret } from "./internal-auth";
import {
  EVIDENCE_WINDOW_ADMISSION_HEADER,
  EVIDENCE_WINDOW_ID_PATTERN,
  type EvidenceWindowAuthoritySnapshot,
  type EvidenceWindowById,
} from "./evidence-window-registration";

export type EvidenceWindowSourceRecoveryRoutesOptions = Readonly<{
  admissionSecret: string;
  authority: EvidenceWindowAuthoritySnapshot;
  registrationById: (windowId: string) => Promise<EvidenceWindowById | null>;
  sources: OrderingOrderServices["evidenceWindowSources"];
}>;

export function createEvidenceWindowSourceRecoveryRoutes(options: EvidenceWindowSourceRecoveryRoutesOptions) {
  const routes = new Hono();
  const refusal = (header: string | undefined) =>
    !verifyPlatformInternalAuthSecret(header ?? "", options.admissionSecret)
      ? { status: 403 as const, code: "evidence-window-admission-rejected" }
      : options.authority.effectiveMode !== "test"
        ? { status: 409 as const, code: "evidence-window-mode-not-test" }
        : null;
  const readRegistration = async (
    windowId: string,
  ): Promise<
    | Readonly<{ kind: "found"; registration: EvidenceWindowById }>
    | Readonly<{ kind: "invalid" }>
    | Readonly<{ kind: "unknown" }>
    | Readonly<{ kind: "storage-failed" }>
  > => {
    if (!EVIDENCE_WINDOW_ID_PATTERN.test(windowId)) return { kind: "invalid" };
    try {
      const registration = await options.registrationById(windowId);
      return registration ? { kind: "found", registration } : { kind: "unknown" };
    } catch {
      return { kind: "storage-failed" };
    }
  };

  routes.get("/:windowId/sources", async (c) => {
    const header = c.req.header(EVIDENCE_WINDOW_ADMISSION_HEADER);
    const denied = refusal(header);
    if (denied) return c.json({ error: { code: denied.code } }, denied.status);
    if (new URL(c.req.url).search || (await c.req.text()))
      return c.json({ error: { code: "evidence-window-request-invalid" } }, 400);
    const lookup = await readRegistration(c.req.param("windowId"));
    if (lookup.kind === "invalid") return c.json({ error: { code: "evidence-window-request-invalid" } }, 400);
    if (lookup.kind === "unknown") return c.json({ error: { code: "evidence-window-unknown" } }, 404);
    if (lookup.kind === "storage-failed")
      return c.json({ error: { code: "evidence-window-source-storage-failed" } }, 500);
    const { registration } = lookup;
    try {
      const sources = await options.sources.read(registration.windowId);
      return c.json({ sources });
    } catch {
      return c.json({ error: { code: "evidence-window-source-storage-failed" } }, 500);
    }
  });

  routes.post("/:windowId/sources/:subInvocation/close", async (c) => {
    const header = c.req.header(EVIDENCE_WINDOW_ADMISSION_HEADER);
    const denied = refusal(header);
    if (denied) return c.json({ error: { code: denied.code } }, denied.status);
    const lookup = await readRegistration(c.req.param("windowId"));
    if (lookup.kind === "invalid") return c.json({ error: { code: "evidence-window-request-invalid" } }, 400);
    if (lookup.kind === "unknown") return c.json({ error: { code: "evidence-window-unknown" } }, 404);
    if (lookup.kind === "storage-failed")
      return c.json({ error: { code: "evidence-window-source-storage-failed" } }, 500);
    const { registration } = lookup;
    const subInvocation = c.req.param("subInvocation");
    const body = await readClosedBody(c.req.raw, ["expectedVersion"]);
    if (
      (subInvocation !== "2a" && subInvocation !== "2b") ||
      !body ||
      !Number.isInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 1 ||
      Number(body.expectedVersion) >= 2147483647
    ) {
      return c.json({ error: { code: "evidence-window-request-invalid" } }, 400);
    }
    try {
      const source = (await options.sources.read(registration.windowId)).find(
        (item) => item.subInvocation === subInvocation,
      );
      if (!source) return c.json({ error: { code: "evidence-window-source-unknown" } }, 404);
      if (source.windowOpenedAt !== registration.openedAt || Date.parse(source.windowOpenedAt) > Date.now()) {
        return c.json({ error: { code: "evidence-window-source-timing-mismatch" } }, 409);
      }
      const result = await options.sources.close({
        windowId: registration.windowId,
        subInvocation,
        expectedVersion: Number(body.expectedVersion),
      });
      return c.json(result, result.outcome === "stale" ? 409 : result.outcome === "unknown" ? 404 : 200);
    } catch {
      return c.json({ error: { code: "evidence-window-source-storage-failed" } }, 500);
    }
  });

  routes.post("/:windowId/sources/:subInvocation/release", async (c) => {
    const header = c.req.header(EVIDENCE_WINDOW_ADMISSION_HEADER);
    const denied = refusal(header);
    if (denied) return c.json({ error: { code: denied.code } }, denied.status);
    const lookup = await readRegistration(c.req.param("windowId"));
    if (lookup.kind === "invalid") return c.json({ error: { code: "evidence-window-request-invalid" } }, 400);
    if (lookup.kind === "unknown") return c.json({ error: { code: "evidence-window-unknown" } }, 404);
    if (lookup.kind === "storage-failed")
      return c.json({ error: { code: "evidence-window-source-storage-failed" } }, 500);
    const { registration } = lookup;
    const subInvocation = c.req.param("subInvocation");
    const body = await readClosedBody(c.req.raw, ["windowOpenedAt"]);
    if (
      (subInvocation !== "2a" && subInvocation !== "2b") ||
      !body ||
      typeof body.windowOpenedAt !== "string" ||
      body.windowOpenedAt !== registration.openedAt ||
      Date.parse(body.windowOpenedAt) > Date.now()
    ) {
      return c.json({ error: { code: "evidence-window-request-invalid" } }, 400);
    }
    try {
      const source = (await options.sources.read(registration.windowId)).find(
        (item) => item.subInvocation === subInvocation,
      );
      if (!source) return c.json({ error: { code: "evidence-window-source-unknown" } }, 404);
      if (source.windowOpenedAt !== registration.openedAt) {
        return c.json({ error: { code: "evidence-window-source-timing-mismatch" } }, 409);
      }
      const report = await options.sources.release({
        sourceIdentity: source.sourceIdentity,
        windowOpenedAt: registration.openedAt,
      });
      return report
        ? c.json({ report }, report.outcome === "unknown" || report.outcome === "owed" ? 409 : 200)
        : c.json({ error: { code: "evidence-window-source-unknown" } }, 404);
    } catch {
      return c.json({ error: { code: "evidence-window-source-storage-failed" } }, 500);
    }
  });

  return routes;
}

async function readClosedBody(request: Request, keys: readonly string[]) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const actual = Object.keys(record).sort();
    return actual.length === keys.length && actual.every((key, index) => key === keys[index]) ? record : null;
  } catch {
    return null;
  }
}
