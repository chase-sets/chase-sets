import { createServer, type ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCommitReceipt } from "@chase-sets/http/responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSyntheticMarketplaceAccount,
  privilegedRequest,
  projectionCheckpointResponseBodyLimitBytes,
  registrationSuccessResponseBodyLimitBytes,
  registerOrSignInSyntheticAccount,
  signInWithPassword,
  syntheticMarketplaceAccountFor,
} from "../e2e/support/auth";

type RequestCall = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
}>;

type FakeRoute = (call: RequestCall) => FakeResponse | Promise<FakeResponse>;

class FakeResponse {
  public constructor(
    private readonly statusCode: number,
    private readonly responseBody: unknown = {},
    private readonly responseHeaders: Record<string, string> = {},
    private readonly rawBody?: string,
  ) {}

  public status() {
    return this.statusCode;
  }

  public async json() {
    return this.responseBody;
  }

  public async body() {
    return Buffer.from(this.rawBody ?? JSON.stringify(this.responseBody));
  }

  public headers() {
    return this.responseHeaders;
  }

  public toFetchResponse() {
    return new Response(JSON.stringify(this.responseBody), {
      status: this.statusCode,
      headers: { "content-type": "application/json", ...this.responseHeaders },
    });
  }
}

function createFakePage(route: FakeRoute) {
  const calls: RequestCall[] = [];
  const cookies: { name: string; value: string }[] = [];
  const page = {
    request: {
      post: vi.fn(async (url: string, options: { headers?: Record<string, string>; data?: unknown } = {}) => {
        const call = { method: "POST", url, headers: options.headers, data: options.data } as const;
        calls.push(call);
        return route(call);
      }),
      get: vi.fn(async (url: string, options: { headers?: Record<string, string> } = {}) => {
        const call = { method: "GET", url, headers: options.headers } as const;
        calls.push(call);
        return route(call);
      }),
    },
    context: () => ({
      addCookies: vi.fn(async (newCookies: { name: string; value: string }[]) => {
        cookies.push(...newCookies);
      }),
      cookies: vi.fn(async () => cookies),
    }),
    waitForTimeout: vi.fn(async () => undefined),
  };

  return { calls, cookies, page: page as never };
}

function stubPrivilegedFetch(route: FakeRoute) {
  const calls: RequestCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const data = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const call = {
        method: init.method === "GET" ? "GET" : "POST",
        url,
        headers,
        data,
      } as const;
      calls.push(call);
      return (await route(call)).toFetchResponse();
    }),
  );
  return calls;
}

const account = {
  email: "critical-flow-run@example.test",
  password: "synthetic-password",
  displayName: "Critical Flow Run",
};

const registrationFailureCases: readonly (readonly [string, FakeResponse, string])[] = [
  ["malformed-success", new FakeResponse(201, {}), "invalid-response"],
  ["invalid-json", new FakeResponse(201, {}, {}, "{secret-json-marker"), "invalid-json"],
  ["oversize-token", new FakeResponse(201, { sessionToken: `session_${"x".repeat(37)}` }), "invalid-response"],
  ["unexpected-status", new FakeResponse(500, { token: "secret-token-marker" }), "unexpected-status"],
];

function withPlatformAdminEnv() {
  process.env.PLATFORM_ADMIN_EMAIL = "platform-admin@example.test";
  process.env.PLATFORM_ADMIN_PASSWORD = "platform-admin-password";
}

afterEach(() => {
  delete process.env.PLATFORM_ADMIN_EMAIL;
  delete process.env.PLATFORM_ADMIN_PASSWORD;
  delete process.env.TF_VAR_platform_admin_email;
  delete process.env.TF_VAR_platform_admin_password;
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ATTEMPT;
  delete process.env.CHASE_SETS_E2E_INVOCATION_NAMESPACE;
  vi.unstubAllGlobals();
});

