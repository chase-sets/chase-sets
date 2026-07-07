import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectionAttentionReport,
  parseRebuildTarget,
  parseStagingProjectionOperationsArgs,
  redactSupportUnsafeText,
  runStagingProjectionOperations,
  sanitizeProjectionOperationsSnapshot,
  validateStagingProjectionOperationsOptions,
} from "./staging-projection-operations.mjs";

const baseEnv = {
  STAGING_PROJECTION_OPERATIONS_ADMIN_URL: "https://admin.staging.chasesets.com",
  PLATFORM_ADMIN_EMAIL: "platform-admin@example.test",
  PLATFORM_ADMIN_PASSWORD: "correct horse battery staple",
  STAGING_PROJECTION_OPERATIONS_OPERATOR_REFERENCE: "issue-4452",
};

describe("staging projection operations argument handling", () => {
  it("defaults to support-safe snapshot mode and reads staging admin credentials from env", () => {
    const options = parseStagingProjectionOperationsArgs([], baseEnv);

    expect(options).toMatchObject({
      mode: "snapshot",
      adminUrl: "https://admin.staging.chasesets.com",
      operatorReference: "issue-4452",
      adminEmail: "platform-admin@example.test",
      adminPassword: "correct horse battery staple",
      targets: [],
      environment: "staging",
    });
    expect(validateStagingProjectionOperationsOptions(options)).toEqual([]);
  });

  it("parses comma-separated targets for retry-blocked mode", () => {
    const options = parseStagingProjectionOperationsArgs(
      [
        "--mode",
        "retry-blocked",
        "--targets",
        "catalog.catalog-admin-catalog-item-projection, checkout.checkout.session-projection",
      ],
      baseEnv,
    );

    expect(options.targets).toEqual([
      "catalog.catalog-admin-catalog-item-projection",
      "checkout.checkout.session-projection",
    ]);
    expect(validateStagingProjectionOperationsOptions(options)).toEqual([]);
  });

  it("validates rebuild targets in slash and dot forms", () => {
    expect(parseRebuildTarget("checkout/checkout.session-projection")).toEqual({
      contextName: "checkout",
      projectionName: "checkout.session-projection",
      displayTarget: "checkout.checkout.session-projection",
    });
    expect(parseRebuildTarget("catalog.catalog-product-contents-projection")).toEqual({
      contextName: "catalog",
      projectionName: "catalog-product-contents-projection",
      displayTarget: "catalog.catalog-product-contents-projection",
    });

    const options = parseStagingProjectionOperationsArgs(
      ["--mode", "rebuild", "--targets", "catalog/catalog product"],
      baseEnv,
    );
    expect(validateStagingProjectionOperationsOptions(options)).toContain(
      "Rebuild target 'catalog/catalog product' must be context/projection-name or context.projection-name.",
    );
  });

  it("rejects snapshot targets and missing credentials before touching the API", () => {
    const options = parseStagingProjectionOperationsArgs(["--targets", "catalog.catalog-projection"], {
      STAGING_PROJECTION_OPERATIONS_ADMIN_URL: "https://admin.staging.chasesets.com",
    });

    const errors = validateStagingProjectionOperationsOptions(options);
    expect(errors).toContain("--targets is only supported for retry-blocked and rebuild modes.");
    expect(errors).toContain("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required.");
  });
});

