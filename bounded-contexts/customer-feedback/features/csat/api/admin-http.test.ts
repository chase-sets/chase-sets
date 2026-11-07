import { ROLE_PERMISSIONS, type AuthenticatedApiEnv, type ResolvedActor } from "@chase-sets/auth-context";
import { resolveActorFromRequest } from "../../../../auth/server";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildMembershipProjectionHandlers } from "../../../../identity/features/memberships/read-model/projection";
import { buildCustomerFeedbackAttentionApi } from "../../attention/api/route";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildCustomerFeedbackApi } from "./admin-http";
import type { CsatAdminReadPort } from "./runtime";

const actor = (permissions: readonly string[], userId = "usr_test"): ResolvedActor => ({
  sessionId: "ses_test",
  tenantId: "tnt_test",
  userId,
  accountId: "acc_test",
  membershipId: "mem_test",
  roleKey: "platform-admin",
  permissions,
});

function port(): CsatAdminReadPort {
  const artifacts = new Map<
    string,
    { exportId: string; actorId: string; artifactExpiresAt: string; artifactContent: string }
  >();
  return {
    readAdminAnalytics: vi.fn(async () => ({ analytics: true }) as never),
    listAdminQueue: vi.fn(
      async () =>
        ({
          items: [
            {
              invitationId: "=unsafe",
              state: "submitted",
              surveyVersion: { surveyKind: "transactional-csat", surveyVersion: "v1", questionVersion: "q1" },
              outcomeCode: "checkout.completed",
              customerRole: "buyer",
              eligibleAt: "2026-07-13T00:00:00.000Z",
              issuedAt: null,
              presentedAt: null,
              submittedAt: null,
              dismissedAt: null,
              expiredAt: null,
              rating: 5,
              followUpConsent: false,
            },
          ],
          nextCursor: null,
          previousCursor: null,
          limit: 100,
        }) satisfies Awaited<ReturnType<CsatAdminReadPort["listAdminQueue"]>>,
    ),
    recordAdminExport: vi.fn(async (audit) => {
      if (audit.artifactContent && audit.exportId) {
        artifacts.set(audit.exportId, {
          exportId: audit.exportId,
          actorId: audit.actorId,
          artifactExpiresAt: audit.artifactExpiresAt,
          artifactContent: audit.artifactContent,
        });
      }
    }),
    getAdminExportArtifact: vi.fn(async (exportId, actorId, fetchedAt) => {
      const artifact = artifacts.get(exportId);
      return artifact &&
        artifact.exportId === exportId &&
        artifact.actorId === actorId &&
        Date.parse(artifact.artifactExpiresAt) > Date.parse(fetchedAt)
        ? artifact
        : null;
    }),
    resolveRetentionPolicy: vi.fn(async () => ({ exportArtifactHours: 24 }) as never),
  };
}

function appFor(permissions: readonly string[], readPort = port(), userId = "usr_test") {
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor(permissions, userId));
    await next();
  });
  app.route("/", buildCustomerFeedbackApi(readPort));
  return { app, readPort };
}

function sessionExportApp(
  roleKey = "platform-admin",
  storedPermissions = ["platform-feedback.export", "platform-feedback.view", "platform-feedback.manage"],
) {
  const membership = {
    membership_id: "mem_existing",
    user_id: "usr_existing",
    account_id: "acc_existing",
    role_key: roleKey,
    role_permissions: [...storedPermissions],
    status: "active",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const services = {
    db: {
      query: vi.fn(async () => ({
        rows: [{ session_id: "ses_existing", token_hash: "hashed:existing", expires_at: expiresAt }],
      })),
    },
    auth: { hashSecret: (token: string) => `hashed:${token}` },
    identity: {
      bootstrapTenantId: "tnt_existing",
      getUser: vi.fn(async () => null),
      getActiveMembershipForUserAccount: vi.fn(async () => (membership.status === "active" ? membership : null)),
    },
    sessions: {
      getSession: vi.fn(async () => null),
      readAuthenticatedSession: vi.fn(async () => ({
        state: {
          id: "ses_existing",
          userId: "usr_existing",
          accountId: "acc_existing",
          availableAccountIds: ["acc_existing"],
          authenticationMethod: "password",
          status: "active",
          expiresAt,
        },
        authenticatedAt: "2026-01-01T00:00:00.000Z",
      })),
    },
  } as unknown as Parameters<typeof resolveActorFromRequest>[0];
  const projected = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes("SET role_key = $2")) {
      membership.role_key = String(values![1]);
      membership.role_permissions = JSON.parse(String(values![2]));
    }
    if (sql.includes("SET status = 'revoked'")) membership.status = "revoked";
    return { rows: [membership] };
  });
  const projections = buildMembershipProjectionHandlers({ query: projected } as never);
  const readPort = port();
  const actors: Array<ResolvedActor | null> = [];
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    const resolved = await resolveActorFromRequest(services, c.req.raw);
    actors.push(resolved);
    c.set("actor", resolved);
    await next();
  });
  app.route("/api/customer-feedback", buildCustomerFeedbackApi(readPort));
  app.route(
    "/api/customer-feedback",
    buildCustomerFeedbackAttentionApi({
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cases: { executeByCaseId: vi.fn() },
      invitations: readPort,
    }),
  );
  const request = (path: string, signedIn = true) =>
    app.request(`/api/customer-feedback${path}`, {
      headers: signedIn ? { cookie: "chase_sets_session=existing" } : {},
    });
  return { membership, actors, projected, readPort, request, projections };
}

