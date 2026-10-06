import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import type { Page } from "@playwright/test";
import ts from "@chase-sets/typescript-compiler-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeSyntheticRegistrationResponse,
  registerSyntheticAccount,
  registrationResponseBodyLimitBytes,
  signInWithPassword,
  syntheticAccountFor,
} from "../e2e/support/auth";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const helper = "deployables/marketplace/e2e/support/auth.ts";
const unit = "deployables/marketplace/app/smoke-auth-support.test.ts";
const launcher = "scripts/playwright-trace-secret-exposure-probe.mjs";
const localEnv = { CHASE_SETS_E2E_INVOCATION_NAMESPACE: "synthetic-unit-invocation" };
const info = {
  file: "e2e/buy-funnel-redesign.spec.ts",
  project: { name: "chromium" },
  titlePath: ["buy-funnel-redesign.spec.ts", "funnel", "checkout confirmation"],
};
const identity = (change = {}) =>
  syntheticAccountFor({ ...info, ...change }, localEnv, "/repo/deployables/marketplace");
const at = "2026-10-04T12:00:00.000Z";
const token = `session_${"a".repeat(36)}`;
const consent = {
  bundleKey: "registration",
  requirements: [],
  resolvedAt: at,
  signature: "server-minted-unit-signature",
};
function started() {
  return {
    type: "session-started",
    userId: "usr_unit",
    accountId: "acc_unit",
    sessionId: "ses_unit",
    sessionToken: token,
    session: {
      session_id: "ses_unit",
      user_id: "usr_unit",
      user_display_name: null,
      user_primary_email: null,
      account_id: "acc_unit",
      account_display_name: null,
      account_name: null,
      available_account_ids: ["acc_unit"],
      authentication_method: "password",
      status: "active",
      expires_at: at,
      started_at: at,
      updated_at: at,
    },
    memberships: [
      {
        membershipId: "mem_unit",
        accountId: "acc_unit",
        roleKey: "owner",
        status: "active",
        rolePermissions: ["identity.accounts.view"],
      },
    ],
  };
}
function json(value: unknown, status = 201) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function fakePage() {
  const cookies: { name: string; value: string }[] = [];
  const calls: string[] = [];
  const page = {
    request: {
      get: vi.fn(async (url: string) => {
        calls.push(url);
        return { status: () => 200, json: async () => consent };
      }),
      post: vi.fn(async (url: string) => {
        calls.push(url);
        return { status: () => 200, json: async () => ({ sessionToken: token }) };
      }),
    },
    context: () => ({
      addCookies: vi.fn(async (values: typeof cookies) => {
        cookies.push(...values);
      }),
      cookies: async () => cookies,
    }),
  };
  return { page: page as unknown as Page, calls, cookies, transport: page.request };
}
async function nativeServer(
  route: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  exercise: (origin: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(route(request, response)).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unit server did not listen");
  try {
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
function writeJson(response: ServerResponse, value: unknown, status = 201) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("auth-identity", () => {
  it("uses every logical coordinate symmetrically and ignores execution coordinates", () => {
    const baseline = identity();
    const cases = [
      identity({ file: "e2e/critical-flows.spec.ts" }),
      identity({ project: { name: "mobile" } }),
      identity({ titlePath: [...info.titlePath, "another leaf"] }),
      identity({ titlePath: ["different", ...info.titlePath.slice(1)] }),
      syntheticAccountFor(info, { CHASE_SETS_E2E_INVOCATION_NAMESPACE: "day-after" }, "/repo/deployables/marketplace"),
      syntheticAccountFor(info, { GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" }, "/repo/deployables/marketplace"),
      syntheticAccountFor(info, { GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2" }, "/repo/deployables/marketplace"),
    ];
    for (const other of cases)
      for (const key of ["email", "password", "displayName"] as const) expect(other[key]).not.toBe(baseline[key]);
    for (const retry of [0, 1, 4])
      for (const workerIndex of [0, 1, 12])
        expect(identity({ retry, workerIndex, parallelIndex: 9 })).toEqual(baseline);
    expect(
      syntheticAccountFor(
        info,
        { ...localEnv, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2" },
        "/repo/deployables/marketplace",
      ),
    ).toEqual(cases[6]);
    expect(baseline.email.split("@")[0]).toBe(baseline.password.slice(4));
    expect(baseline.displayName.slice(4)).toBe(baseline.password.slice(4));
  });
  it("length-delimits titles rather than conflating partitions", () => {
    expect(identity({ titlePath: ["ab", "c"] })).not.toEqual(identity({ titlePath: ["a", "bc"] }));
  });
  it("canonicalizes separators, dots, absolute/relative paths and Windows root case independent of cwd", () => {
    const baseline = identity();
    for (const file of [
      info.file,
      "e2e/./buy-funnel-redesign.spec.ts",
      "e2e/sub/../buy-funnel-redesign.spec.ts",
      "/repo/deployables/marketplace/e2e/buy-funnel-redesign.spec.ts",
      "e2e\\buy-funnel-redesign.spec.ts",
    ])
      expect(identity({ file })).toEqual(baseline);
    const windows = syntheticAccountFor(info, localEnv, "D:\\Repo\\Marketplace");
    for (const file of [
      info.file,
      "d:/repo/marketplace/e2e/buy-funnel-redesign.spec.ts",
      "D:\\Repo\\Marketplace\\e2e\\buy-funnel-redesign.spec.ts",
    ])
      expect(syntheticAccountFor({ ...info, file }, localEnv, "d:/REPO/marketplace")).toEqual(windows);
    expect(readFileSync(`${root}/${helper}`, "utf8")).not.toContain("process.cwd()");
  });
  it("refuses missing/partial namespaces, escapes, cross-volume and incomplete identity before any network", () => {
    for (const env of [
      {},
      { GITHUB_RUN_ID: "1" },
      { GITHUB_RUN_ATTEMPT: "1" },
      { CHASE_SETS_E2E_INVOCATION_NAMESPACE: " " },
    ])
      expect(() => syntheticAccountFor(info, env, "/repo/deployables/marketplace")).toThrow(
        "missing-CHASE_SETS_E2E_INVOCATION_NAMESPACE",
      );
    for (const file of ["../escape.spec.ts", "/outside/e2e/spec.ts", "e2e/../../escape.spec.ts", "C:/else/spec.ts"])
      expect(() => identity({ file })).toThrow(/spec-/);
    for (const file of ["E:/else/e2e/spec.ts", "D:relative.spec.ts", "D:/Repo/Marketplace-other/e2e/spec.ts"])
      expect(() => syntheticAccountFor({ ...info, file }, localEnv, "D:/Repo/Marketplace")).toThrow(/spec-/);
    expect(() => identity({ titlePath: [] })).toThrow("incomplete-test-identity");
  });
  it("reproduces the old two-title display-name collision and rejects a single-credential mutant", () => {
    const old = (title: string) => ({
      email: `buy-funnel-run-nonce-0-0-${title}@chasesets.test`,
      password: "buy-funnel-run-0-0",
      displayName: "Buy Funnel run nonce 0 0",
    });
    expect(old("cart").email).not.toBe(old("confirmation").email);
    expect(old("cart").displayName).toBe(old("confirmation").displayName);
    const first = identity({ titlePath: ["funnel", "cart"] });
    const second = identity({ titlePath: ["funnel", "confirmation"] });
    const assertSymmetry = (left: typeof first, right: typeof first) => {
      for (const key of ["email", "password", "displayName"] as const) expect(left[key]).not.toBe(right[key]);
    };
    assertSymmetry(first, second);
    expect(() => assertSymmetry(first, { ...second, displayName: first.displayName })).toThrow();
  });
});

describe("auth-request-effects", () => {
  it("rejects invitation, checkpoint and premature-cookie mutations of the actual helper", async () => {
    const original = readFileSync(`${root}/${helper}`, "utf8");
    const needle = "const registrationConsent = await resolveRegistrationConsentSubmission(page, origin);";
    expect(original).toContain(needle);
    async function checkCandidate(source: string) {
      const { page, calls, cookies } = fakePage();
      const effects: string[] = [];
      const output = ts.transpileModule(
        source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(`${root}/${helper}`).href)),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
      ).outputText;
      const exports = {};
      runInNewContext(output, {
        exports,
        Buffer,
        TextDecoder,
        AbortController,
        URL,
        setTimeout,
        clearTimeout,
        console: { log: () => undefined },
        require: (name: string) => (name === "@playwright/test" ? { expect } : createRequire(import.meta.url)(name)),
        fetch: async (input: URL) => {
          effects.push(input.pathname);
          expect(input.pathname).toBe("/api/auth/register");
          expect(cookies).toEqual([]);
          return json(started());
        },
      });
      const candidate = exports as Pick<typeof import("../e2e/support/auth"), "registerSyntheticAccount">;
      await candidate.registerSyntheticAccount(page, "https://unit.invalid", identity());
      expect(calls).toEqual(["https://unit.invalid/api/auth/registration-consent"]);
      expect(effects).toEqual(["/api/auth/register"]);
      expect(cookies).toHaveLength(1);
    }
    await checkCandidate(original);
    for (const injected of [
      'await fetch(new URL("/api/identity/invitations", origin));',
      'await fetch(new URL("/api/platform/projections/refresh-checkpoint", origin));',
      `await addSessionCookie(page, origin, ${JSON.stringify(token)});`,
    ]) {
      await expect(checkCandidate(original.replace(needle, `${needle}\n${injected}`))).rejects.toThrow();
    }
  });
  it("performs server consent then exactly one native registration then cookie, with no privileged or sign-in effect", async () => {
    const { page, calls, cookies, transport } = fakePage();
    const effects: string[] = [];
    transport.get.mockImplementation(async (url) => {
      calls.push(url);
      effects.push("consent");
      return { status: () => 200, json: async () => consent };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("PLATFORM_ADMIN_EMAIL", "admin-secret-marker");
    vi.stubEnv("PLATFORM_ADMIN_PASSWORD", "password-secret-marker");
    await nativeServer(
      async (request, response) => {
        expect(request.url).toBe("/api/auth/register");
        expect(request.method).toBe("POST");
        expect(request.headers.cookie).toBeUndefined();
        effects.push("register");
        expect(cookies).toEqual([]);
        expect(await requestBody(request)).toEqual({
          displayName: identity().displayName,
          email: identity().email,
          password: identity().password,
          registrationConsent: { resolution: consent, affirmed: false },
        });
        writeJson(response, started());
      },
      async (origin) => {
        await expect(registerSyntheticAccount(page, origin, identity())).resolves.toBe(token);
        expect(cookies).toEqual([expect.objectContaining({ name: "chase_sets_session", value: token })]);
        expect(calls).toEqual([`${origin}/api/auth/registration-consent`]);
        expect(transport.post).not.toHaveBeenCalled();
      },
    );
    expect(effects).toEqual(["consent", "register"]);
    const assertEffects = (observed: string[]) => expect(observed).toEqual(["consent", "register"]);
    for (const mutant of [
      ["invitation", ...effects],
      ["checkpoint", ...effects],
      ["cookie", ...effects],
    ])
      expect(() => assertEffects(mutant)).toThrow();
  });
  it.each([403, 409])(
    "hard-refuses every %s without cookie, sign-in, cleanup or another registration",
    async (status) => {
      for (const body of [
        { error: { code: "registration_admission_required" } },
        { error: { code: "display_name_already_taken" } },
        { error: "raw-secret-marker" },
        { error: { code: "arbitrary-secret-marker" } },
      ]) {
        const { page, cookies, transport } = fakePage();
        let registrations = 0;
        await nativeServer(
          (_, response) => {
            registrations++;
            writeJson(response, body, status);
          },
          async (origin) => {
            await expect(registerSyntheticAccount(page, origin, identity())).rejects.toThrow(`status=${status}, code=`);
            expect(cookies).toEqual([]);
            expect(transport.post).not.toHaveBeenCalled();
            expect(registrations).toBe(1);
          },
        );
      }
    },
  );
  it("never prints raw response/header/exception markers or the credential-derivation digest", async () => {
    const { page, cookies } = fakePage();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("transport-secret-marker");
      }),
    );
    await expect(registerSyntheticAccount(page, "https://unit.invalid", identity())).rejects.toThrow(
      "synthetic registration failed (network)",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: "body-secret-marker", message: "token-secret-marker" } }, 409)),
    );
    await expect(registerSyntheticAccount(page, "https://unit.invalid", identity())).rejects.toThrow(
      "status=409, code=unclassified-refusal",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(started())),
    );
    await registerSyntheticAccount(page, "https://unit.invalid", identity());
    expect(log).toHaveBeenCalledTimes(1);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toMatch(/^synthetic registration status=201 bytes=\d+ cap=\d+ headroom-percent=\d+$/);
    for (const marker of [
      token,
      identity().email,
      identity().password,
      identity().displayName.slice(4),
      "transport-secret-marker",
      "body-secret-marker",
      "token-secret-marker",
    ])
      expect(output).not.toContain(marker);
    expect(cookies).toHaveLength(1);
  });
});

