import { vi } from "vitest";
import type { OperatorSessionMetadata } from "../../ui/admin-panel/operator-session-http";

// Controlled HTTP for the three Admin operator-session routes: every browser
// request must be scripted in order, and unscripted requests fail loudly. All
// bearers, cookies and error markers here are synthetic.
export const metadataPath = "/api/catalog/operator-session";
export const grantPath = "/api/catalog/operator-session/grant";
export const syntheticGrant = "SYNTHETIC_GRANT_A".padEnd(43, "a");
export const syntheticGrantB = "SYNTHETIC_GRANT_B".padEnd(43, "b");
export const hostileMarker = "HOSTILE-SYNTHETIC-COOKIE-MARKER";

type Method = "GET" | "POST" | "DELETE";
type Respond = () => Promise<Response>;

export function createControlledHttp() {
  const requests: string[] = [];
  const scripted = new Map<string, Respond[]>();
  const enqueue = (method: Method, path: string, respond: Respond) => {
    const key = `${method} ${path}`;
    scripted.set(key, [...(scripted.get(key) ?? []), respond]);
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    requests.push(key);
    const respond = scripted.get(key)?.shift();
    if (!respond) throw new TypeError(`unscripted ${key}`);
    return respond();
  });

  return {
    fetch,
    requests,
    reply(method: Method, path: string, status: number, body: unknown) {
      enqueue(method, path, async () => json(status, body));
    },
    replyText(method: Method, path: string, status: number, text: string) {
      enqueue(method, path, async () => new Response(text, { status }));
    },
    networkFailure(method: Method, path: string) {
      enqueue(method, path, async () => {
        throw new TypeError(`synthetic network failure ${hostileMarker}`);
      });
    },
    defer(method: Method, path: string) {
      let settle: (response: Response) => void = () => undefined;
      const response = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      enqueue(method, path, () => response);
      return { reply: (status: number, body: unknown) => settle(json(status, body)) };
    },
  };
}

export type ControlledHttp = ReturnType<typeof createControlledHttp>;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const storedAt = "2026-09-30T12:00:00.000Z";
export const browserExpiresAt = "2026-12-30T12:00:00.000Z";
export const activeGrant = {
  active: true,
  createdAt: "2026-09-29T08:00:00.000Z",
  idleExpiresAt: "2026-10-29T08:00:00.000Z",
  lastUsedAt: "2026-09-30T12:00:00.000Z",
} as const;
export const inactiveGrant = { ...activeGrant, active: false } as const;

export function absentMetadata(overrides: Partial<OperatorSessionMetadata> = {}): OperatorSessionMetadata {
  return { revision: 0, storedAt: null, browserExpiresAt: null, custodyAvailable: true, grant: null, ...overrides };
}

export function storedMetadata(revision: number, overrides: Partial<OperatorSessionMetadata> = {}) {
  return absentMetadata({ revision, storedAt, browserExpiresAt, ...overrides });
}

export function clearedMetadata(revision: number, overrides: Partial<OperatorSessionMetadata> = {}) {
  return absentMetadata({ revision, ...overrides });
}

export const stepUpRequired = { code: "step_up_required" };
// Body messages carry only the synthetic marker; the panel must never render them.
export const payoutNestedStepUp = { error: { code: "step_up_required", message: hostileMarker } };
export const hostForbidden = { error: { code: "authorization_forbidden", message: hostileMarker } };
export const flatForbidden = { code: "forbidden" };