describe("staging projection operations support-safe sanitization", () => {
  it("redacts credentials, tokens, emails, database URLs, and UUIDs from free text", () => {
    expect(
      redactSupportUnsafeText(
        'DATABASE_URL=postgres://user:pass@db.example/chase Bearer session_token "sessionToken":"abc" operator@example.test 9cf3ae99-7b02-4db1-a257-9eb48c19e8c3 password=hunter2',
      ),
    ).toBe("DATABASE_URL=[redacted] [redacted] [redacted] [redacted] [redacted] password=[redacted]");
  });

  it("sanitizes snapshots without raw stream ids, event ids, user ids, or unsafe last errors", () => {
    const sanitized = sanitizeProjectionOperationsSnapshot(sampleSnapshot());
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.summary).toMatchObject({
      status: "degraded",
      totalGroups: 2,
      errorGroups: 1,
    });
    expect(sanitized.projectionGroups[0]).toMatchObject({
      projectionKey: "catalog.catalog-admin-catalog-item-projection",
      state: "degraded",
      lastErrorClass: "redacted-error",
    });
    expect(sanitized.blockedProjections[0].blockedStreams[0]).toMatchObject({
      streamIdFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
      deferredEventCount: 3,
    });
    expect(sanitized.operations[0]).toMatchObject({
      operationIdFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
      requestedByUserIdFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
      errorClass: "redacted-error",
    });
    expect(serialized).not.toContain("stream-private-1");
    expect(serialized).not.toContain("event-private-1");
    expect(serialized).not.toContain("user-private-1");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("operator@example.test");
    expect(serialized).not.toContain("pod-raw-name");
  });

  it("builds a compact attention report from a support-safe snapshot", () => {
    const report = buildProjectionAttentionReport(sanitizeProjectionOperationsSnapshot(sampleSnapshot()));

    expect(report).toMatchObject({
      status: "attention-needed",
      supportSafe: true,
      attentionItems: expect.arrayContaining([
        { id: "degraded-groups", severity: "danger", count: 1 },
        { id: "blocked-streams", severity: "warning", count: 1 },
        { id: "poison-events", severity: "warning", count: 1 },
      ]),
      degradedGroups: [
        expect.objectContaining({
          projectionKey: "catalog.catalog-admin-catalog-item-projection",
          lastErrorClass: "redacted-error",
        }),
      ],
    });
  });

  it("reconciles count-only blocked projection summaries with per-group counters", () => {
    const sanitized = sanitizeProjectionOperationsSnapshot(counterOnlySnapshot({ blockedStreamCount: 12 }));
    const report = buildProjectionAttentionReport(sanitized);

    expect(sanitized.blockedProjections[0]).toMatchObject({
      projectionKey: "catalog.catalog-admin-catalog-item-projection",
      blockedStreamCount: 12,
      blockedStreams: [],
    });
    expect(report.attentionItems).toContainEqual({ id: "blocked-streams", severity: "warning", count: 12 });
    expect(report.degradedGroups[0]).toMatchObject({
      projectionKey: "catalog.catalog-admin-catalog-item-projection",
      blockedStreamCount: 12,
    });
  });

  it("includes support-safe poison error classes for degraded groups", () => {
    const sanitized = sanitizeProjectionOperationsSnapshot(poisonClassSnapshot());
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.projectionGroups[0]).toMatchObject({
      projectionKey: "catalog.catalog-admin-catalog-item-projection",
      poisonEventErrorClasses: [
        "TypeError: Cannot read properties of undefined while applying [identifier] for [identifier]",
      ],
    });
    expect(serialized).not.toContain("stream-private-1");
    expect(serialized).not.toContain("user_123456");
    expect(serialized).not.toContain("event-private-1");
  });

  it("summarizes failed-operation error classes and running operations support-safely", () => {
    const failedOperation = (operationId, message) => ({
      operationId,
      operationKind: "retry-blocked-stream",
      state: "failed",
      contextName: "unknown",
      projectionName: null,
      projectionKey: "discovery-item-detail-projection:catalog:v2",
      streamId: "stream-private-1",
      requestedByUserId: "user-private-1",
      claimOwnerId: null,
      attemptCount: 5,
      nextEligibleAt: "2026-07-07T19:00:00.000Z",
      requestedAt: "2026-07-07T17:00:00.000Z",
      startedAt: "2026-07-07T17:01:00.000Z",
      updatedAt: "2026-07-07T17:02:00.000Z",
      completedAt: "2026-07-07T17:02:00.000Z",
      error: message == null ? null : { message },
    });
    const sanitized = sanitizeProjectionOperationsSnapshot({
      ...sampleSnapshot(),
      failedOperations: [
        failedOperation("op-failed-1", "Projection runner lease 'projection-group:discovery.x' is already active."),
        failedOperation("op-failed-2", "Projection runner lease 'projection-group:discovery.x' is already active."),
        failedOperation("op-failed-3", "Projection operation 'op-failed-3' timed out after 600000ms and was aborted."),
      ],
      runningOperations: [
        {
          ...failedOperation("op-running-1", null),
          state: "running",
          attemptCount: 2,
          completedAt: null,
        },
      ],
    });
    const report = buildProjectionAttentionReport(sanitized);

    expect(sanitized.failedOperations).toHaveLength(3);
    expect(sanitized.runningOperations).toHaveLength(1);
    expect(sanitized.runningOperations[0]).toMatchObject({
      attemptCount: 2,
      streamIdFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
    });

    const classEntries = Object.entries(report.failedOperationErrorClasses);
    expect(classEntries).toHaveLength(2);
    const timeoutClassEntry = classEntries.find(([errorClass]) => errorClass.includes("timed out after"));
    expect(timeoutClassEntry?.[1]).toBe(1);
    const leaseClassEntry = classEntries.find(([errorClass]) => errorClass.includes("already active"));
    expect(leaseClassEntry?.[1]).toBe(2);
    expect(report.runningOperations).toEqual([
      expect.objectContaining({
        operationKind: "retry-blocked-stream",
        state: "running",
        attemptCount: 2,
      }),
    ]);

    const serialized = JSON.stringify({ sanitized, report });
    expect(serialized).not.toContain("stream-private-1");
    expect(serialized).not.toContain("user-private-1");
  });
});