describe("auth-bounded-response", () => {
  const consume = (response: Response, signal = new AbortController().signal) =>
    consumeSyntheticRegistrationResponse(response, signal);
  it("accepts complete Auth shape, including optional started_at, and schema-sized largest strings/permissions with live headroom", async () => {
    await expect(consume(json(started()))).resolves.toEqual({
      sessionToken: token,
      bytes: Buffer.byteLength(JSON.stringify(started())),
    });
    const value = started();
    const largest = `x${"\u0000".repeat(319)}`;
    value.userId = value.session.user_id = largest;
    value.sessionId = value.session.session_id = largest;
    value.accountId =
      value.session.account_id =
      value.session.available_account_ids[0] =
      value.memberships[0]!.accountId =
        largest;
    value.memberships[0]!.membershipId = largest;
    value.memberships[0]!.rolePermissions = Array.from({ length: 128 }, (_, index) => `${index}`.padEnd(128, "\u0000"));
    const session = value.session as Record<string, unknown>;
    for (const key of ["user_display_name", "user_primary_email", "account_display_name", "account_name"])
      session[key] = largest;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    expect(registrationResponseBodyLimitBytes).toBeGreaterThanOrEqual(Math.ceil(bytes * 1.25));
    await expect(consume(json(value))).resolves.toEqual({ sessionToken: token, bytes });
    delete session.started_at;
    await expect(consume(json(value))).resolves.toHaveProperty("sessionToken", token);
  });
  it.each([
    [
      "discriminant",
      (value: Record<string, unknown>) => {
        value.type = "account-selection-required";
      },
    ],
    [
      "missing accountId",
      (value: Record<string, unknown>) => {
        delete value.accountId;
      },
    ],
    [
      "invalid-extra",
      (value: Record<string, unknown>) => {
        value.authorization = "secret-marker";
      },
    ],
    [
      "token",
      (value: Record<string, unknown>) => {
        value.sessionToken = "session_secret-marker";
      },
    ],
    [
      "empty token",
      (value: Record<string, unknown>) => {
        value.sessionToken = "";
      },
    ],
    [
      "missing session",
      (value: Record<string, unknown>) => {
        delete value.session;
      },
    ],
    [
      "null session",
      (value: Record<string, unknown>) => {
        value.session = null;
      },
    ],
    [
      "session mismatch",
      (value: Record<string, unknown>) => {
        (value.session as Record<string, unknown>).user_id = "usr_other";
      },
    ],
    [
      "session extra",
      (value: Record<string, unknown>) => {
        (value.session as Record<string, unknown>).extra = true;
      },
    ],
    [
      "session status",
      (value: Record<string, unknown>) => {
        (value.session as Record<string, unknown>).status = "revoked";
      },
    ],
    [
      "session method",
      (value: Record<string, unknown>) => {
        (value.session as Record<string, unknown>).authentication_method = "magic-link";
      },
    ],
    [
      "session timestamp",
      (value: Record<string, unknown>) => {
        (value.session as Record<string, unknown>).expires_at = "not-a-date";
      },
    ],
    [
      "member empty",
      (value: Record<string, unknown>) => {
        value.memberships = [];
      },
    ],
    [
      "member shape",
      (value: Record<string, unknown>) => {
        value.memberships = [{ roleKey: "owner" }];
      },
    ],
    [
      "member role",
      (value: Record<string, unknown>) => {
        (value.memberships as Record<string, unknown>[])[0]!.roleKey = "viewer";
      },
    ],
    [
      "member permissions",
      (value: Record<string, unknown>) => {
        (value.memberships as Record<string, unknown>[])[0]!.rolePermissions = [42];
      },
    ],
    [
      "member permissions overflow",
      (value: Record<string, unknown>) => {
        (value.memberships as Record<string, unknown>[])[0]!.rolePermissions = Array.from({ length: 129 }, (_, i) =>
          String(i),
        );
      },
    ],
  ])("rejects %s before cookie", async (_, mutate) => {
    const value = started();
    mutate(value);
    await expect(consume(json(value))).rejects.toThrow("invalid-response");
    const { page, cookies } = fakePage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(value)),
    );
    await expect(registerSyntheticAccount(page, "https://unit.invalid", identity())).rejects.toThrow(
      "invalid-response",
    );
    expect(cookies).toEqual([]);
  });
  it("caps the chunk that crosses the limit and cancels without pre-materializing endless streams", async () => {
    for (const sizes of [[registrationResponseBodyLimitBytes + 1], [registrationResponseBodyLimitBytes, 1]]) {
      let reads = 0;
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const size = sizes[reads++] ?? registrationResponseBodyLimitBytes;
          controller.enqueue(new Uint8Array(size));
        },
        cancel,
      });
      await expect(
        consume(new Response(stream, { status: 201, headers: { "content-type": "application/json" } })),
      ).rejects.toThrow("response-too-large");
      expect(cancel).toHaveBeenCalledOnce();
      expect(reads).toBeLessThanOrEqual(sizes.length + 1);
    }
  });
  it("rejects a valid padded body without 25 percent live headroom and sanitizes prefix-shaped reader exceptions", async () => {
    const text = JSON.stringify(started());
    const padded =
      text + " ".repeat(Math.floor(registrationResponseBodyLimitBytes / 1.25) - Buffer.byteLength(text) + 1);
    await expect(
      consume(new Response(padded, { status: 201, headers: { "content-type": "application/json" } })),
    ).rejects.toThrow("insufficient-live-headroom");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("synthetic registration failed (exception-secret-marker)"));
      },
    });
    await expect(consume(new Response(stream, { headers: { "content-type": "application/json" } }))).rejects.toThrow(
      "synthetic registration failed (response-read)",
    );
  });
  it("keeps the deadline through partial body, including a reader that never finishes", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(Buffer.from('{"type":'));
        },
        cancel,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
    const result = consume(response, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("timeout");
    expect(cancel).toHaveBeenCalledOnce();
    await expect(consume(json(started()), controller.signal)).rejects.toThrow("timeout");
  });
  it("bounds native partial/endless, malformed, fatal UTF-8, wrong type and body read failures", async () => {
    await nativeServer(
      (request, response) => {
        response.writeHead(201, { "content-type": request.url === "/type" ? "text/plain" : "application/json" });
        if (request.url === "/partial") {
          response.write('{"type":');
          return;
        }
        if (request.url === "/malformed") return void response.end('{"body-secret-marker":');
        if (request.url === "/utf8") return void response.end(Buffer.from([0xc3, 0x28]));
        response.end("body-secret-marker");
      },
      async (origin) => {
        for (const [path, classification] of [
          ["/partial", "timeout"],
          ["/malformed", "invalid-json"],
          ["/utf8", "invalid-json"],
          ["/type", "unexpected-content-type"],
        ]) {
          const controller = new AbortController();
          const response = await fetch(`${origin}${path}`, { signal: controller.signal });
          const result = consume(response, controller.signal);
          if (path === "/partial") controller.abort();
          await expect(result).rejects.toThrow(classification);
        }
      },
    );
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("exception-secret-marker"));
      },
    });
    await expect(consume(new Response(broken, { headers: { "content-type": "application/json" } }))).rejects.toThrow(
      "response-read",
    );
    await expect(consume(new Response(null, { headers: { "content-type": "application/json" } }))).rejects.toThrow(
      "empty-response",
    );
  });
});