describe("marketplace smoke auth support", () => {
  it("synthetic account identity uses the complete test identity and invocation namespace", () => {
    const identity = {
      invocationNamespace: "run-100:1",
      projectName: "marketplace-chromium",
      specPath: "deployables\\marketplace\\e2e\\buy-funnel-redesign.spec.ts",
      titlePath: ["buy funnel redesign", "authenticated buy cart satisfies all redesign acceptance signals"],
    } as const;
    const candidate = createSyntheticMarketplaceAccount(identity);
    const retryOne = createSyntheticMarketplaceAccount(identity);
    const workerOne = createSyntheticMarketplaceAccount(identity);
    const differentTitle = createSyntheticMarketplaceAccount({
      ...identity,
      titlePath: ["buy funnel redesign", "authenticated buy checkout confirmation satisfies redesign contracts"],
    });
    const differentInvocation = createSyntheticMarketplaceAccount({
      ...identity,
      invocationNamespace: "run-100:2",
    });

    expect(retryOne).toEqual(candidate);
    expect(workerOne).toEqual(candidate);
    for (const field of ["email", "password", "displayName"] as const) {
      expect(differentTitle[field]).not.toBe(candidate[field]);
      expect(differentInvocation[field]).not.toBe(candidate[field]);
      expect(candidate[field]).toContain(candidate.identityDigest);
    }
    expect(candidate.identityDigest).toMatch(/^[0-9a-f]{64}$/);

    const predecessorDisplayName = (runId: string, nonce: string, workerIndex: number, retry: number) =>
      `Buy Funnel ${runId} ${nonce} ${workerIndex} ${retry}`;
    const predecessorPassword = (_title: string, runId: string, workerIndex: number, retry: number) =>
      `buy-funnel-${runId}-${workerIndex}-${retry}`;
    const reservedDisplayNames = new Set<string>();
    const reserve = (displayName: string) => {
      if (reservedDisplayNames.has(displayName)) {
        return { status: 409, body: { error: { code: "display_name_already_taken" } } };
      }
      reservedDisplayNames.add(displayName);
      return { status: 201, body: {} };
    };
    const firstPredecessorDisplayName = predecessorDisplayName("run-100", "nonce", 0, 0);
    const secondPredecessorDisplayName = predecessorDisplayName("run-100", "nonce", 0, 0);

    expect(reserve(firstPredecessorDisplayName).status).toBe(201);
    expect(reserve(secondPredecessorDisplayName)).toEqual({
      status: 409,
      body: { error: { code: "display_name_already_taken" } },
    });
    const predecessorFirstTitle = "authenticated buy cart satisfies all redesign acceptance signals";
    const predecessorSecondTitle = "authenticated buy checkout confirmation satisfies redesign contracts";
    expect(predecessorFirstTitle).not.toBe(predecessorSecondTitle);
    expect(predecessorPassword(predecessorFirstTitle, "run-100", 0, 0)).toBe(
      predecessorPassword(predecessorSecondTitle, "run-100", 0, 0),
    );
  });

  it("fails closed when a local invocation namespace is absent", () => {
    expect(() =>
      syntheticMarketplaceAccountFor({
        file: "deployables/marketplace/e2e/buy-funnel-redesign.spec.ts",
        project: { name: "marketplace-chromium" },
        titlePath: ["checkout"],
      } as never),
    ).toThrow("synthetic account setup failed (missing-local-invocation-namespace)");
  });

  it("derives the complete helper caller census from repository source", () => {
    const census = marketplaceAuthCallerCensus();

    expect(census.synthetic).toEqual([
      "account-payment.spec.ts",
      "buy-funnel-redesign.spec.ts",
      "critical-flows.spec.ts",
      "sell-list-evidence.spec.ts",
      "support/auth-trace-artifact.probe.spec.ts",
    ]);
    expect(census.directOnly).toEqual([
      "account-payment-stripe-embed.uat.spec.ts",
      "listing-evidence-readiness.spec.ts",
      "payout-connect-appearance.uat.spec.ts",
      "seller-desk-journey.uat.spec.ts",
      "support-case-detail.spec.ts",
    ]);
    expect(census.synthetic).not.toContain("seller-desk-journey.uat.spec.ts");

    const e2eRoot = join(process.cwd(), "e2e");
    const sellListSource = readFileSync(join(e2eRoot, "sell-list-evidence.spec.ts"), "utf8");
    const sellerDeskSource = readFileSync(join(e2eRoot, "seller-desk-journey.uat.spec.ts"), "utf8");
    expect(sellListSource).toContain("syntheticMarketplaceAccountFor(testInfo");
    expect(sellListSource).toContain('invocationNamespace: "marketplace-sell-list-evidence-seed/v1"');
    expect(sellerDeskSource).not.toContain("registerOrSignInSyntheticAccount");

    expect(
      authCallsInSource(`
        import { registerOrSignInSyntheticAccount as registerSynthetic } from "./support/auth";
        registerSynthetic(page, origin, account);
      `),
    ).toEqual({ synthetic: true, password: false });
  });

  it("reports a bounded account fingerprint and status without credential or response markers", async () => {
    const adversarialAccount = {
      email: "email-secret-marker@example.test",
      password: "password-secret-marker",
    };
    const { page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(401, {
          authorization: "authorization-secret-marker",
          token: "token-secret-marker",
        });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const error = await signInWithPassword(page, "https://marketplace.test", adversarialAccount).catch(
      (caught: unknown) => caught,
    );
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toMatch(/account=sha256:[0-9a-f]{12}, status=401/);
    expect(message).not.toContain(adversarialAccount.email);
    expect(message).not.toContain(adversarialAccount.password);
    expect(message).not.toContain("authorization-secret-marker");
    expect(message).not.toContain("token-secret-marker");
  });

  it("classifies privileged transport failures without credential or exception text", async () => {
    process.env.PLATFORM_ADMIN_EMAIL = "privileged-email-secret@example.invalid";
    process.env.PLATFORM_ADMIN_PASSWORD = "privileged-password-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("arbitrary-transport-exception-secret");
      }),
    );
    const { page } = createFakePage(() => {
      throw new Error("Playwright request transport must not be reached");
    });

    const error = await registerOrSignInSyntheticAccount(page, "https://marketplace.test", account).catch(
      (caught: unknown) => caught,
    );
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toBe("platform-admin password sign-in failed (network)");
    expect(message).not.toContain(process.env.PLATFORM_ADMIN_EMAIL);
    expect(message).not.toContain(process.env.PLATFORM_ADMIN_PASSWORD);
    expect(message).not.toContain("arbitrary-transport-exception-secret");
  });

  it("reproduces the 64 KiB full-snapshot failure with a production-shaped response", async () => {
    const body = createProductionShapedProjectionSnapshot();
    expect(Buffer.byteLength(body)).toBe(65_719);

    await withNativeServer(
      (path, response) => {
        expect(path).toBe("/api/platform/projections/refresh");
        writeResponse(response, 200, body, { "content-type": "application/json" });
      },
      async (origin) => {
        const error = await privilegedRequest(origin, "/api/platform/projections/refresh", {
          method: "POST",
          expectedStatus: 200,
          operation: "platform admin projection refresh",
          responseBodyLimitBytes: 64 * 1024,
        }).catch((caught: unknown) => caught);

        expect(readErrorMessage(error)).toBe("platform admin projection refresh failed (response-too-large)");
      },
    );
  });

  it("bounds the minimal checkpoint response through the native privileged request path", async () => {
    const secretMarkers = ["body-secret-marker", "header-secret-marker", "exception-secret-marker"];
    let resolvePartialBodyConnectionClosed: (() => void) | undefined;
    const partialBodyConnectionClosed = new Promise<void>((resolve) => {
      resolvePartialBodyConnectionClosed = resolve;
    });
    await withNativeServer(
      (path, response) => {
        if (path === "/largest-valid") {
          return writeJsonResponse(response, 200, { lastGlobalPosition: "9223372036854775807" });
        }
        if (path === "/cap-plus-one") {
          return writeResponse(response, 200, "x".repeat(projectionCheckpointResponseBodyLimitBytes + 1), {
            "content-type": "application/json",
          });
        }
        if (path === "/chunked-cap-crossing") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("x".repeat(projectionCheckpointResponseBodyLimitBytes));
          response.end("x");
          return;
        }
        if (path === "/partial-endless") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"lastGlobalPosition":"');
          response.once("close", () => {
            resolvePartialBodyConnectionClosed?.();
          });
          return;
        }
        if (path === "/malformed") {
          return writeResponse(response, 200, '{"body-secret-marker":', { "content-type": "application/json" });
        }
        if (path === "/wrong-content-type") {
          return writeResponse(response, 200, "body-secret-marker", {
            "content-type": "text/plain",
            "x-secret": "header-secret-marker",
          });
        }
        if (path === "/wrong-status") {
          return writeJsonResponse(response, 502, {
            error: "body-secret-marker",
            exception: "exception-secret-marker",
          });
        }
        throw new Error("unexpected native-server path");
      },
      async (origin) => {
        const request = (path: string, timeoutMs = 1_000) =>
          privilegedRequest(origin, path, {
            method: "POST",
            expectedStatus: 200,
            operation: "platform admin projection refresh",
            responseBodyLimitBytes: projectionCheckpointResponseBodyLimitBytes,
            timeoutMs,
          });

        await expect(request("/largest-valid")).resolves.toMatchObject({
          body: { lastGlobalPosition: "9223372036854775807" },
        });

        const controls = [
          ["/cap-plus-one", "response-too-large", 1_000],
          ["/chunked-cap-crossing", "response-too-large", 1_000],
          ["/partial-endless", "timeout", 100],
          ["/malformed", "invalid-json", 1_000],
          ["/wrong-content-type", "unexpected-content-type", 1_000],
          ["/wrong-status", "unexpected-status", 1_000],
        ] as const;
        for (const [path, classification, timeoutMs] of controls) {
          const startedAt = Date.now();
          const error = await request(path, timeoutMs).catch((caught: unknown) => caught);
          const message = readErrorMessage(error);
          expect(message).toBe(`platform admin projection refresh failed (${classification})`);
          expect(Date.now() - startedAt).toBeLessThan(2_000);
          for (const marker of secretMarkers) {
            expect(message).not.toContain(marker);
          }
          if (path === "/partial-endless") {
            await expect(waitForSignal(partialBodyConnectionClosed, 1_000)).resolves.toBeUndefined();
          }
        }
      },
    );
  });

  it("provisions a pending invitation through the platform admin before registering a synthetic account", async () => {
    withPlatformAdminEnv();
    const invitationReceipt = encodeCommitReceipt([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "42",
        eventIds: ["evt_invitation"],
      },
    ]);
    const privilegedCalls = stubPrivilegedFetch((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(200, { sessionToken: "admin_session" });
      }
      if (call.url.endsWith("/api/identity/current-actor-display")) {
        expect(call.headers?.cookie).toBe("chase_sets_session=admin_session");
        return new FakeResponse(200, { account: { account_id: "acc_platform" } });
      }
      if (call.url.endsWith("/api/identity/invitations")) {
        expect(call.headers?.cookie).toBe("chase_sets_session=admin_session");
        expect(call.data).toMatchObject({
          accountId: "acc_platform",
          email: account.email,
          roleKey: "viewer",
        });
        expect(call.data).toMatchObject({ invitationId: expect.stringMatching(/^ivt_e2e_[0-9a-f]{64}$/) });
        return new FakeResponse(
          201,
          { id: "ivt_smoke", status: "pending" },
          {
            "chase-sets-commit-receipt": invitationReceipt,
          },
        );
      }
      if (call.url.endsWith("/api/platform/projections/refresh-checkpoint")) {
        expect(call.headers?.cookie).toBe("chase_sets_session=admin_session");
        expect(call.data).toEqual({
          targetContextName: "auth",
          projectionName: "auth-identity-invitation-projection",
          sourceContextName: "identity",
        });
        return new FakeResponse(200, { lastGlobalPosition: "42" });
      }
      throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
    });
    const { calls, cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/registration-consent")) {
        return new FakeResponse(200, {
          bundleKey: "registration",
          requirements: [],
          resolvedAt: "2026-07-25T00:00:00.000Z",
          signature: "server-minted-test-signature",
        });
      }
      if (call.url.endsWith("/api/auth/register")) {
        expect(call.data).toMatchObject({
          email: account.email,
          password: account.password,
        });
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
    expect(privilegedCalls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh-checkpoint",
    ]);
    expect(cookies).toContainEqual(expect.objectContaining({ name: "chase_sets_session", value: "synthetic_session" }));
  });

  it.each(["pending", "accepted", "cancelled", "declined", "expired"])(
    "refuses a previously %s invitation aggregate without registration or sign-in",
    async () => {
      withPlatformAdminEnv();
      const privilegedCalls = stubPrivilegedFetch((call) => {
        if (call.url.endsWith("/api/auth/password-sign-in")) {
          return new FakeResponse(200, { sessionToken: "admin_session" });
        }
        if (call.url.endsWith("/api/identity/current-actor-display")) {
          return new FakeResponse(200, { account: { account_id: "acc_platform" } });
        }
        if (call.url.endsWith("/api/identity/invitations")) {
          return new FakeResponse(400, { error: { code: "validation_failed", message: "secret-body-marker" } });
        }
        throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
      });
      const { calls, cookies, page } = createFakePage(() => {
        throw new Error("Registration and password sign-in must not be reached");
      });

      const error = await registerOrSignInSyntheticAccount(page, "https://marketplace.test", account).catch(
        (caught: unknown) => caught,
      );

      expect(readErrorMessage(error)).toBe("synthetic invitation failed (invitation-already-authored)");
      expect(readErrorMessage(error)).not.toContain("secret-body-marker");
      expect(calls).toEqual([]);
      expect(cookies).toEqual([]);
      expect(privilegedCalls.filter((call) => call.url.endsWith("/api/identity/invitations"))).toHaveLength(1);
    },
  );

  it("uses one invitation aggregate after an interruption following the authoritative commit", async () => {
    withPlatformAdminEnv();
    let invitationAttempt = 0;
    const invitationIds: unknown[] = [];
    const privilegedCalls = stubPrivilegedFetch((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(200, { sessionToken: "admin_session" });
      }
      if (call.url.endsWith("/api/identity/current-actor-display")) {
        return new FakeResponse(200, { account: { account_id: "acc_platform" } });
      }
      if (call.url.endsWith("/api/identity/invitations")) {
        invitationAttempt += 1;
        invitationIds.push((call.data as { invitationId?: unknown }).invitationId);
        return invitationAttempt === 1
          ? new FakeResponse(201, { id: invitationIds[0], status: "pending" })
          : new FakeResponse(400, { error: { code: "validation_failed" } });
      }
      throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
    });
    const { calls, page } = createFakePage(() => {
      throw new Error("Registration must not be reached after an incomplete invitation receipt");
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).rejects.toThrow(
      "synthetic invitation failed (missing-identity-commit-receipt)",
    );
    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).rejects.toThrow(
      "synthetic invitation failed (invitation-already-authored)",
    );

    expect(invitationIds).toHaveLength(2);
    expect(new Set(invitationIds).size).toBe(1);
    expect(calls).toEqual([]);
    expect(privilegedCalls.filter((call) => call.url.endsWith("/api/platform/projections/refresh-checkpoint"))).toEqual(
      [],
    );
  });

  it("registration conflict cannot fall through to password sign-in", async () => {
    withPlatformAdminEnv();
    const invitationReceipt = encodeCommitReceipt([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "43",
        eventIds: ["evt_invitation"],
      },
    ]);
    stubPrivilegedFetch((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(200, { sessionToken: "admin_session" });
      }
      if (call.url.endsWith("/api/identity/current-actor-display")) {
        return new FakeResponse(200, { account: { account_id: "acc_platform" } });
      }
      if (call.url.endsWith("/api/identity/invitations")) {
        return new FakeResponse(
          201,
          { id: "ivt_smoke", status: "pending" },
          {
            "chase-sets-commit-receipt": invitationReceipt,
          },
        );
      }
      if (call.url.endsWith("/api/platform/projections/refresh-checkpoint")) {
        return new FakeResponse(200, { lastGlobalPosition: "43" });
      }
      throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
    });
    const { calls, cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/registration-consent")) {
        return new FakeResponse(200, {
          bundleKey: "registration",
          requirements: [],
          resolvedAt: "2026-07-25T00:00:00.000Z",
          signature: "server-minted-test-signature",
        });
      }
      if (call.url.endsWith("/api/auth/register")) {
        return new FakeResponse(409, { error: "User exists." });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).rejects.toThrow(
      "synthetic registration failed (registration-conflict)",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
    expect(cookies).toEqual([]);
  });

  it("accepts the largest valid registration projection and rejects cap plus one", async () => {
    const sessionToken = `session_${"a".repeat(36)}`;
    const success = JSON.stringify({ sessionToken });
    const largestValid = success + " ".repeat(registrationSuccessResponseBodyLimitBytes - Buffer.byteLength(success));
    const makePage = (rawBody: string) =>
      createFakePage((call) => {
        if (call.url.endsWith("/api/auth/registration-consent")) {
          return new FakeResponse(200, { bundleKey: "registration", requirements: [], signature: "server-minted" });
        }
        if (call.url.endsWith("/api/auth/register")) {
          return new FakeResponse(201, {}, {}, rawBody);
        }
        throw new Error(`Unexpected request: ${call.method} ${call.url}`);
      });

    const valid = makePage(largestValid);
    await expect(registerOrSignInSyntheticAccount(valid.page, "https://marketplace.test", account)).resolves.toBe(
      sessionToken,
    );
    expect(valid.cookies).toContainEqual(expect.objectContaining({ value: sessionToken }));

    const oversize = makePage(`${largestValid} `);
    const oversizeError = await registerOrSignInSyntheticAccount(
      oversize.page,
      "https://marketplace.test",
      account,
    ).catch((caught: unknown) => caught);
    expect(readErrorMessage(oversizeError)).toBe("synthetic registration failed (response-too-large)");
    expect(readErrorMessage(oversizeError)).not.toContain(sessionToken);
    expect(oversize.cookies).toEqual([]);
  });

  it.each(registrationFailureCases)(
    "classifies %s without body or credential disclosure",
    async (_name, registrationResponse, classification) => {
      const { calls, cookies, page } = createFakePage((call) => {
        if (call.url.endsWith("/api/auth/registration-consent")) {
          return new FakeResponse(200, { bundleKey: "registration", requirements: [], signature: "server-minted" });
        }
        if (call.url.endsWith("/api/auth/register")) {
          return registrationResponse;
        }
        throw new Error(`Unexpected request: ${call.method} ${call.url}`);
      });

      const error = await registerOrSignInSyntheticAccount(page, "https://marketplace.test", account).catch(
        (caught: unknown) => caught,
      );
      const message = readErrorMessage(error);

      expect(message).toBe(`synthetic registration failed (${classification})`);
      expect(message).not.toContain(account.email);
      expect(message).not.toContain(account.password);
      expect(message).not.toContain("secret-json-marker");
      expect(message).not.toContain("secret-token-marker");
      expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
        "/api/auth/registration-consent",
        "/api/auth/register",
      ]);
      expect(cookies).toEqual([]);
    },
  );

  it("uses Terraform deploy admin credentials to provision gated synthetic accounts", async () => {
    process.env.TF_VAR_platform_admin_email = "platform-admin@example.test";
    process.env.TF_VAR_platform_admin_password = "platform-admin-password";
    const invitationReceipt = encodeCommitReceipt([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "44",
        eventIds: ["evt_invitation"],
      },
    ]);
    const privilegedCalls = stubPrivilegedFetch((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        expect(call.data).toMatchObject({
          email: "platform-admin@example.test",
          password: "platform-admin-password",
        });
        return new FakeResponse(200, { sessionToken: "admin_session" });
      }
      if (call.url.endsWith("/api/identity/current-actor-display")) {
        return new FakeResponse(200, { account: { account_id: "acc_platform" } });
      }
      if (call.url.endsWith("/api/identity/invitations")) {
        return new FakeResponse(
          201,
          { id: "ivt_smoke", status: "pending" },
          {
            "chase-sets-commit-receipt": invitationReceipt,
          },
        );
      }
      if (call.url.endsWith("/api/platform/projections/refresh-checkpoint")) {
        return new FakeResponse(200, { lastGlobalPosition: "44" });
      }
      throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
    });
    const { calls, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/registration-consent")) {
        return new FakeResponse(200, {
          bundleKey: "registration",
          requirements: [],
          resolvedAt: "2026-07-25T00:00:00.000Z",
          signature: "server-minted-test-signature",
        });
      }
      if (call.url.endsWith("/api/auth/register")) {
        expect(call.data).toMatchObject({ password: account.password });
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
    expect(privilegedCalls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh-checkpoint",
    ]);
  });

  it("preserves direct registration for local open-admission environments without platform-admin credentials", async () => {
    const { calls, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/registration-consent")) {
        return new FakeResponse(200, {
          bundleKey: "registration",
          requirements: [],
          resolvedAt: "2026-07-25T00:00:00.000Z",
          signature: "server-minted-test-signature",
        });
      }
      if (call.url.endsWith("/api/auth/register")) {
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    // Registration still runs unprivileged here; it just resolves first.
    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
  });

  it("refuses registration admission failures without password sign-in", async () => {
    const { calls, cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/registration-consent")) {
        return new FakeResponse(200, {
          bundleKey: "registration",
          requirements: [],
          resolvedAt: "2026-07-25T00:00:00.000Z",
          signature: "server-minted-test-signature",
        });
      }
      if (call.url.endsWith("/api/auth/register")) {
        return new FakeResponse(403, { error: { code: "registration_admission_required" } });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).rejects.toThrow(
      "synthetic registration failed (registration-admission-required)",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
    expect(cookies).toEqual([]);
  });
});