describe("existing membership real HTTP/session export authority", () => {
  it.each(["identity.membership.role-changed", "identity.membership.revoked"])(
    "converges old stored grants without rewriting them, then denies both exports after %s processing",
    async (eventType) => {
      const fixture = sessionExportApp();
      const before = structuredClone(fixture.membership);
      const ids: string[] = [];
      for (const path of ["/export", "/attention/export"]) {
        const response = await fixture.request(`${path}?reason=case-review`);
        expect(response.status).toBe(201);
        const created = (await response.json()) as { exportId: string };
        ids.push(created.exportId);
        expect((await fixture.request(`/export/${created.exportId}`)).status).toBe(200);
      }
      expect(fixture.membership).toEqual(before);
      expect(fixture.projected).not.toHaveBeenCalled();
      expect(before.role_permissions).not.toContain("customer-feedback.privacy.export-sensitive-feedback");
      for (const resolved of fixture.actors)
        expect(resolved?.permissions).toContain("customer-feedback.privacy.export-sensitive-feedback");
      await fixture.projections[eventType]!(
        buildTransportEvent(eventType, { roleKey: "owner" }, { streamId: "identity.membership-mem_existing" }),
      );
      for (const path of [
        "/export?reason=case-review",
        "/attention/export?reason=case-review",
        ...ids.map((id) => `/export/${id}`),
      ]) {
        expect((await fixture.request(path)).status).toBe(eventType.endsWith("revoked") ? 401 : 403);
      }
    },
  );

  it.each([
    ...["owner", "manager", "fulfillment", "viewer"].map((role) => ({
      role,
      grants: [...ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS]] as string[],
    })),
    { role: "support", grants: ["platform-feedback.view", "platform-feedback.manage"] },
    { role: "support", grants: ["platform-feedback.export"] },
  ])("denies both exports and download to session role $role with $grants", async ({ role, grants }) => {
    const fixture = sessionExportApp(role, grants);
    for (const path of ["/export?reason=case-review", "/attention/export?reason=case-review", "/export/missing"]) {
      expect((await fixture.request(path)).status).toBe(403);
    }
    expect(fixture.readPort.recordAdminExport).not.toHaveBeenCalled();
  });

  it("denies signed-out creation and download on both paths", async () => {
    const fixture = sessionExportApp();
    for (const path of ["/export?reason=case-review", "/attention/export?reason=case-review", "/export/missing"]) {
      expect((await fixture.request(path, false)).status).toBe(401);
    }
    expect(fixture.readPort.recordAdminExport).not.toHaveBeenCalled();
  });
});

