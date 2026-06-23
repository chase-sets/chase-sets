import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  decodeCommitReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import type { AuthServices } from "../runtime-support/services";
import { registerRegistrationRoutes } from "./register-routes";
import type { AuthApiEnv } from "./support";

const { mockCreateIdentityAuthRequestClient, mockStartInteractiveAuth } = vi.hoisted(() => ({
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockStartInteractiveAuth: vi.fn(),
}));

vi.mock("../runtime-support/services", () => ({
  startInteractiveAuth: mockStartInteractiveAuth,
}));

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
}));

function buildApp(services: unknown) {
  return createTestApp<AuthApiEnv>({
    actor: createAnonymousTestActor(),
    context: createTestEventStoreContext(
      createInternalSystemTestActor({
        userId: "usr_test",
        accountId: "acc_test",
      }),
      {
        tenantId: "ten_test",
        trace: {},
      },
    ),
    routes: (app) => {
      registerRegistrationRoutes(app, services as AuthServices);
    },
  });
}

function createServices() {
  return {
    db: {
      query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })),
    },
    auth: {
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserByEmail: vi.fn(async () => null),
    },
  };
}

function withCommandReceipt<T extends object>(body: T, source: SourceCommitPosition): T {
  Object.defineProperty(body, "commandReceipt", {
    value: {
      mode: "eventual",
      commitEventIds: source.eventIds,
      commitPositions: [source],
    },
    enumerable: false,
  });
  return body;
}

useMockReset();

describe("registration auth routes", () => {
  it("writes the registered identity into the Auth mirrors before returning a session", async () => {
    const services = createServices();
    const identitySource = {
      sourceContextName: "identity",
      maxGlobalPosition: "51",
      eventIds: ["evt_identity_51"],
    } as const satisfies SourceCommitPosition;
    const credentialSource = {
      sourceContextName: "identity",
      maxGlobalPosition: "53",
      eventIds: ["evt_identity_53"],
    } as const satisfies SourceCommitPosition;
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createPersonalIdentity: vi.fn(async () =>
        withCommandReceipt(
          {
            userId: "usr_new",
            accountId: "acc_new",
            membershipId: "mbr_new",
          },
          identitySource,
        ),
      ),
      enablePasswordCredential: vi.fn(async () =>
        withCommandReceipt(
          {
            ok: true,
            userId: "usr_new",
            snapshots: [],
          },
          credentialSource,
        ),
      ),
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_new",
      sessionToken: "session_token",
      session: { session_id: "ses_new", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const response = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: " New.User@ChaseSets.test ",
        password: "correct horse battery staple",
        displayName: "New User",
      }),
    });

    expect(response.status).toBe(201);
    expect(decodeCommitReceipt(response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "53",
        eventIds: ["evt_identity_51", "evt_identity_53"],
      },
    ]);
    const body = await response.json();
    expect(body).toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
      accountId: "acc_new",
    });
    expect(body).not.toHaveProperty("commandReceipt");
    expect(JSON.stringify(body)).not.toContain("commandReceipt");

    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO auth_identity_users"),
      expect.arrayContaining(["usr_new", "New User", "new.user@chasesets.test"]),
    );
    const userMirrorCall = services.db.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO auth_identity_users"),
    );
    expect(JSON.parse(String(userMirrorCall?.[1]?.[6]))).toMatchObject([
      {
        type: "email",
        value: "new.user@chasesets.test",
      },
    ]);
    expect(JSON.parse(String(userMirrorCall?.[1]?.[7]))).toEqual(["password"]);
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO auth_identity_user_emails"),
      expect.arrayContaining(["new.user@chasesets.test", "usr_new"]),
    );
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO auth_identity_user_memberships"),
      expect.arrayContaining(["mbr_new", "usr_new", "acc_new", "owner"]),
    );
    const membershipMirrorCall = services.db.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO auth_identity_user_memberships"),
    );
    expect(JSON.parse(String(membershipMirrorCall?.[1]?.[4]))).toContain("listings.view");
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        userId: "usr_new",
        accountId: "acc_new",
        membershipsOverride: [
          expect.objectContaining({
            membershipId: "mbr_new",
            accountId: "acc_new",
            roleKey: "owner",
            status: "active",
          }),
        ],
      }),
    );
  });
});