function createProductionShapedProjectionSnapshot() {
  const projectionGroups = [];
  let body = "";
  for (let index = 0; Buffer.byteLength(body) <= 64 * 1024; index += 1) {
    projectionGroups.push({
      projectionName: `production-projection-${index}`,
      projectionRevision: 3,
      storedProjectionRevision: 3,
      revisionStale: false,
      targetContextName: `production-context-${index % 20}`,
      sourceContextNames: ["identity", "marketplace"],
      ownedTables: [`production_projection_${index}`],
      requiredDuringBootstrap: true,
      initialized: true,
      caughtUp: true,
      state: "caught-up",
      lastError: null,
      outstandingEventCount: "0",
      blockedStreamCount: 0,
      poisonEventCount: 0,
      updatedAt: "2026-07-22T23:20:00.000Z",
      subscriptions: [
        {
          checkpointKey: `production-projection-${index}:identity:v3`,
          subscriptionName: `production-projection-${index}`,
          projectionName: `production-projection-${index}`,
          sourceContextName: "identity",
          targetContextName: `production-context-${index % 20}`,
          subscriptionVersion: 3,
          initialized: true,
          lastGlobalPosition: "29965633335",
          sourceHeadGlobalPosition: "29965633335",
          outstandingEventCount: "0",
          processedEvents: 0,
          state: "caught-up",
          lastError: null,
          blockedStreamCount: 0,
          poisonEventCount: 0,
          updatedAt: "2026-07-22T23:20:00.000Z",
        },
      ],
    });
    body = JSON.stringify({
      summary: { status: "ok", totalGroups: projectionGroups.length },
      projectionGroups,
      projectionStatusSource: "live-refresh",
    });
  }
  return body;
}

