import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import {
  testCatalogAdminOriginGenerateContract,
  validateCatalogAdminOriginGenerateReceipt,
} from "./catalog-admin-origin-generate-receipt.mjs";

const spec = readFileSync("deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts", "utf8");
const parent = "job_01M5N5MCJ3JET0GSZ32EJ63BA1";
const origin = "https://admin.staging.chasesets.com";
const startedAt = "2026-10-29T18:00:00.000Z";
const now = "2026-10-29T18:00:45.000Z";
const declarations = new Set([
  "catalogAdminOriginGenerateJourneyScope",
  "catalogAdminOriginGeneratePath",
  "catalogAdminOriginGeneratePagePath",
  "catalogAdminOriginGenerateArtifactPath",
  "catalogAdminOriginGenerateReservedParents",
  "isCatalogAdminOriginGenerateScratchParent",
  "catalogAdminOriginGenerateRequestBody",
  "catalogAdminOriginGenerateGuard",
  "catalogAdminOriginGenerateRequestAllowed",
  "buildCatalogAdminOriginGenerateReceipt",
  "buildAdminOriginGenerateFailureReceipt",
  "adminOriginGenerateError",
  "runAdminOriginGenerateProbe",
]);

function producer(source = spec, overrides = {}) {
  const file = ts.createSourceFile("producer.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = file.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement)) return declarations.has(statement.name?.text);
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => declarations.has(declaration.name.getText(file)))
    );
  });
  expect(selected).toHaveLength(declarations.size);
  const { outputText, diagnostics } = ts.transpileModule(
    `${selected.map((statement) => statement.getText(file)).join("\n")}\n` +
      "({ guard: catalogAdminOriginGenerateGuard, build: buildCatalogAdminOriginGenerateReceipt, failure: buildAdminOriginGenerateFailureReceipt, run: runAdminOriginGenerateProbe })",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true },
  );
  expect(diagnostics).toEqual([]);
  return runInNewContext(outputText, { Buffer, createHash, URL, Error, expect, console, ...overrides });
}

const failureInput = {
  runId: "synthetic-producer-run",
  expectedSha: "a".repeat(40),
  adminWebUrl: origin,
  scratchParent: parent,
  startedAt,
  now,
  requestCount: 0,
  error: "request-failed:TimeoutError",
};
const validate = (receipt) =>
  validateCatalogAdminOriginGenerateReceipt(receipt, {
    expectedSha: failureInput.expectedSha,
    adminWebUrl: origin,
    runId: failureInput.runId,
    scratchParent: parent,
    forbiddenValues: [],
  });

async function executeProbe({
  source = spec,
  runAttempt = "1",
  sent = false,
  existing = false,
  evaluate = false,
} = {}) {
  let receipt;
  let fence;
  let navigationCount = 0;
  let admittedRequests = 0;
  let dateCalls = 0;
  const context = {
    route: async (_pattern, handler) => {
      fence = handler;
    },
    routeWebSocket: async () => {},
    unroute: async () => {},
    cookies: async () => [],
  };
  const page = {
    context: () => context,
    url: () => `${origin}/catalog/integrations`,
    evaluate: async () => {
      if (sent) {
        await fence({
          request: () => ({
            url: () => `${origin}/api/catalog/source-observations/merge-candidates/generate`,
            method: () => "POST",
            postData: () => JSON.stringify({ syncRunId: parent }),
          }),
          continue: async () => {
            admittedRequests += 1;
          },
          abort: async () => {
            throw new Error("synthetic unexpected abort");
          },
        });
      }
      throw new Error("synthetic evaluate rejection");
    },
  };
  const runtime = producer(source, {
    Date: class extends Date {
      constructor() {
        super(dateCalls++ === 0 ? startedAt : now);
      }
    },
    process: {
      env: {
        ADMIN_WEB_URL: origin,
        EXPECTED_SHA: failureInput.expectedSha,
        GITHUB_RUN_ID: failureInput.runId,
        GITHUB_RUN_ATTEMPT: runAttempt,
        CATALOG_STAGING_PROVIDER_UAT: "true",
      },
    },
    adminOriginGenerateScratchParent: parent,
    catalogAdminEmail: "synthetic-admin@example.invalid",
    catalogAdminPassword: "synthetic-password",
    existsSync: () => existing || Boolean(receipt),
    writeAdminOriginGenerateReceipt: (value) => {
      receipt = value;
    },
    signInThroughVisibleForm: async () => {
      navigationCount += 1;
      if (!evaluate) throw new Error("synthetic sign-in failure");
    },
  });
  let error;
  try {
    await runtime.run(page, { retry: 0 });
  } catch (caught) {
    error = caught;
  }
  return { receipt, error, navigationCount, admittedRequests };
}

