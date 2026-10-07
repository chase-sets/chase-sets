import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { registerSyntheticAccount, syntheticAccountFor } from "./auth";

test.skip(process.env.AUTH_TRACE_ARTIFACT_PROBE !== "true", "runs only through the retained-artifact probe");

test("consent and native registration succeed on the operator probe's retained first retry", async ({
  page,
}, testInfo) => {
  const account = syntheticAccountFor(testInfo);
  const observedPaths: string[] = [];
  const sessionToken = `session_${"a".repeat(36)}`;
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://probe.invalid").pathname;
      observedPaths.push(path);
      if (path === "/api/auth/registration-consent") {
        return writeJson(response, 200, {
          bundleKey: "registration",
          requirements: [],
          resolvedAt: "2026-07-25T00:00:00.000Z",
          signature: "server-minted-test-signature",
        });
      }
      if (path === "/api/auth/register") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          email?: string;
          registrationConsent?: { affirmed?: boolean; resolution?: { signature?: string } };
        };
        expect(body.email).toBe(account.email);
        expect(body.registrationConsent).toEqual({
          affirmed: false,
          resolution: {
            bundleKey: "registration",
            requirements: [],
            resolvedAt: "2026-07-25T00:00:00.000Z",
            signature: "server-minted-test-signature",
          },
        });
        const at = "2026-07-25T00:00:00.000Z";
        return writeJson(response, 201, {
          type: "session-started",
          userId: "usr_trace_probe",
          accountId: "acc_trace_probe",
          sessionId: "ses_trace_probe",
          sessionToken,
          session: {
            session_id: "ses_trace_probe",
            user_id: "usr_trace_probe",
            user_display_name: null,
            user_primary_email: null,
            account_id: "acc_trace_probe",
            account_display_name: null,
            account_name: null,
            available_account_ids: ["acc_trace_probe"],
            authentication_method: "password",
            status: "active",
            expires_at: at,
            started_at: at,
            updated_at: at,
          },
          memberships: [
            {
              membershipId: "mem_trace_probe",
              accountId: "acc_trace_probe",
              roleKey: "owner",
              status: "active",
              rolePermissions: ["identity.accounts.view"],
            },
          ],
        });
      }
      writeJson(response, 404, { error: "not-found" });
    })().catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: "probe-route-failed" });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("trace artifact probe failed (listen)");
    await expect(registerSyntheticAccount(page, `http://127.0.0.1:${address.port}`, account)).resolves.toBe(
      sessionToken,
    );
    expect(observedPaths).toEqual(["/api/auth/registration-consent", "/api/auth/register"]);
    expect(testInfo.retry, "the first attempt intentionally creates the retained retry trace").toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