async function withNativeServer(
  route: (path: string, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    route(new URL(request.url ?? "/", "http://native.test").pathname, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("native server failed (listen)");
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function writeJsonResponse(response: ServerResponse, status: number, body: unknown) {
  writeResponse(response, status, JSON.stringify(body), { "content-type": "application/json" });
}

function writeResponse(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>>,
) {
  response.writeHead(status, { "content-length": Buffer.byteLength(body), ...headers });
  response.end(body);
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function waitForSignal(signal: Promise<void>, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("native server signal timed out")), timeoutMs);
    void signal.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function marketplaceAuthCallerCensus() {
  const e2eRoot = join(process.cwd(), "e2e");
  const sourceRows = readSpecSources(e2eRoot);
  const classified = sourceRows.map((row) => ({ path: row.path, ...authCallsInSource(row.source) }));
  return {
    synthetic: classified
      .filter((row) => row.synthetic)
      .map((row) => row.path)
      .sort(),
    directOnly: classified
      .filter((row) => row.password && !row.synthetic)
      .map((row) => row.path)
      .sort(),
  };
}

function readSpecSources(root: string, directory = root): ReadonlyArray<Readonly<{ path: string; source: string }>> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return readSpecSources(root, absolutePath);
    }
    if (!entry.isFile() || !entry.name.endsWith(".spec.ts")) {
      return [];
    }
    return [
      {
        path: absolutePath.slice(root.length + 1).replaceAll("\\", "/"),
        source: readFileSync(absolutePath, "utf8"),
      },
    ];
  });
}

function authCallsInSource(source: string) {
  const localNames = new Map<string, string>();
  for (const match of source.matchAll(/import\s*{([^}]+)}\s*from\s*["'][^"']*(?:support\/auth|\.\/auth)["']/g)) {
    for (const binding of (match[1] ?? "").split(",")) {
      const [imported, local = imported] = binding
        .trim()
        .split(/\s+as\s+/)
        .map((value) => value.trim());
      if (imported && local) {
        localNames.set(imported, local);
      }
    }
  }
  const calls = (imported: string) => {
    const local = localNames.get(imported);
    return local ? new RegExp(`\\b${local}\\s*\\(`).test(source) : false;
  };
  return {
    synthetic: calls("registerOrSignInSyntheticAccount"),
    password: calls("signInWithPassword"),
  };
}
