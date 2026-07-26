import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { encodeCommitReceipt } from "@chase-sets/http/responses";
import { expect, test } from "@playwright/test";
import { registerOrSignInSyntheticAccount } from "./auth";

test.skip(process.env.AUTH_TRACE_ARTIFACT_PROBE !== "true", "runs only through the retained-artifact probe");

test("privileged setup succeeds on a retained first retry without entering the Playwright request context", async ({
  page,
}, testInfo) => {
  const markers = readProbeMarkers();
  const observedPaths: string[] = [];
  const server = createServer((request, response) => {
    void routeProbeRequest(request, response, markers, observedPaths).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "probe-route-failed" });
      } else {
        response.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("trace artifact probe failed (listen)");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    await expect(
      registerOrSignInSyntheticAccount(page, origin, {
        email: "trace-probe-synthetic@example.invalid",
        password: "trace-probe-synthetic-password",
        displayName: "Trace Probe Synthetic",
      }),
    ).resolves.toBe("synthetic-session");

    expect(observedPaths).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh-checkpoint",
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
    expect(testInfo.retry, "the first attempt intentionally creates the retained retry trace").toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

type ProbeMarkers = ReturnType<typeof readProbeMarkers>;

async function routeProbeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  markers: ProbeMarkers,
  observedPaths: string[],
) {
  const path = new URL(request.url ?? "/", "http://probe.invalid").pathname;
  observedPaths.push(path);
  const body = await readRequestJson(request);

  if (path === "/api/auth/password-sign-in") {
    assertProbe(
      isRecord(body) && body.email === markers.email && body.password === markers.password,
      "admin-credentials",
    );
    return writeJson(response, 200, {
      sessionToken: markers.session,
      authorization: markers.bearer,
      token: markers.token,
    });
  }

  if (path === "/api/identity/current-actor-display") {
    assertProbe(request.headers.cookie === `chase_sets_session=${markers.session}`, "actor-session");
    return writeJson(response, 200, { account: { account_id: "acc_trace_probe" } });
  }

  if (path === "/api/identity/invitations") {
    assertProbe(request.headers.cookie === `chase_sets_session=${markers.session}`, "invitation-session");
    assertProbe(
      isRecord(body) &&
        body.accountId === "acc_trace_probe" &&
        body.email === "trace-probe-synthetic@example.invalid" &&
        body.roleKey === "viewer",
      "invitation-body",
    );
    return writeJson(
      response,
      201,
      { status: "pending" },
      {
        "chase-sets-commit-receipt": encodeCommitReceipt([
          { sourceContextName: "identity", maxGlobalPosition: "5944", eventIds: ["evt_trace_probe"] },
        ]),
      },
    );
  }

  if (path === "/api/platform/projections/refresh-checkpoint") {
    assertProbe(request.headers.cookie === `chase_sets_session=${markers.session}`, "projection-session");
    assertProbe(
      isRecord(body) &&
        body.targetContextName === "auth" &&
        body.projectionName === "auth-identity-invitation-projection" &&
        body.sourceContextName === "identity",
      "projection-request",
    );
    return writeJson(response, 200, { lastGlobalPosition: "5944" });
  }

  if (path === "/api/auth/registration-consent") {
    return writeJson(response, 200, {
      bundleKey: "registration",
      requirements: [],
      resolvedAt: "2026-07-25T00:00:00.000Z",
      signature: "server-minted-test-signature",
    });
  }

  if (path === "/api/auth/register") {
    assertProbe(isRecord(body) && body.email === "trace-probe-synthetic@example.invalid", "registration-body");
    assertProbe(isRecord(body) && isRecord(body.registrationConsent), "registration-consent-body");
    return writeJson(response, 201, { sessionToken: "synthetic-session" });
  }

  return writeJson(response, 404, { error: "not-found" });
}

async function readRequestJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function readProbeMarkers() {
  return {
    email: requiredProbeEnv("TRACE_PROBE_ADMIN_EMAIL"),
    password: requiredProbeEnv("TRACE_PROBE_ADMIN_PASSWORD"),
    session: requiredProbeEnv("TRACE_PROBE_ADMIN_SESSION"),
    bearer: requiredProbeEnv("TRACE_PROBE_ADMIN_BEARER"),
    token: requiredProbeEnv("TRACE_PROBE_ADMIN_TOKEN"),
  };
}

function requiredProbeEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`trace artifact probe failed (missing-${name.toLowerCase()})`);
  }
  return value;
}

function assertProbe(condition: boolean, classification: string): asserts condition {
  if (!condition) {
    throw new Error(`trace artifact probe failed (${classification})`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