describe("staging projection operations runner", () => {
  it("writes before and after support-safe artifacts for snapshot mode", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "projection-operations-"));
    const calls = [];
    try {
      const result = await runStagingProjectionOperations(
        {
          ...parseStagingProjectionOperationsArgs(["--out-dir", outDir, "--checked-at", "2026-07-06T00:00:00.000Z"], {
            ...baseEnv,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
          }),
        },
        {
          fetchImpl: fakeFetch(calls, [sampleSnapshot(), healthySnapshot()]),
          now: () => "2026-07-06T00:01:00.000Z",
        },
      );

      expect(result.record.result).toBe("success");
      expect(result.record.beforeSnapshot).toMatchObject({ artifact: "before-snapshot.json", supportSafe: true });
      expect(result.record.afterSnapshot).toMatchObject({ artifact: "after-snapshot.json", supportSafe: true });
      expect(result.record.report.status).toBe("ok");
      expect(calls.map((call) => [call.method, call.path])).toEqual([
        ["POST", "/api/auth/password-sign-in"],
        ["GET", "/api/platform/projections"],
        ["GET", "/api/platform/projections/catalog-admin-catalog-item-projection:catalog:v1/blocked-streams"],
        ["GET", "/api/platform/projections/catalog.catalog-admin-catalog-item-projection/blocked-streams"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections/operations"],
      ]);

      const report = JSON.parse(await readFile(join(outDir, "staging-projection-operations.json"), "utf8"));
      const before = JSON.parse(await readFile(join(outDir, "before-snapshot.json"), "utf8"));
      const after = JSON.parse(await readFile(join(outDir, "after-snapshot.json"), "utf8"));
      expect(report.supportSafe).toBe(true);
      expect(before.supportSafe).toBe(true);
      expect(after.supportSafe).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("retries every blocked stream for named projection keys without writing raw stream ids", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "projection-operations-"));
    const calls = [];
    try {
      const result = await runStagingProjectionOperations(
        parseStagingProjectionOperationsArgs(
          [
            "--mode",
            "retry-blocked",
            "--targets",
            "catalog.catalog-admin-catalog-item-projection",
            "--out-dir",
            outDir,
          ],
          baseEnv,
        ),
        {
          fetchImpl: fakeFetch(calls, [sampleSnapshot(), healthySnapshot()]),
          now: () => "2026-07-06T00:01:00.000Z",
        },
      );

      expect(result.record.result).toBe("success");
      expect(result.record.commands).toEqual([
        expect.objectContaining({
          operationKind: "retry-blocked",
          target: "catalog.catalog-admin-catalog-item-projection",
          status: "requested",
          streamCount: 1,
          streamIdFingerprints: [expect.stringMatching(/^[a-f0-9]{16}$/)],
        }),
      ]);
      expect(calls.map((call) => [call.method, call.path])).toEqual([
        ["POST", "/api/auth/password-sign-in"],
        ["GET", "/api/platform/projections"],
        ["GET", "/api/platform/projections/catalog-admin-catalog-item-projection:catalog:v1/blocked-streams"],
        ["GET", "/api/platform/projections/catalog.catalog-admin-catalog-item-projection/blocked-streams"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections/operations"],
        [
          "POST",
          "/api/platform/projections/catalog.catalog-admin-catalog-item-projection/blocked-streams/stream-private-1/retry",
        ],
        ["GET", "/api/platform/projections"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections/operations"],
      ]);

      const reportText = await readFile(join(outDir, "staging-projection-operations.json"), "utf8");
      expect(reportText).not.toContain("stream-private-1");
      expect(reportText).not.toContain("session_admin");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("resolves retry streams from the per-projection blocked-stream source when the snapshot only has counters", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "projection-operations-"));
    const calls = [];
    try {
      const result = await runStagingProjectionOperations(
        parseStagingProjectionOperationsArgs(
          [
            "--mode",
            "retry-blocked",
            "--targets",
            "catalog.catalog-admin-catalog-item-projection",
            "--out-dir",
            outDir,
          ],
          baseEnv,
        ),
        {
          fetchImpl: fakeFetch(
            calls,
            [counterOnlySnapshot({ blockedStreamCount: 2 }), healthySnapshot()],
            new Map([
              [
                "catalog.catalog-admin-catalog-item-projection",
                {
                  projectionKey: "catalog.catalog-admin-catalog-item-projection",
                  blockedStreams: [
                    sampleBlockedStream("catalog.catalog-admin-catalog-item-projection", "stream-private-1"),
                    sampleBlockedStream("catalog.catalog-admin-catalog-item-projection", "stream-private-2"),
                  ],
                  poisonEvents: [],
                },
              ],
            ]),
          ),
          now: () => "2026-07-06T00:01:00.000Z",
        },
      );

      expect(result.record.result).toBe("success");
      expect(result.record.commands[0]).toMatchObject({
        operationKind: "retry-blocked",
        target: "catalog.catalog-admin-catalog-item-projection",
        status: "requested",
        streamCount: 2,
        sourceProjectionKeys: ["catalog.catalog-admin-catalog-item-projection"],
      });
      expect(calls.map((call) => [call.method, call.path])).toEqual([
        ["POST", "/api/auth/password-sign-in"],
        ["GET", "/api/platform/projections"],
        ["GET", "/api/platform/projections/catalog.catalog-admin-catalog-item-projection/blocked-streams"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections/operations"],
        [
          "POST",
          "/api/platform/projections/catalog.catalog-admin-catalog-item-projection/blocked-streams/stream-private-1/retry",
        ],
        [
          "POST",
          "/api/platform/projections/catalog.catalog-admin-catalog-item-projection/blocked-streams/stream-private-2/retry",
        ],
        ["GET", "/api/platform/projections"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections/operations"],
      ]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("records a retry-blocked target error and continues remaining targets", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "projection-operations-"));
    const calls = [];
    try {
      const result = await runStagingProjectionOperations(
        parseStagingProjectionOperationsArgs(
          [
            "--mode",
            "retry-blocked",
            "--targets",
            "identity.identity-consent-projection,catalog.catalog-admin-catalog-item-projection",
            "--out-dir",
            outDir,
          ],
          baseEnv,
        ),
        {
          fetchImpl: fakeFetch(
            calls,
            [multiTargetRetryCounterSnapshot(), healthySnapshot()],
            new Map([
              [
                "catalog.catalog-admin-catalog-item-projection",
                {
                  projectionKey: "catalog.catalog-admin-catalog-item-projection",
                  blockedStreams: [
                    sampleBlockedStream("catalog.catalog-admin-catalog-item-projection", "stream-private-1"),
                  ],
                  poisonEvents: [],
                },
              ],
            ]),
            new Set(["identity.identity-consent-projection"]),
          ),
          now: () => "2026-07-06T00:01:00.000Z",
        },
      );

      expect(result.record.result).toBe("completed-with-errors");
      expect(result.record.commands).toEqual([
        expect.objectContaining({
          operationKind: "retry-blocked",
          target: "identity.identity-consent-projection",
          status: "error",
          reason: "blocked-stream-detail-failed",
          errors: [
            {
              projectionKey: "identity.identity-consent-projection",
              error: "Projection blocked streams identity.identity-consent-projection failed with HTTP 500.",
            },
          ],
        }),
        expect.objectContaining({
          operationKind: "retry-blocked",
          target: "catalog.catalog-admin-catalog-item-projection",
          status: "requested",
          streamCount: 1,
        }),
      ]);
      expect(calls.map((call) => [call.method, call.path])).toContainEqual([
        "POST",
        "/api/platform/projections/catalog.catalog-admin-catalog-item-projection/blocked-streams/stream-private-1/retry",
      ]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("retries dotted projection-name targets using blocked stream checkpoint keys", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "projection-operations-"));
    const calls = [];
    const groupProjectionKey = "checkout.checkout.session-projection";
    const checkpointKey = "checkout.session-projection:checkout:v1";
    try {
      const result = await runStagingProjectionOperations(
        parseStagingProjectionOperationsArgs(
          ["--mode", "retry-blocked", "--targets", groupProjectionKey, "--out-dir", outDir],
          baseEnv,
        ),
        {
          fetchImpl: fakeFetch(
            calls,
            [checkoutDottedProjectionCounterSnapshot(), healthySnapshot()],
            new Map([
              [
                groupProjectionKey,
                {
                  projectionKey: groupProjectionKey,
                  blockedStreams: [sampleBlockedStream(checkpointKey, "checkout.session-1")],
                  poisonEvents: [],
                },
              ],
            ]),
          ),
          now: () => "2026-07-06T00:01:00.000Z",
        },
      );

      expect(result.record.result).toBe("success");
      expect(result.record.commands[0]).toMatchObject({
        operationKind: "retry-blocked",
        target: groupProjectionKey,
        status: "requested",
        streamCount: 1,
        sourceProjectionKeys: [groupProjectionKey, checkpointKey],
      });
      expect(calls.map((call) => [call.method, call.path])).toEqual([
        ["POST", "/api/auth/password-sign-in"],
        ["GET", "/api/platform/projections"],
        ["GET", "/api/platform/projections/checkout.checkout.session-projection/blocked-streams"],
        ["GET", "/api/platform/projections/checkout.session-projection:checkout:v1/blocked-streams"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections/operations"],
        [
          "POST",
          "/api/platform/projections/checkout.session-projection:checkout:v1/blocked-streams/checkout.session-1/retry",
        ],
        ["GET", "/api/platform/projections"],
        ["GET", "/api/platform/projections/operations"],
        ["GET", "/api/platform/projections/operations"],
      ]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("requests rebuilds with the API confirm payload", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "projection-operations-"));
    const calls = [];
    try {
      const result = await runStagingProjectionOperations(
        parseStagingProjectionOperationsArgs(
          ["--mode", "rebuild", "--targets", "checkout/checkout.session-projection", "--out-dir", outDir],
          baseEnv,
        ),
        {
          fetchImpl: fakeFetch(calls, [sampleSnapshot(), healthySnapshot()]),
          now: () => "2026-07-06T00:01:00.000Z",
        },
      );

      expect(result.record.result).toBe("success");
      expect(result.record.commands[0]).toMatchObject({
        operationKind: "rebuild",
        target: "checkout.checkout.session-projection",
        contextName: "checkout",
        projectionName: "checkout.session-projection",
        status: "requested",
      });
      expect(calls.find((call) => call.path.endsWith("/rebuild"))).toMatchObject({
        method: "POST",
        path: "/api/platform/projections/groups/checkout/checkout.session-projection/rebuild",
        body: { confirm: "rebuild" },
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

function fakeFetch(calls, snapshots, blockedDetailsByProjectionKey = new Map(), failedBlockedDetails = new Set()) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({
      method: init.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      authorization: init.headers?.Authorization ?? null,
      body,
    });

    if (url.pathname === "/api/auth/password-sign-in") {
      return jsonResponse({ type: "session-started", sessionToken: "session_admin" });
    }
    if (url.pathname === "/api/platform/projections" && (init.method ?? "GET") === "GET") {
      return jsonResponse(snapshots.shift() ?? healthySnapshot());
    }
    if (url.pathname.endsWith("/blocked-streams") && (init.method ?? "GET") === "GET") {
      const projectionKey = decodeURIComponent(
        url.pathname.replace(/^\/api\/platform\/projections\//, "").replace(/\/blocked-streams$/, ""),
      );
      if (failedBlockedDetails.has(projectionKey)) {
        return jsonResponse({ error: "blocked stream detail unavailable" }, 500);
      }
      return jsonResponse(
        blockedDetailsByProjectionKey.get(projectionKey) ?? sampleBlockedProjectionDetails(projectionKey),
      );
    }
    if (url.pathname.endsWith("/retry") || url.pathname.endsWith("/rebuild")) {
      return jsonResponse({
        operation: {
          operationId: "operation-private-1",
          operationKind: url.pathname.endsWith("/retry") ? "retry-blocked-stream" : "rebuild",
          state: "queued",
          contextName: "catalog",
          projectionName: "catalog-admin-catalog-item-projection",
          projectionKey: "catalog.catalog-admin-catalog-item-projection",
          streamId: url.pathname.includes("/blocked-streams/") ? "stream-private-1" : null,
          requestedByUserId: "user-private-1",
          claimOwnerId: null,
          requestedAt: "2026-07-06T00:00:10.000Z",
          startedAt: null,
          updatedAt: "2026-07-06T00:00:10.000Z",
          completedAt: null,
          error: null,
        },
      });
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

function jsonResponse(body, status = 200) {
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? "application/json" : null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function sampleBlockedProjectionDetails(projectionKey) {
  if (projectionKey !== "catalog.catalog-admin-catalog-item-projection") {
    return { projectionKey, blockedStreams: [], poisonEvents: [] };
  }

  return {
    projectionKey,
    blockedStreams: [sampleBlockedStream(projectionKey, "stream-private-1")],
    poisonEvents: [
      {
        eventId: "event-private-1",
        eventType: "catalog.ItemChanged",
        streamId: "stream-private-1",
        streamVersion: 2,
        globalPosition: "7",
        errorMessage: "failed for operator@example.test",
        retryCount: 1,
        firstSeenAt: "2026-07-06T00:00:00.000Z",
        lastSeenAt: "2026-07-06T00:00:00.000Z",
        state: "active",
      },
    ],
  };
}

function sampleBlockedStream(projectionKey, streamId) {
  return {
    projectionKey,
    streamId,
    firstBlockedGlobalPosition: "7",
    firstBlockedStreamVersion: 2,
    lastSeenGlobalPosition: "10",
    deferredEventCount: 3,
    state: "blocked",
  };
}

function counterOnlySnapshot({ blockedStreamCount }) {
  return {
    ...sampleSnapshot(),
    projectionGroups: sampleSnapshot().projectionGroups.map((group) =>
      group.projectionName === "catalog-admin-catalog-item-projection"
        ? {
            ...group,
            blockedStreamCount,
            poisonEventCount: 1,
            subscriptions: [],
          }
        : group,
    ),
    blockedProjections: [
      {
        projectionKey: "catalog.catalog-admin-catalog-item-projection",
        blockedStreamCount,
        poisonEventCount: 1,
      },
    ],
  };
}

function poisonClassSnapshot() {
  return {
    ...counterOnlySnapshot({ blockedStreamCount: 1 }),
    blockedProjections: [
      {
        projectionKey: "catalog.catalog-admin-catalog-item-projection",
        blockedStreamCount: 1,
        poisonEventCount: 1,
        blockedStreams: [sampleBlockedStream("catalog.catalog-admin-catalog-item-projection", "stream-private-1")],
        poisonEvents: [
          {
            eventId: "event-private-1",
            eventType: "catalog.ItemChanged",
            streamId: "stream-private-1",
            streamVersion: 2,
            globalPosition: "7",
            error_message:
              "TypeError: Cannot read properties of undefined while applying stream-private-1 for user_123456",
            error_stack: "TypeError: Cannot read properties of undefined\n    at applyProjection",
            retryCount: 1,
            firstSeenAt: "2026-07-06T00:00:00.000Z",
            lastSeenAt: "2026-07-06T00:00:00.000Z",
            state: "active",
          },
        ],
      },
    ],
  };
}

function checkoutDottedProjectionCounterSnapshot() {
  return {
    ...sampleSnapshot(),
    projectionGroups: [
      {
        projectionName: "checkout.session-projection",
        targetContextName: "checkout",
        sourceContextNames: ["checkout"],
        state: "degraded",
        initialized: true,
        caughtUp: false,
        revisionStale: false,
        projectionRevision: 1,
        storedProjectionRevision: 1,
        outstandingEventCount: "1",
        blockedStreamCount: 1,
        poisonEventCount: 0,
        updatedAt: "2026-07-06T00:00:00.000Z",
        subscriptions: [
          {
            checkpointKey: "checkout.session-projection:checkout:v1",
            subscriptionName: "checkout.checkout.session-projection",
            projectionName: "checkout.session-projection",
            sourceContextName: "checkout",
            targetContextName: "checkout",
            subscriptionVersion: 1,
            lastGlobalPosition: "7",
            sourceHeadGlobalPosition: "8",
            outstandingEventCount: "1",
            state: "degraded",
            lastError: null,
            blockedStreamCount: 1,
            poisonEventCount: 0,
          },
        ],
      },
    ],
    blockedProjections: [],
  };
}

function multiTargetRetryCounterSnapshot() {
  return {
    ...counterOnlySnapshot({ blockedStreamCount: 1 }),
    projectionGroups: [
      ...counterOnlySnapshot({ blockedStreamCount: 1 }).projectionGroups,
      {
        projectionName: "identity-consent-projection",
        targetContextName: "identity",
        sourceContextNames: ["identity"],
        state: "degraded",
        initialized: true,
        caughtUp: false,
        revisionStale: false,
        projectionRevision: 1,
        storedProjectionRevision: 1,
        outstandingEventCount: "1",
        blockedStreamCount: 1,
        poisonEventCount: 1,
        updatedAt: "2026-07-06T00:00:00.000Z",
        subscriptions: [
          {
            checkpointKey: "identity-consent-projection:identity:v1",
            subscriptionName: "identity.identity-consent-projection",
            projectionName: "identity-consent-projection",
            sourceContextName: "identity",
            targetContextName: "identity",
            subscriptionVersion: 1,
            lastGlobalPosition: "7",
            sourceHeadGlobalPosition: "8",
            outstandingEventCount: "1",
            state: "degraded",
            lastError: null,
            blockedStreamCount: 1,
            poisonEventCount: 1,
          },
        ],
      },
    ],
    blockedProjections: [
      ...counterOnlySnapshot({ blockedStreamCount: 1 }).blockedProjections,
      {
        projectionKey: "identity.identity-consent-projection",
        blockedStreamCount: 1,
        poisonEventCount: 1,
      },
    ],
  };
}

function sampleSnapshot() {
  return {
    summary: {
      status: "degraded",
      totalGroups: 2,
      caughtUpGroups: 1,
      behindGroups: 0,
      staleGroups: 0,
      runningGroups: 0,
      errorGroups: 1,
      outstandingEventCount: "3",
    },
    projectionStatusSource: "durable",
    projectionGroups: [
      {
        projectionName: "catalog-admin-catalog-item-projection",
        targetContextName: "catalog",
        sourceContextNames: ["catalog"],
        state: "degraded",
        initialized: true,
        caughtUp: false,
        revisionStale: false,
        projectionRevision: 3,
        storedProjectionRevision: 3,
        requiredDuringBootstrap: false,
        outstandingEventCount: "3",
        sourceLagEventCount: "3",
        applicableLagEstimate: "3",
        blockedStreamCount: 1,
        poisonEventCount: 1,
        updatedAt: "2026-07-06T00:00:00.000Z",
        lastError: "failed for operator@example.test with postgres://user:pass@db.example/chase",
        subscriptions: [
          {
            checkpointKey: "catalog-admin-catalog-item-projection:catalog:v1",
            subscriptionName: "catalog-admin-catalog-item-projection",
            projectionName: "catalog-admin-catalog-item-projection",
            sourceContextName: "catalog",
            targetContextName: "catalog",
            subscriptionVersion: 1,
            lastGlobalPosition: "7",
            sourceHeadGlobalPosition: "10",
            outstandingEventCount: "3",
            state: "degraded",
            lastError: "postgres://user:pass@db.example/chase",
            blockedStreamCount: 1,
            poisonEventCount: 1,
          },
        ],
      },
      {
        projectionName: "checkout.session-projection",
        targetContextName: "checkout",
        sourceContextNames: ["checkout"],
        state: "caught-up",
        initialized: true,
        caughtUp: true,
        revisionStale: false,
        projectionRevision: 1,
        storedProjectionRevision: 1,
        outstandingEventCount: "0",
        blockedStreamCount: 0,
        poisonEventCount: 0,
        updatedAt: "2026-07-06T00:00:00.000Z",
        subscriptions: [],
      },
    ],
    blockedProjections: [
      {
        projectionKey: "catalog.catalog-admin-catalog-item-projection",
        blockedStreams: [
          {
            projectionKey: "catalog.catalog-admin-catalog-item-projection",
            streamId: "stream-private-1",
            firstBlockedGlobalPosition: "7",
            firstBlockedStreamVersion: 2,
            lastSeenGlobalPosition: "10",
            deferredEventCount: 3,
            state: "blocked",
          },
        ],
        poisonEvents: [
          {
            eventId: "event-private-1",
            eventType: "catalog.ItemChanged",
            streamId: "stream-private-1",
            streamVersion: 2,
            globalPosition: "7",
            errorMessage: "failed for operator@example.test",
            retryCount: 1,
            firstSeenAt: "2026-07-06T00:00:00.000Z",
            lastSeenAt: "2026-07-06T00:00:00.000Z",
            state: "active",
          },
        ],
      },
    ],
    workers: [
      {
        worker_id: "worker-private-1",
        worker_kind: "platform-worker",
        worker_state: "active",
        pod_name: "pod-raw-name",
        heartbeat_age_ms: 12,
      },
    ],
    runners: [
      {
        runner_name: "catalog.catalog-admin-catalog-item-projection",
        state: "degraded",
        owner_id: "worker-private-1",
      },
    ],
    operations: [
      {
        operationId: "operation-private-1",
        operationKind: "rebuild",
        state: "failed",
        contextName: "catalog",
        projectionName: "catalog-admin-catalog-item-projection",
        projectionKey: "catalog.catalog-admin-catalog-item-projection",
        streamId: "stream-private-1",
        requestedByUserId: "user-private-1",
        claimOwnerId: "worker-private-1",
        requestedAt: "2026-07-06T00:00:00.000Z",
        startedAt: "2026-07-06T00:00:01.000Z",
        updatedAt: "2026-07-06T00:00:02.000Z",
        completedAt: "2026-07-06T00:00:02.000Z",
        error: { message: "failed for operator@example.test" },
      },
    ],
    operationSummary: {
      queuedCount: "0",
      runningCount: "0",
      failedCount: "1",
      cancelRequestedCount: "0",
      oldestQueuedAt: null,
      oldestRunningAt: null,
      averageDurationMs: "500",
    },
  };
}

function healthySnapshot() {
  return {
    ...sampleSnapshot(),
    summary: {
      status: "ok",
      totalGroups: 2,
      caughtUpGroups: 2,
      behindGroups: 0,
      staleGroups: 0,
      runningGroups: 0,
      errorGroups: 0,
      outstandingEventCount: "0",
    },
    projectionGroups: sampleSnapshot().projectionGroups.map((group) => ({
      ...group,
      state: "caught-up",
      caughtUp: true,
      outstandingEventCount: "0",
      sourceLagEventCount: "0",
      blockedStreamCount: 0,
      poisonEventCount: 0,
      lastError: null,
      subscriptions: [],
    })),
    blockedProjections: [],
    operations: [],
    operationSummary: {
      queuedCount: "0",
      runningCount: "0",
      failedCount: "0",
      cancelRequestedCount: "0",
      oldestQueuedAt: null,
      oldestRunningAt: null,
      averageDurationMs: null,
    },
  };
}