describe("Catalog Admin-origin generate receipt", () => {
  it("enrolls the receipt and immutable workflow contract in hosted script tests", async () => {
    await testCatalogAdminOriginGenerateContract();
  });

  it("executes the actual typed fallback with a 45-second host bracket and truthful sent state", () => {
    const runtime = producer();
    for (const requestCount of [0, 1]) {
      const receipt = runtime.failure({ ...failureInput, requestCount });
      expect(validate(receipt)).toEqual([]);
      expect(receipt.requestStartedAt).toBe(now);
      expect(receipt.responseCompletedAt).toBe(now);
      expect(receipt.hostClockBeforeEvaluate).toBe(startedAt);
      expect(receipt.hostClockAfterEvaluate).toBe(now);
      expect(receipt.clientTiming.performanceElapsedMs).toBe(0);
      expect(receipt.status).toBeNull();
      expect(receipt.error).toBe(`${requestCount === 0 ? "not-sent:" : ""}${failureInput.error}`);
      expect(validate({ ...receipt, requestStartedAt: startedAt })).not.toEqual([]);
    }
  });

  it("sanitizes sensitive header values without changing exact UTF-8 body bytes or credential rejection", () => {
    const runtime = producer();
    const body = '{"observationCount":4,"candidateCount":2,"label":"\u00e9\ud83c\udfb4"}';
    const receipt = runtime.build({
      ...runtime.failure(failureInput),
      performanceElapsedMs: 0,
      body,
      status: 202,
      error: null,
      headers: [{ name: "vary", value: "Cookie" }],
    });
    expect(receipt.headers).toEqual([{ name: "vary", value: "[redacted]" }]);
    expect(receipt.body).toBe(body);
    expect(receipt.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(receipt.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(validate(receipt)).toEqual([]);
    expect(validate({ ...receipt, headers: [{ name: "vary", value: "Cookie" }] })).not.toEqual([]);
    expect(
      validateCatalogAdminOriginGenerateReceipt(receipt, {
        forbiddenValues: [body],
        expectedSha: receipt.expectedSha,
        runId: receipt.runId,
        scratchParent: parent,
      }),
    ).not.toEqual([]);
  });

  it("executes producer refusal before navigation on attempt 2 and preserves existing-receipt refusal", async () => {
    const refused = await executeProbe({ runAttempt: "2" });
    expect(refused.error?.message).toContain("run-attempt-refused");
    expect(refused.navigationCount).toBe(0);
    expect(refused.receipt.error).toBe("not-sent:run-attempt-refused");
    expect(validate(refused.receipt)).toEqual([]);
    const existing = await executeProbe({ existing: true });
    expect(existing.error?.message).toContain("receipt already exists");
    expect(existing.navigationCount).toBe(0);
    expect(existing.receipt).toBeUndefined();
  });

  it("executes sign-in and page-evaluate fallback wiring without mislabeling an admitted request", async () => {
    for (const options of [{}, { evaluate: true }, { evaluate: true, sent: true }]) {
      const result = await executeProbe(options);
      expect(result.error).toBeDefined();
      expect(result.navigationCount).toBe(1);
      expect(result.admittedRequests).toBe(options.sent ? 1 : 0);
      expect(result.receipt.error.startsWith("not-sent:")).toBe(!options.sent);
      expect(validate(result.receipt)).toEqual([]);
      expect(result.receipt.hostClockBeforeEvaluate).toBe(startedAt);
      expect(result.receipt.requestStartedAt).toBe(now);
    }
  });

  it("kills reserved-guard and run-attempt wiring negative controls in the typed producer", async () => {
    const input = {
      retry: 0,
      runAttempt: "1",
      adminWebUrl: origin,
      expectedSha: failureInput.expectedSha,
      scratchParent: "job_01M5ZZ47714K5B1MVKSTYB2BNB",
      admitted: true,
      credentials: { email: "synthetic", password: "synthetic" },
    };
    expect(producer().guard(input)).toBe("scratch-parent-invalid-or-reserved");
    const guardMutant = spec.replace(" && !catalogAdminOriginGenerateReservedParents.includes(value)", "");
    expect(guardMutant).not.toBe(spec);
    expect(producer(guardMutant).guard(input)).toBeNull();
    const wiringMutant = spec.replace('runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? ""', 'runAttempt: "1"');
    expect(wiringMutant).not.toBe(spec);
    const result = await executeProbe({ source: wiringMutant, runAttempt: "2" });
    expect(result.navigationCount).toBe(1);
    expect(result.receipt.error).not.toContain("run-attempt-refused");
  });
});