describe("auth-retained-state", () => {
  it("retains identical tuples as hard conflicts, creates a day-after identity without reset and signs in configured/seeded accounts directly", async () => {
    const emails = new Set<string>();
    const names = new Set<string>();
    const paths: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await nativeServer(
      async (request, response) => {
        paths.push(request.url ?? "");
        const body = await requestBody(request);
        if (emails.has(String(body.email))) return writeJson(response, { error: "already exists" }, 409);
        if (names.has(String(body.displayName)))
          return writeJson(response, { error: { code: "display_name_already_taken" } }, 409);
        emails.add(String(body.email));
        names.add(String(body.displayName));
        writeJson(response, started());
      },
      async (origin) => {
        const first = fakePage();
        await registerSyntheticAccount(first.page, origin, identity());
        const retained = fakePage();
        await expect(registerSyntheticAccount(retained.page, origin, identity())).rejects.toThrow(
          "unclassified-refusal",
        );
        expect(retained.cookies).toEqual([]);
        expect(retained.transport.post).not.toHaveBeenCalled();
        await registerSyntheticAccount(
          fakePage().page,
          origin,
          syntheticAccountFor(
            info,
            { CHASE_SETS_E2E_INVOCATION_NAMESPACE: "day-after" },
            "/repo/deployables/marketplace",
          ),
        );
        const collision = fakePage();
        await expect(
          registerSyntheticAccount(collision.page, origin, {
            ...identity({ titlePath: ["another"] }),
            displayName: identity().displayName,
          }),
        ).rejects.toThrow("display_name_already_taken");
        expect(collision.cookies).toEqual([]);
        expect(collision.transport.post).not.toHaveBeenCalled();
        expect(emails.size).toBe(2);
      },
    );
    expect(paths).toEqual(Array(4).fill("/api/auth/register"));
    for (const email of ["configured@example.test", "seeded@example.test"]) {
      const direct = fakePage();
      await signInWithPassword(direct.page, "https://unit.invalid", { email, password: "configured-password" });
      expect(direct.calls).toEqual(["https://unit.invalid/api/auth/password-sign-in"]);
      expect(direct.cookies).toHaveLength(1);
    }
    const realControl = readFileSync(
      `${root}/bounded-contexts/identity/tests/registration-operation-recovery.db.test.ts`,
      "utf8",
    );
    expect(realControl).toContain('"display_name_already_taken"');
  });
});