describe("Customer Feedback admin API", () => {
  it.each([undefined, "", "customer comment text", "x", "case_review", "=formula"])(
    "rejects missing or malformed export reason %s without generating an artifact",
    async (reason) => {
      const { app, readPort } = appFor(["customer-feedback.privacy.export-sensitive-feedback"]);
      const query = reason === undefined ? "" : `?reason=${encodeURIComponent(reason)}`;
      expect((await app.request(`/export${query}`)).status).toBe(400);
      expect(readPort.listAdminQueue).not.toHaveBeenCalled();
      expect(readPort.recordAdminExport).not.toHaveBeenCalled();
    },
  );

  it("exports every filtered page beyond 500 rows and audits normalized filters and reason", async () => {
    const readPort = port();
    const template = (await readPort.listAdminQueue({})).items[0]!;
    vi.mocked(readPort.listAdminQueue).mockClear();
    vi.mocked(readPort.listAdminQueue).mockImplementation(async (query) => {
      const offset = Number(query.cursor ?? 0);
      const count = Math.min(100, 603 - offset);
      return {
        items: Array.from({ length: count }, (_, index) => ({ ...template, invitationId: `inv_${offset + index}` })),
        nextCursor: offset + count < 603 ? String(offset + count) : null,
        previousCursor: null,
        limit: 100,
      };
    });
    const { app } = appFor(["customer-feedback.privacy.export-sensitive-feedback"], readPort);
    const createdResponse = await app.request(
      "/export?reason=%20CASE-REVIEW%20&from=2026-01-01&to=2026-12-01&surveyVersion=v1&outcomeCodes=checkout.completed,checkout.completed&customerRoles=buyer&states=submitted&ratings=5,4,5&followUpConsent=granted&limit=1&cursor=ignored",
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { exportId: string; rowCount: number };
    expect(created.rowCount).toBe(603);
    expect(readPort.listAdminQueue).toHaveBeenCalledTimes(7);
    for (const [query] of vi.mocked(readPort.listAdminQueue).mock.calls) {
      expect(query).toMatchObject({
        from: "2026-01-01",
        to: "2026-12-01",
        surveyVersion: { surveyVersion: "v1" },
        outcomeCodes: ["checkout.completed"],
        customerRoles: ["buyer"],
        states: ["submitted"],
        ratings: [4, 5],
        followUpConsent: "granted",
        direction: "next",
        limit: 100,
      });
    }
    const csv = await (await app.request(`/export/${created.exportId}`)).text();
    expect(csv.trim().split("\n")).toHaveLength(604);
    expect(csv).toContain('"inv_602"');
    expect(readPort.recordAdminExport).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "case-review",
        rowCount: 603,
        result: "completed",
        capability: "customer-feedback.privacy.export-sensitive-feedback",
        filters: expect.objectContaining({ ratings: [4, 5], states: ["submitted"] }),
      }),
    );
  });

  it("completes an empty export, but never exposes an artifact before its audit commits", async () => {
    let readPort = port();
    vi.mocked(readPort.listAdminQueue).mockResolvedValue({
      items: [],
      nextCursor: null,
      previousCursor: null,
      limit: 100,
    });
    const persist = readPort.recordAdminExport;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auditStarted = vi.fn();
    readPort = {
      ...readPort,
      recordAdminExport: vi.fn(async (audit) => {
        auditStarted();
        await delayed;
        await persist(audit);
      }),
    };
    const { app } = appFor(["customer-feedback.privacy.export-sensitive-feedback"], readPort);
    let finished = false;
    const pending = Promise.resolve(app.request("/export?reason=case-review")).then((response) => {
      finished = true;
      return response;
    });
    await vi.waitFor(() => expect(auditStarted).toHaveBeenCalled());
    expect(finished).toBe(false);
    release();
    const response = await pending;
    expect(response.status).toBe(201);
    const created = (await response.json()) as { exportId: string; rowCount: number };
    expect(created.rowCount).toBe(0);
    const download = await app.request(`/export/${created.exportId}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Cache-Control")).toBe("no-store");
    expect((await download.text()).trim().split("\n")).toHaveLength(1);
  });

  it("records failed generation or failed audit without an artifact", async () => {
    for (const failure of ["query", "later-page", "audit"]) {
      const readPort = port();
      if (failure === "query") vi.mocked(readPort.listAdminQueue).mockRejectedValueOnce(new Error("query failure"));
      else if (failure === "later-page") {
        const first = await readPort.listAdminQueue({});
        vi.mocked(readPort.listAdminQueue)
          .mockResolvedValueOnce({ ...first, nextCursor: "second-page" })
          .mockRejectedValueOnce(new Error("later page failure"));
      } else vi.mocked(readPort.recordAdminExport).mockRejectedValueOnce(new Error("audit failure"));
      const { app } = appFor(["customer-feedback.privacy.export-sensitive-feedback"], readPort);
      expect((await app.request("/export?reason=case-review")).status).toBe(500);
      const failed = vi.mocked(readPort.recordAdminExport).mock.calls.at(-1)![0];
      expect(failed).toMatchObject({
        result: "failed",
        artifactContent: null,
        failureCode: "export-generation-failed",
      });
      if (failure === "later-page") expect(failed.rowCount).toBe(1);
      expect((await app.request(`/export/${failed.exportId}`)).status).toBe(404);
    }
  });
  it("allows view staff to read projection analytics and queue data", async () => {
    const { app, readPort } = appFor(["platform-feedback.view"]);
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(readPort.readAdminAnalytics).toHaveBeenCalled();
    expect(readPort.listAdminQueue).toHaveBeenCalled();
  });

  it("keeps export behind the separate capability and neutralizes formula cells", async () => {
    const denied = await appFor(["platform-feedback.view"]).app.request("/export?reason=case-review");
    expect(denied.status).toBe(403);

    const { app, readPort } = appFor(["customer-feedback.privacy.export-sensitive-feedback"]);
    const response = await app.request("/export?reason=case-review");
    const created = (await response.json()) as { exportId: string };
    expect(response.status).toBe(201);
    const download = await app.request(`/export/${created.exportId}`);
    const body = await download.text();
    expect(download.status).toBe(200);
    expect(body).toContain("'=unsafe");
    expect(body).not.toContain("comment");
    expect(readPort.recordAdminExport).toHaveBeenCalledWith(
      expect.objectContaining({ result: "completed", rowCount: 1, reason: "case-review" }),
    );
  });

  it("fails closed when another actor fetches an export or its artifact has expired", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
      const readPort = port();
      const creator = appFor(["customer-feedback.privacy.export-sensitive-feedback"], readPort);
      const created = (await (await creator.app.request("/export?reason=case-review")).json()) as { exportId: string };

      const otherActor = appFor(["customer-feedback.privacy.export-sensitive-feedback"], readPort, "usr_different");
      expect((await otherActor.app.request(`/export/${created.exportId}`)).status).toBe(404);

      vi.setSystemTime(new Date("2026-07-15T00:00:00.001Z"));
      expect((await creator.app.request(`/export/${created.exportId}`)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects anonymous reads", async () => {
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", null);
      await next();
    });
    app.route("/", buildCustomerFeedbackApi(port()));
    expect((await app.request("/")).status).toBe(401);
  });
});