const censusRoots = ["deployables/marketplace/e2e", "deployables/marketplace/app", "deployables/marketplace/src"];
const expectedConsumers: Record<string, readonly [number, number, number, number, string]> = {
  "account-payment.spec.ts": [1, 1, 0, 1, "synthetic/configured"],
  "buy-funnel-redesign.spec.ts": [1, 2, 0, 1, "synthetic/configured/seeded"],
  "critical-flows.spec.ts": [1, 4, 0, 1, "synthetic/configured/later-session/seeded"],
  "support/auth-trace-artifact.probe.spec.ts": [1, 0, 0, 1, "synthetic operator probe; outside functional counts"],
  "sell-list-evidence.spec.ts": [0, 1, 0, 0, "configured evidence seller"],
  "seller-desk-journey.uat.spec.ts": [0, 1, 0, 0, "configured UAT seller"],
  "account-elevation-intent.spec.ts": [0, 1, 0, 0, "configured/seeded"],
  "account-payment-stripe-embed.uat.spec.ts": [0, 3, 0, 0, "configured"],
  "listing-evidence-readiness.spec.ts": [0, 1, 0, 0, "configured/seeded"],
  "notifications.spec.ts": [0, 1, 0, 0, "seeded"],
  "payout-connect-appearance.uat.spec.ts": [0, 1, 0, 0, "configured"],
  "support-case-detail.spec.ts": [0, 2, 0, 0, "seeded"],
  "buyer-purchase-journey.spec.ts": [0, 0, 2, 0, "seeded-form"],
  "channel-publication-freshness.spec.ts": [0, 0, 1, 0, "seeded-form"],
  "manual-sync-recovery.spec.ts": [0, 0, 1, 0, "seeded-form"],
  "repricing-policies.spec.ts": [0, 0, 1, 0, "seeded-form"],
  "seller-time-away-capacity.spec.ts": [0, 0, 1, 0, "seeded-form"],
};
const trackedMarketplaceSources = execFileSync("git", ["ls-files", "-z", "--", ...censusRoots], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((file) => /\.[cm]?[jt]sx?$/.test(file));
const sources = new Map(trackedMarketplaceSources.map((file) => [file, readFileSync(`${root}/${file}`, "utf8")]));
const authExports = [
  "registerSyntheticAccount",
  "signInWithPassword",
  "signInThroughMarketplaceForm",
  "syntheticAccountFor",
];

function discoverAuthCallers(files: ReadonlyMap<string, string>, roots = censusRoots) {
  if (JSON.stringify(roots) !== JSON.stringify(censusRoots)) throw new Error("auth census: dropped discovery root");
  for (const file of trackedMarketplaceSources)
    if (!files.has(file)) throw new Error(`auth census: omitted tracked source ${file}`);
  const virtualName = (file: string) => `/${file}`;
  const host = ts.createCompilerHost({});
  host.getCurrentDirectory = () => "/";
  host.fileExists = (file) => files.has(file.replace(/^\//, ""));
  host.readFile = (file) => files.get(file.replace(/^\//, ""));
  host.getSourceFile = (file, version) => {
    const text = host.readFile(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, version, true);
  };
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      if (!name.startsWith(".")) return undefined;
      const base = posix.resolve(posix.dirname(containingFile), name);
      const candidate = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].find(host.fileExists);
      return candidate ? { resolvedFileName: candidate } : undefined;
    });
  const program = ts.createProgram(
    [...files.keys()].map(virtualName),
    { noLib: true, allowJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    host,
  );
  if (program.getSyntacticDiagnostics().length) throw new Error("auth census: unparsed source");
  const checker = program.getTypeChecker();
  function helperExport(expression: ts.Node, seen = new Set<ts.Symbol>()): string | undefined {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression))
      return helperExport(expression.expression, seen);
    const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    let symbol = checker.getSymbolAtLocation(location);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (symbol.declarations?.some((declaration) => declaration.getSourceFile().fileName === virtualName(helper)))
      return symbol.name;
    const declaration = symbol.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
      return helperExport(declaration.initializer, seen);
    return undefined;
  }
  function isAuthNamespace(expression: ts.Node) {
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (
      symbol?.declarations?.some(
        (declaration) => ts.isSourceFile(declaration) && declaration.fileName === virtualName(helper),
      ) ?? false
    );
  }
  function pathText(expression: ts.Expression, source: ts.SourceFile, seen = new Set<string>()): string | undefined {
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isTemplateExpression(expression))
      return expression.head.text + expression.templateSpans.map((span) => span.literal.text).join("");
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return (pathText(expression.left, source, seen) ?? "") + (pathText(expression.right, source, seen) ?? "");
    if (ts.isNewExpression(expression) && expression.expression.getText(source) === "URL" && expression.arguments?.[0])
      return pathText(expression.arguments[0], source, seen);
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      seen.add(expression.text);
      const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
        return pathText(declaration.initializer, source, seen);
    }
    return undefined;
  }
  const consumers = new Map<string, number[]>();
  const direct: string[] = [];
  for (const file of files.keys()) {
    const parsed = program.getSourceFile(virtualName(file));
    if (!parsed) throw new Error(`auth census: unparsed ${file}`);
    const source: ts.SourceFile = parsed;
    const counts = [0, 0, 0, 0];
    function visit(node: ts.Node) {
      if (ts.isElementAccessExpression(node) && isAuthNamespace(node.expression))
        throw new Error(`auth census: computed namespace ${file}`);
      if (
        ts.isIdentifier(node) &&
        isAuthNamespace(node) &&
        !ts.isNamespaceImport(node.parent) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
      )
        throw new Error(`auth census: escaped namespace ${file}`);
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".") &&
        /(?:^|\/)auth$/.test(node.moduleSpecifier.text)
      ) {
        const binding = node.importClause?.namedBindings;
        if (binding && ts.isNamedImports(binding))
          for (const item of binding.elements) {
            if (!helperExport(item.name)) throw new Error(`auth census: unresolved auth import ${file}`);
          }
      }
      if (ts.isCallExpression(node)) {
        const exported = helperExport(node.expression);
        const slot = exported ? authExports.indexOf(exported) : -1;
        if (slot >= 0) counts[slot]!++;
        const transport = node.expression.getText(source);
        if (node.arguments[0] && (transport === "fetch" || /\.(?:get|post|put|patch|delete|fetch)$/.test(transport))) {
          const endpoint = pathText(node.arguments[0], source);
          if (endpoint?.includes("/api/auth/")) {
            if (file !== helper && file !== unit) throw new Error(`auth census: unclassified direct auth ${file}`);
            if (file === helper) direct.push(endpoint.slice(endpoint.indexOf("/api/auth/")));
          }
        }
      }
      // A helper may be called, aliased, or re-exported. Passing it as an opaque
      // callback/computed namespace is an unclassified execution path, not zero.
      if (
        ts.isPropertyAccessExpression(node) ||
        (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
      ) {
        const exported = helperExport(node);
        if (exported && authExports.includes(exported) && file !== helper && file !== unit) {
          let parent: ts.Node = node.parent;
          if (ts.isPropertyAccessExpression(parent) && parent.name === node) parent = parent.parent;
          const allowed =
            ts.isImportSpecifier(parent) ||
            ts.isExportSpecifier(parent) ||
            (ts.isCallExpression(parent) && parent.expression === node) ||
            (ts.isVariableDeclaration(parent) && (parent.initializer === node || parent.name === node)) ||
            (ts.isPropertyAccessExpression(node) &&
              ts.isCallExpression(node.parent) &&
              node.parent.expression === node);
          if (!allowed) throw new Error(`auth census: escaped helper ${file}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (file !== helper && file !== unit && counts.some(Boolean))
      consumers.set(file.replace("deployables/marketplace/e2e/", ""), counts);
  }
  if (
    JSON.stringify(direct.sort()) !==
    JSON.stringify(["/api/auth/password-sign-in", "/api/auth/register", "/api/auth/registration-consent"].sort())
  )
    throw new Error("auth census: incomplete direct auth/consent graph");
  if (consumers.size !== Object.keys(expectedConsumers).length)
    throw new Error("auth census: unclassified/omitted consumer");
  for (const [file, expected] of Object.entries(expectedConsumers))
    if (JSON.stringify(consumers.get(file)) !== JSON.stringify(expected.slice(0, 4)))
      throw new Error(`auth census: intent/effect mismatch ${file}`);
  return {
    scanned: files.size,
    totalRuntime: consumers.size,
    synthetic: 4,
    direct: 8,
    form: 5,
    helper: 1,
    unit: 1,
    launcher: 1,
    consumers,
  };
}

describe("auth-caller-census", () => {
  it("discovers the complete tracked graph, with runtime/helper/test/launcher and configured/seeded labels separate", () => {
    const census = discoverAuthCallers(sources);
    expect(census).toMatchObject({
      totalRuntime: 17,
      synthetic: 4,
      direct: 8,
      form: 5,
      helper: 1,
      unit: 1,
      launcher: 1,
    });
    expect(census.scanned).toBe(trackedMarketplaceSources.length);
    expect(readFileSync(`${root}/${launcher}`, "utf8")).toContain("AUTH_TRACE_ARTIFACT_PROBE");
    console.log(
      `auth caller census scanned=${census.scanned} runtime=17 synthetic=4 direct=8 seeded-form=5 helper=1 unit=1 launcher=1`,
    );
  });
  it("resolves named aliases, namespace imports, local aliases and re-exports without filename assumptions", () => {
    const path = "deployables/marketplace/e2e/sell-list-evidence.spec.ts";
    const original = sources.get(path)!;
    for (const [importText, call] of [
      ['import { signInWithPassword as login } from "./support/auth";', "login"],
      ['import * as auth from "./support/auth";', "auth.signInWithPassword"],
      ['import { signInWithPassword as originalLogin } from "./support/auth"; const login = originalLogin;', "login"],
      ['import { login } from "./support/auth-alias";', "login"],
    ]) {
      const variant = new Map(sources);
      variant.set(
        path,
        original
          .replace('import { signInWithPassword } from "./support/auth";', importText)
          .replace("await signInWithPassword(", `await ${call}(`),
      );
      variant.set(
        "deployables/marketplace/e2e/support/auth-alias.ts",
        'export { signInWithPassword as login } from "./auth";',
      );
      expect(discoverAuthCallers(variant).totalRuntime).toBe(17);
    }
  });
  it("refuses sibling, re-export, bare constant, unclassified, arbitrary-path, escaped helper and dropped-root mutants through discovery", () => {
    for (const text of [
      'import { registerSyntheticAccount } from "../e2e/support/auth"; registerSyntheticAccount(page, origin, account);',
      'import { login } from "./support/alias"; login(page, origin, account);',
      'const registerPath = "/api/auth/register"; fetch(registerPath);',
      'page.request.post("/api/auth/unclassified");',
      'import { registerSyntheticAccount } from "../e2e/support/auth"; const escaped = [registerSyntheticAccount];',
      'import * as auth from "../e2e/support/auth"; auth["registerSyntheticAccount"](page, origin, account);',
    ]) {
      const variant = new Map(sources);
      variant.set("deployables/marketplace/src/arbitrary-bootstrap.ts", text);
      variant.set(
        "deployables/marketplace/src/support/alias.ts",
        'export { signInWithPassword as login } from "../../e2e/support/auth";',
      );
      expect(() => discoverAuthCallers(variant)).toThrow(/auth census:/);
    }
    expect(() => discoverAuthCallers(sources, censusRoots.slice(1))).toThrow("dropped discovery root");
    const noConsent = new Map(sources);
    noConsent.set(
      helper,
      sources.get(helper)!.replace("`${origin}/api/auth/registration-consent`", "`${origin}/api/omitted`"),
    );
    expect(() => discoverAuthCallers(noConsent)).toThrow("incomplete direct auth/consent graph");
  });
  it.each(Object.keys(expectedConsumers))("refuses omission of %s, including every seeded-form consumer", (file) => {
    const variant = new Map(sources);
    const path = `deployables/marketplace/e2e/${file}`;
    variant.set(path, "export {};");
    expect(() => discoverAuthCallers(variant)).toThrow(/auth census:/);
    variant.delete(path);
    expect(() => discoverAuthCallers(variant)).toThrow("omitted tracked source");
  });
});

class GateSkip extends Error {}
async function executeConfiguredSpec(file: string, env: Record<string, string>) {
  const callbacks: (() => Promise<void>)[] = [];
  let groupSkipped = false;
  let running = false;
  const calls: { email: string; password: string }[] = [];
  const locator = {
    first: () => locator,
    getByRole: () => locator,
    click: async () => undefined,
    isVisible: async () => false,
  };
  const page = {
    goto: async () => undefined,
    url: () => "https://unit.invalid/sign-in",
    setViewportSize: async () => undefined,
    getByRole: () => locator,
    getByText: () => locator,
  };
  const assertions = {
    toBeVisible: async () => undefined,
    toBeDisabled: async () => undefined,
    toHaveURL: async () => undefined,
  };
  const test = Object.assign(
    (_: string, callback: (fixture: { page: typeof page }) => Promise<void>) => {
      if (!groupSkipped) callbacks.push(() => callback({ page }));
    },
    {
      describe: (_: string, callback: () => void) => {
        const previous = groupSkipped;
        callback();
        groupSkipped = previous;
      },
      skip: (condition: boolean) => {
        if (condition) {
          if (running) throw new GateSkip();
          groupSkipped = true;
        }
      },
    },
  );
  const source = sources.get(`deployables/marketplace/e2e/${file}`)!;
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(output, {
    exports: {},
    process: { env },
    URL,
    require: (name: string) => {
      if (name === "@playwright/test") return { test, expect: () => assertions };
      if (name === "./support/auth")
        return {
          signInWithPassword: async (_: unknown, __: unknown, account: { email: string; password: string }) => {
            calls.push(account);
          },
          registerSyntheticAccount: () => {
            throw new Error("replacement registration forbidden");
          },
        };
      throw new Error(`unexpected configured-spec import ${name}`);
    },
  });
  if (callbacks[0]) {
    running = true;
    try {
      await callbacks[0]();
    } catch (error) {
      if (!(error instanceof GateSkip)) throw error;
    }
  }
  return calls;
}

describe("auth-configured-gates", () => {
  it("executes Seller Desk's actual pre-auth gate over every UAT/email/password/displayName combination", async () => {
    for (const uat of ["", "false", "true"])
      for (const email of ["", " seller@example.test "])
        for (const password of ["", " seller-password "])
          for (const displayName of ["", "Replacement name"]) {
            const calls = await executeConfiguredSpec("seller-desk-journey.uat.spec.ts", {
              SELLER_DESK_UAT: uat,
              MARKETPLACE_E2E_EMAIL: email,
              MARKETPLACE_E2E_PASSWORD: password,
              MARKETPLACE_E2E_DISPLAY_NAME: displayName,
            });
            expect(calls).toEqual(
              uat === "true" && email && password ? [{ email: email.trim(), password: password.trim() }] : [],
            );
          }
  });
  it("executes Sell List's actual pre-auth gate over all listing/email/password combinations", async () => {
    for (const listing of ["", " listing-unit "])
      for (const email of ["", " seller@example.test "])
        for (const password of ["", " seller-password "]) {
          const calls = await executeConfiguredSpec("sell-list-evidence.spec.ts", {
            MARKETPLACE_E2E_EVIDENCE_LISTING_ID: listing,
            MARKETPLACE_E2E_EMAIL: email,
            MARKETPLACE_E2E_PASSWORD: password,
          });
          expect(calls).toEqual(
            listing && email && password ? [{ email: email.trim(), password: password.trim() }] : [],
          );
        }
  });
});
