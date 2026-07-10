#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const STAGING_PROJECTION_OPERATIONS_VERSION = "staging-projection-operations/v1";
export const PROJECTION_OPERATION_MODES = Object.freeze(["snapshot", "retry-blocked", "rebuild"]);
export const DEFAULT_OUT_DIR = "artifacts/staging-projection-operations";

const SENSITIVE_REPLACEMENTS = Object.freeze([
  [/\bpostgres(?:ql)?:\/\/[^\s'"`<>]+/gi, "[redacted]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._-]+/g, "[redacted]"],
  [/\b[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}\b/g, "[redacted]"],
  [/\b(token|password|secret|cookie|sessionToken)=([^\s]+)/gi, "$1=[redacted]"],
  [/"sessionToken"\s*:\s*"[^"]+"/gi, "[redacted]"],
]);

export function parseStagingProjectionOperationsArgs(argv, env = process.env) {
  const mode = readOption(argv, "--mode") ?? readEnv("STAGING_PROJECTION_OPERATIONS_MODE", env) ?? "snapshot";
  return {
    mode,
    targets: readTargetCsv(readOption(argv, "--targets") ?? readEnv("STAGING_PROJECTION_OPERATIONS_TARGETS", env)),
    adminUrl:
      readOption(argv, "--admin-url") ??
      readEnv("STAGING_PROJECTION_OPERATIONS_ADMIN_URL", env) ??
      readEnv("ADMIN_URL", env),
    outDir: readOption(argv, "--out-dir") ?? readEnv("STAGING_PROJECTION_OPERATIONS_OUT_DIR", env) ?? DEFAULT_OUT_DIR,
    operatorReference:
      readOption(argv, "--operator-reference") ??
      readEnv("STAGING_PROJECTION_OPERATIONS_OPERATOR_REFERENCE", env) ??
      null,
    adminEmail: readEnv("PLATFORM_ADMIN_EMAIL", env),
    adminPassword: readEnv("PLATFORM_ADMIN_PASSWORD", env),
    environment: readOption(argv, "--environment") ?? readEnv("DEPLOYMENT_ENVIRONMENT", env) ?? "staging",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    workflowRunId: readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readEnv("GITHUB_RUN_ATTEMPT", env),
    commitSha: readEnv("GITHUB_SHA", env),
  };
}

export function validateStagingProjectionOperationsOptions(options) {
  const errors = [];

  if (!PROJECTION_OPERATION_MODES.includes(options.mode)) {
    errors.push(`--mode must be one of: ${PROJECTION_OPERATION_MODES.join(", ")}.`);
  }
  if (options.environment !== "staging") {
    errors.push(`Staging projection operations only support --environment staging, got '${options.environment}'.`);
  }
  if (!normalizeUrl(options.adminUrl)) {
    errors.push("--admin-url, STAGING_PROJECTION_OPERATIONS_ADMIN_URL, or ADMIN_URL must be a valid admin URL.");
  }
  if (!normalizeString(options.adminEmail) || !normalizeString(options.adminPassword)) {
    errors.push("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required.");
  }
  if ((options.mode === "retry-blocked" || options.mode === "rebuild") && options.targets.length === 0) {
    errors.push(`--targets is required for --mode ${options.mode}.`);
  }
  if (options.mode === "snapshot" && options.targets.length > 0) {
    errors.push("--targets is only supported for retry-blocked and rebuild modes.");
  }

  if (options.mode === "retry-blocked") {
    for (const target of options.targets) {
      if (!isProjectionKey(target)) {
        errors.push(`Retry target '${target}' must be a projection key like context.projection-name.`);
      }
    }
  }
  if (options.mode === "rebuild") {
    for (const target of options.targets) {
      const parsed = parseRebuildTarget(target);
      if (!parsed) {
        errors.push(`Rebuild target '${target}' must be context/projection-name or context.projection-name.`);
      }
    }
  }

  return errors;
}

export async function runStagingProjectionOperations(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const record = createBaseRecord(options);
  const errors = validateStagingProjectionOperationsOptions(options);

  await mkdir(options.outDir, { recursive: true });
  if (errors.length > 0) {
    record.errors.push(...errors);
    finalizeRecord(record, now());
    await writeReport(options, record);
    return { record, passesGate: false };
  }

  try {
    const adminBaseUrl = normalizeUrl(options.adminUrl);
    const sessionToken = await signInWithPassword(
      { adminBaseUrl, email: options.adminEmail, password: options.adminPassword },
      fetchImpl,
    );
    const auth = { adminBaseUrl, sessionToken, fetchImpl };

    const beforeSnapshot = await hydrateProjectionOperationsBlockedDetails(
      await fetchProjectionOperationsSnapshot(auth),
      auth,
      options.mode === "retry-blocked" ? options.targets : [],
      options.mode === "retry-blocked" ? { onDetailError: () => undefined } : {},
    );
    const safeBeforeSnapshot = sanitizeProjectionOperationsSnapshot({
      ...beforeSnapshot,
      ...(await fetchProjectionOperationHistory(auth)),
    });
    record.beforeSnapshot = summarizeSnapshotArtifact("before-snapshot.json", safeBeforeSnapshot);
    await writeJsonRecord(join(options.outDir, "before-snapshot.json"), safeBeforeSnapshot);

    if (options.mode === "retry-blocked") {
      record.commands = await retryBlockedStreamsForTargets(options.targets, beforeSnapshot, auth);
    } else if (options.mode === "rebuild") {
      record.commands = await rebuildProjectionGroups(options.targets, auth);
    }

    const afterSnapshot = await hydrateProjectionOperationsBlockedDetails(
      await fetchProjectionOperationsSnapshot(auth),
      auth,
      [],
      options.mode === "retry-blocked"
        ? {
            onDetailError: (projectionKey, error) => {
              record.errors.push(`Projection blocked streams ${projectionKey}: ${summarizeSafeError(error)}`);
            },
          }
        : {},
    );
    const safeAfterSnapshot = sanitizeProjectionOperationsSnapshot({
      ...afterSnapshot,
      ...(await fetchProjectionOperationHistory(auth)),
    });
    record.afterSnapshot = summarizeSnapshotArtifact("after-snapshot.json", safeAfterSnapshot);
    record.report = buildProjectionAttentionReport(safeAfterSnapshot);
    await writeJsonRecord(join(options.outDir, "after-snapshot.json"), safeAfterSnapshot);
  } catch (error) {
    record.errors.push(summarizeSafeError(error));
  }

  finalizeRecord(record, now());
  await writeReport(options, record);
  return { record, passesGate: record.result === "success" };
}

export function parseRebuildTarget(target) {
  const value = normalizeString(target);
  if (!value) {
    return null;
  }
  const separatorIndex = value.includes("/") ? value.indexOf("/") : value.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return null;
  }
  const contextName = value.slice(0, separatorIndex);
  const projectionName = value.slice(separatorIndex + 1);
  if (!isContextName(contextName) || !isProjectionName(projectionName)) {
    return null;
  }
  return { contextName, projectionName, displayTarget: `${contextName}.${projectionName}` };
}

export function sanitizeProjectionOperationsSnapshot(snapshot) {
  const blockedProjections = readArray(snapshot?.blockedProjections)
    .map(sanitizeBlockedProjection)
    .filter((projection) => projection.projectionKey)
    .sort((left, right) => left.projectionKey.localeCompare(right.projectionKey));
  const groups = reconcileProjectionGroupCounters(
    readArray(snapshot?.projectionGroups).map(sanitizeProjectionGroup),
    blockedProjections,
  ).sort(compareGroup);
  const operations = readArray(snapshot?.operations).map(sanitizeOperation).sort(compareOperation);
  const failedOperations = readArray(snapshot?.failedOperations).map(sanitizeOperation).sort(compareOperation);
  const runningOperations = readArray(snapshot?.runningOperations).map(sanitizeOperation).sort(compareOperation);
  const runners = readArray(snapshot?.runners).map(sanitizeRuntimeRecord).filter(Boolean).sort(compareRuntimeRecord);
  const workers = readArray(snapshot?.workers).map(sanitizeRuntimeRecord).filter(Boolean).sort(compareRuntimeRecord);

  return {
    schemaVersion: "support-safe-projection-operations-snapshot/v1",
    supportSafe: true,
    redaction: supportSafeRedaction(),
    summary: sanitizeSummary(snapshot?.summary),
    projectionStatusSource: readSafeEnum(snapshot?.projectionStatusSource, "unknown"),
    projectionGroups: groups,
    blockedProjections,
    workers,
    runners,
    operations,
    failedOperations,
    runningOperations,
    operationSummary: sanitizeOperationSummary(snapshot?.operationSummary),
  };
}

export function buildProjectionAttentionReport(snapshot) {
  const degradedGroups = snapshot.projectionGroups.filter(
    (group) => group.state === "degraded" || group.state === "error",
  );
  const staleGroups = snapshot.projectionGroups.filter((group) => group.revisionStale);
  const blockedStreamCount = snapshot.blockedProjections.reduce(
    (sum, projection) => sum + projection.blockedStreamCount,
    0,
  );
  const poisonEventCount = snapshot.projectionGroups.reduce((sum, group) => sum + group.poisonEventCount, 0);
  const failedOperationCount = snapshot.operations.filter((operation) => operation.state === "failed").length;
  const failedOperationHistory = readArray(snapshot.failedOperations);
  const failedOperationErrorClasses = {};
  for (const operation of failedOperationHistory) {
    const errorClass = operation.errorClass ?? "unclassified";
    failedOperationErrorClasses[errorClass] = (failedOperationErrorClasses[errorClass] ?? 0) + 1;
  }
  const runningOperations = readArray(snapshot.runningOperations).map((operation) => ({
    operationKind: operation.operationKind,
    state: operation.state,
    projectionKey: operation.projectionKey,
    attemptCount: operation.attemptCount ?? null,
    requestedAt: operation.requestedAt,
    startedAt: operation.startedAt,
    updatedAt: operation.updatedAt,
  }));
  const staleWorkerCount = snapshot.workers.filter(
    (worker) => worker.state === "stale" || worker.state === "expired" || worker.workerState === "stale",
  ).length;

  const attentionItems = [];
  if (degradedGroups.length > 0) {
    attentionItems.push({ id: "degraded-groups", severity: "danger", count: degradedGroups.length });
  }
  if (blockedStreamCount > 0) {
    attentionItems.push({ id: "blocked-streams", severity: "warning", count: blockedStreamCount });
  }
  if (poisonEventCount > 0) {
    attentionItems.push({ id: "poison-events", severity: "warning", count: poisonEventCount });
  }
  if (failedOperationCount > 0) {
    attentionItems.push({ id: "failed-operations", severity: "danger", count: failedOperationCount });
  }
  if (staleWorkerCount > 0) {
    attentionItems.push({ id: "stale-workers", severity: "warning", count: staleWorkerCount });
  }
  if (staleGroups.length > 0) {
    attentionItems.push({ id: "stale-revisions", severity: "warning", count: staleGroups.length });
  }

  return {
    status: attentionItems.some((item) => item.severity === "danger") ? "attention-needed" : "ok",
    summary: snapshot.summary,
    attentionItems,
    degradedGroups: degradedGroups.map((group) => ({
      projectionKey: group.projectionKey,
      state: group.state,
      outstandingEventCount: group.outstandingEventCount,
      blockedStreamCount: group.blockedStreamCount,
      poisonEventCount: group.poisonEventCount,
      lastErrorClass: group.lastErrorClass,
      poisonEventErrorClasses: group.poisonEventErrorClasses,
    })),
    blockedProjectionKeys: snapshot.blockedProjections
      .filter((projection) => projection.blockedStreamCount > 0)
      .map((projection) => projection.projectionKey),
    failedOperationCount,
    // Executor-jam forensics: the terminal failure classes across the
    // whole failed-operation history and every operation currently claimed,
    // so a stuck executor is visible from the artifact alone.
    failedOperationTotal: snapshot.operationSummary?.failedCount ?? null,
    failedOperationErrorClasses,
    runningOperations,
    supportSafe: true,
  };
}

export function redactSupportUnsafeText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SENSITIVE_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

async function retryBlockedStreamsForTargets(targets, beforeSnapshot, auth) {
  const commands = [];
  for (const projectionKey of targets) {
    let resolution = resolveRetryBlockedStreamsForTarget(projectionKey, beforeSnapshot);
    let detailErrors = [];
    if (resolution.streams.length === 0 && retryTargetHasBlockedAttention(projectionKey, beforeSnapshot)) {
      const hydrated = await hydrateRetryTargetBlockedDetails(projectionKey, beforeSnapshot, auth);
      detailErrors = hydrated.errors;
      resolution = resolveRetryBlockedStreamsForTarget(projectionKey, hydrated.snapshot);
    }
    const streams = resolution.streams;
    const command = {
      operationKind: "retry-blocked",
      target: projectionKey,
      status: streams.length > 0 ? "running" : detailErrors.length > 0 ? "error" : "skipped",
      streamCount: streams.length,
      streamIdFingerprints: streams.map((stream) => fingerprint(stream?.streamId ?? "")),
      sourceProjectionKeys: resolution.sourceProjectionKeys,
      responses: [],
    };
    if (detailErrors.length > 0) {
      command.errors = detailErrors;
    }
    if (streams.length === 0) {
      command.reason =
        detailErrors.length > 0 ? "blocked-stream-detail-failed" : "no-blocked-streams-in-before-snapshot";
      commands.push(command);
      continue;
    }

    for (const stream of streams) {
      const streamId = String(stream?.streamId ?? "");
      const streamProjectionKey = String(stream?.projectionKey ?? projectionKey);
      if (!streamId) {
        command.responses.push({ status: "skipped", reason: "missing-stream-id" });
        continue;
      }
      try {
        const response = await postProjectionOperation(
          auth,
          [streamProjectionKey, "blocked-streams", streamId, "retry"],
          {},
        );
        command.responses.push({
          status: "requested",
          streamIdFingerprint: fingerprint(streamId),
          response: sanitizeCommandResponse(response),
        });
      } catch (error) {
        command.responses.push({
          status: "error",
          streamIdFingerprint: fingerprint(streamId),
          error: summarizeSafeError(error),
        });
      }
    }
    const requestedCount = command.responses.filter((response) => response.status === "requested").length;
    command.status =
      requestedCount === command.responses.length && detailErrors.length === 0
        ? "requested"
        : requestedCount > 0
          ? "partial"
          : "error";
    commands.push(command);
  }
  return commands;
}

async function rebuildProjectionGroups(targets, auth) {
  const commands = [];
  for (const target of targets) {
    const parsed = parseRebuildTarget(target);
    const response = await postProjectionOperation(
      auth,
      ["groups", parsed.contextName, parsed.projectionName, "rebuild"],
      { confirm: "rebuild" },
    );
    commands.push({
      operationKind: "rebuild",
      target: parsed.displayTarget,
      contextName: parsed.contextName,
      projectionName: parsed.projectionName,
      status: "requested",
      response: sanitizeCommandResponse(response),
    });
  }
  return commands;
}

async function signInWithPassword(params, fetchImpl) {
  const result = await requestJson(
    new URL("/api/auth/password-sign-in", ensureTrailingSlash(params.adminBaseUrl)),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: params.email, password: params.password }),
    },
    fetchImpl,
  );
  if (result.response.status !== 200) {
    throw new Error(`Admin sign-in failed with HTTP ${result.response.status}.`);
  }
  const sessionToken = normalizeString(result.body?.sessionToken);
  if (!sessionToken) {
    throw new Error("Admin sign-in did not return a session token.");
  }
  return sessionToken;
}

async function fetchProjectionOperationsSnapshot(auth) {
  const result = await requestJson(
    new URL("/api/platform/projections", ensureTrailingSlash(auth.adminBaseUrl)),
    { headers: { Authorization: `Bearer ${auth.sessionToken}` } },
    auth.fetchImpl,
  );
  if (result.response.status !== 200) {
    throw new Error(`Projection operations snapshot failed with HTTP ${result.response.status}.`);
  }
  return result.body;
}

// Best-effort executor-jam forensics: the snapshot's `operations`
// list only carries the 25 newest operations, which hides the failed backlog
// and the currently claimed operation whenever fresh retries flood the queue.
// Fetch the failed history and running set explicitly; the snapshot stays
// usable when this endpoint is unavailable.
async function fetchProjectionOperationHistory(auth) {
  const history = { failedOperations: [], runningOperations: [] };
  const queries = [
    ["failed", 200, "failedOperations"],
    ["running", 50, "runningOperations"],
  ];
  for (const [state, limit, key] of queries) {
    try {
      const url = buildProjectionOperationUrl(auth.adminBaseUrl, ["operations"]);
      url.searchParams.set("state", state);
      url.searchParams.set("limit", String(limit));
      const result = await requestJson(
        url,
        { headers: { Authorization: `Bearer ${auth.sessionToken}` } },
        auth.fetchImpl,
      );
      if (result.response.status === 200 && isRecord(result.body)) {
        history[key] = readArray(result.body.operations);
      }
    } catch {
      // Operation history is supplementary evidence; never fail the run for it.
    }
  }
  return history;
}

async function hydrateProjectionOperationsBlockedDetails(snapshot, auth, extraProjectionKeys = [], options = {}) {
  const projectionKeys = resolveProjectionKeysWithBlockedAttention(snapshot, extraProjectionKeys);
  if (projectionKeys.length === 0) {
    return snapshot;
  }

  const details = [];
  for (const projectionKey of projectionKeys) {
    try {
      details.push(await fetchProjectionBlockedStreamDetails(auth, projectionKey));
    } catch (error) {
      if (!options.onDetailError) {
        throw error;
      }
      options.onDetailError(projectionKey, error);
    }
  }
  return mergeBlockedProjectionDetails(snapshot, details);
}

async function fetchProjectionBlockedStreamDetails(auth, projectionKey) {
  const url = buildProjectionOperationUrl(auth.adminBaseUrl, [projectionKey, "blocked-streams"]);
  url.searchParams.set("limit", "500");
  const result = await requestJson(url, { headers: { Authorization: `Bearer ${auth.sessionToken}` } }, auth.fetchImpl);
  if (result.response.status !== 200) {
    throw new Error(`Projection blocked streams ${projectionKey} failed with HTTP ${result.response.status}.`);
  }
  return { projectionKey, ...(isRecord(result.body) ? result.body : {}) };
}

async function postProjectionOperation(auth, segments, body) {
  const url = buildProjectionOperationUrl(auth.adminBaseUrl, segments);
  const result = await requestJson(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    auth.fetchImpl,
  );
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new Error(`Projection operation ${segments.join("/")} failed with HTTP ${result.response.status}.`);
  }
  return result.body;
}

function buildProjectionOperationUrl(adminBaseUrl, segments) {
  const url = new URL("/api/platform/projections", ensureTrailingSlash(adminBaseUrl));
  for (const segment of segments) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(segment)}`;
  }
  return url;
}

async function requestJson(url, init, fetchImpl) {
  const response = await fetchImpl(url.toString(), init);
  const contentType = response.headers?.get?.("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await safeTextBody(response);
  return { response, body };
}

async function safeTextBody(response) {
  try {
    return { text: redactSupportUnsafeText(await response.text()) };
  } catch {
    return null;
  }
}

function createBaseRecord(options) {
  return {
    schemaVersion: STAGING_PROJECTION_OPERATIONS_VERSION,
    checkedAt: options.checkedAt,
    environment: options.environment,
    mode: options.mode,
    operatorReference: options.operatorReference,
    targetCount: options.targets.length,
    targets: options.targets,
    workflowRunId: options.workflowRunId ?? null,
    workflowRunAttempt: options.workflowRunAttempt ?? null,
    commitSha: options.commitSha ?? null,
    supportSafe: true,
    redaction: supportSafeRedaction(),
    beforeSnapshot: null,
    afterSnapshot: null,
    commands: [],
    report: null,
    errors: [],
    result: "unknown",
  };
}

function summarizeSnapshotArtifact(fileName, snapshot) {
  return {
    artifact: fileName,
    status: snapshot.summary.status,
    totalGroups: snapshot.summary.totalGroups,
    degradedOrErrorGroups: snapshot.projectionGroups.filter(
      (group) => group.state === "degraded" || group.state === "error",
    ).length,
    blockedStreamCount: snapshot.blockedProjections.reduce((sum, projection) => sum + projection.blockedStreamCount, 0),
    poisonEventCount: snapshot.projectionGroups.reduce((sum, group) => sum + group.poisonEventCount, 0),
    failedOperationCount: snapshot.operations.filter((operation) => operation.state === "failed").length,
    supportSafe: true,
  };
}

function finalizeRecord(record, finishedAt) {
  record.completedAt = finishedAt;
  const failedCommands = record.commands.filter(
    (command) =>
      command.status !== "requested" && !(command.operationKind === "retry-blocked" && command.status === "skipped"),
  );
  if (record.errors.length === 0 && failedCommands.length === 0) {
    record.result = "success";
    return;
  }

  const completedCommands = record.commands.filter(
    (command) =>
      command.status === "requested" ||
      command.status === "partial" ||
      (command.operationKind === "retry-blocked" && command.status === "skipped"),
  );
  record.result = completedCommands.length > 0 ? "completed-with-errors" : "failure";
}

async function writeReport(options, record) {
  await writeJsonRecord(join(options.outDir, "staging-projection-operations.json"), record);
}

function sanitizeSummary(summary) {
  const value = isRecord(summary) ? summary : {};
  return {
    status: value.status === "degraded" ? "degraded" : "ok",
    totalGroups: readNumber(value.totalGroups),
    caughtUpGroups: readNumber(value.caughtUpGroups),
    behindGroups: readNumber(value.behindGroups),
    staleGroups: readNumber(value.staleGroups),
    runningGroups: readNumber(value.runningGroups),
    errorGroups: readNumber(value.errorGroups),
    outstandingEventCount: readCountString(value.outstandingEventCount),
  };
}

function sanitizeProjectionGroup(group) {
  const value = isRecord(group) ? group : {};
  const targetContextName = readSafeName(value.targetContextName);
  const projectionName = readSafeProjectionName(value.projectionName);
  return {
    projectionKey: targetContextName && projectionName ? `${targetContextName}.${projectionName}` : projectionName,
    targetContextName,
    projectionName,
    state: readSafeEnum(value.state, "idle"),
    initialized: value.initialized === true,
    caughtUp: value.caughtUp === true,
    revisionStale: value.revisionStale === true,
    projectionRevision: readNumber(value.projectionRevision),
    storedProjectionRevision:
      value.storedProjectionRevision === null ? null : readNumber(value.storedProjectionRevision),
    sourceContextNames: readArray(value.sourceContextNames).map(readSafeName).filter(Boolean),
    requiredDuringBootstrap: value.requiredDuringBootstrap === true,
    outstandingEventCount: readCountString(value.outstandingEventCount),
    sourceLagEventCount:
      value.sourceLagEventCount === undefined ? undefined : readCountString(value.sourceLagEventCount),
    applicableLagEstimate:
      value.applicableLagEstimate === null || value.applicableLagEstimate === undefined
        ? null
        : readCountString(value.applicableLagEstimate),
    blockedStreamCount: readNumber(value.blockedStreamCount),
    poisonEventCount: readNumber(value.poisonEventCount),
    poisonEventErrorClasses: [],
    updatedAt: readSafeTimestamp(value.updatedAt),
    lastErrorClass: classifyError(value.lastError),
    subscriptions: readArray(value.subscriptions).map(sanitizeSubscription).sort(compareSubscription),
  };
}

function sanitizeSubscription(subscription) {
  const value = isRecord(subscription) ? subscription : {};
  return {
    checkpointKey: readSafeCheckpointKey(value.checkpointKey),
    subscriptionName: readSafeProjectionName(value.subscriptionName),
    projectionName: readSafeProjectionName(value.projectionName),
    sourceContextName: readSafeName(value.sourceContextName),
    targetContextName: readSafeName(value.targetContextName),
    subscriptionVersion: readNumber(value.subscriptionVersion),
    lastGlobalPosition: readCountString(value.lastGlobalPosition),
    sourceHeadGlobalPosition: readCountString(value.sourceHeadGlobalPosition),
    outstandingEventCount: readCountString(value.outstandingEventCount),
    sourceLagEventCount:
      value.sourceLagEventCount === undefined ? undefined : readCountString(value.sourceLagEventCount),
    applicableLagEstimate:
      value.applicableLagEstimate === null || value.applicableLagEstimate === undefined
        ? null
        : readCountString(value.applicableLagEstimate),
    state: readSafeEnum(value.state, "idle"),
    blockedStreamCount: readNumber(value.blockedStreamCount),
    poisonEventCount: readNumber(value.poisonEventCount),
    lastErrorClass: classifyError(value.lastError),
  };
}

function sanitizeBlockedProjection(projection) {
  const value = isRecord(projection) ? projection : {};
  const blockedStreams = readArray(value.blockedStreams).map(sanitizeBlockedStream).sort(compareBlockedStream);
  const poisonEvents = readArray(value.poisonEvents).map(sanitizePoisonEvent).sort(comparePoisonEvent);
  return {
    projectionKey: readSafeProjectionKey(value.projectionKey),
    blockedStreamCount: Math.max(readNumber(value.blockedStreamCount), blockedStreams.length),
    poisonEventCount: Math.max(readNumber(value.poisonEventCount), poisonEvents.length),
    blockedStreams,
    poisonEvents,
    poisonEventErrorClasses: uniqueStrings(poisonEvents.map((event) => event.errorClass).filter(Boolean)).sort(),
  };
}

function sanitizeBlockedStream(stream) {
  const value = isRecord(stream) ? stream : {};
  return {
    projectionKey: readSafeProjectionKey(value.projectionKey),
    streamIdFingerprint: fingerprint(value.streamId),
    firstBlockedGlobalPosition: readCountString(value.firstBlockedGlobalPosition),
    firstBlockedStreamVersion: readNumber(value.firstBlockedStreamVersion),
    lastSeenGlobalPosition: readCountString(value.lastSeenGlobalPosition),
    deferredEventCount: readNumber(value.deferredEventCount),
    state: readSafeEnum(value.state, "unknown"),
  };
}

function sanitizePoisonEvent(event) {
  const value = isRecord(event) ? event : {};
  return {
    eventIdFingerprint: fingerprint(value.eventId),
    eventType: readSafeEventType(value.eventType),
    streamIdFingerprint: fingerprint(value.streamId),
    streamVersion: readNumber(value.streamVersion),
    globalPosition: readCountString(value.globalPosition),
    retryCount: readNumber(value.retryCount),
    firstSeenAt: readSafeTimestamp(value.firstSeenAt),
    lastSeenAt: readSafeTimestamp(value.lastSeenAt),
    state: readSafeEnum(value.state, "unknown"),
    errorClass: classifyError(readPoisonError(value)),
  };
}

function sanitizeOperation(operation) {
  const value = isRecord(operation) ? operation : {};
  return {
    operationIdFingerprint: fingerprint(value.operationId),
    operationKind: readSafeEnum(value.operationKind, "unknown"),
    state: readSafeEnum(value.state, "unknown"),
    contextName: readSafeName(value.contextName),
    projectionName: value.projectionName == null ? null : readSafeProjectionName(value.projectionName),
    projectionKey: value.projectionKey == null ? null : readSafeProjectionKey(value.projectionKey),
    streamIdFingerprint: value.streamId == null ? null : fingerprint(value.streamId),
    requestedByUserIdFingerprint: value.requestedByUserId == null ? null : fingerprint(value.requestedByUserId),
    claimOwnerIdFingerprint: value.claimOwnerId == null ? null : fingerprint(value.claimOwnerId),
    // Claim expiry is the single field that separates a reclaimable expired
    // claim from an unreapable NULL-claim ghost; keep it in the
    // support-safe snapshot so stuck `running` rows are diagnosable from
    // artifacts alone.
    claimedUntil: value.claimedUntil == null ? null : readSafeTimestamp(value.claimedUntil),
    attemptCount: value.attemptCount == null ? null : readNumber(value.attemptCount),
    nextEligibleAt: value.nextEligibleAt == null ? null : readSafeTimestamp(value.nextEligibleAt),
    requestedAt: readSafeTimestamp(value.requestedAt),
    startedAt: value.startedAt == null ? null : readSafeTimestamp(value.startedAt),
    updatedAt: readSafeTimestamp(value.updatedAt),
    completedAt: value.completedAt == null ? null : readSafeTimestamp(value.completedAt),
    errorClass: classifyError(value.error),
  };
}

function sanitizeRuntimeRecord(record) {
  const value = isRecord(record) ? record : {};
  const safe = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = String(key);
    const lowerKey = normalizedKey.toLowerCase();
    if (lowerKey.includes("token") || lowerKey.includes("secret") || lowerKey.includes("password")) {
      continue;
    }
    if (lowerKey.includes("pod") || lowerKey.endsWith("id") || lowerKey.includes("owner") || lowerKey.includes("uid")) {
      safe[`${normalizedKey}Fingerprint`] = fingerprint(rawValue);
      continue;
    }
    if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      safe[normalizedKey] = rawValue;
      continue;
    }
    if (typeof rawValue === "string") {
      const valueText = redactSupportUnsafeText(rawValue);
      if (valueText !== rawValue) {
        continue;
      }
      if (isSafeRuntimeString(valueText)) {
        safe[toCamelRuntimeKey(normalizedKey)] = valueText;
      }
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function sanitizeOperationSummary(summary) {
  if (!isRecord(summary)) {
    return null;
  }
  return {
    queuedCount: readCountString(summary.queuedCount),
    runningCount: readCountString(summary.runningCount),
    failedCount: readCountString(summary.failedCount),
    cancelRequestedCount: readCountString(summary.cancelRequestedCount),
    oldestQueuedAt: summary.oldestQueuedAt == null ? null : readSafeTimestamp(summary.oldestQueuedAt),
    oldestRunningAt: summary.oldestRunningAt == null ? null : readSafeTimestamp(summary.oldestRunningAt),
    averageDurationMs: summary.averageDurationMs == null ? null : readCountString(summary.averageDurationMs),
  };
}

function sanitizeCommandResponse(response) {
  const value = isRecord(response) ? response : {};
  if (isRecord(value.operation)) {
    return { operation: sanitizeOperation(value.operation) };
  }
  if (isRecord(value.result)) {
    return { result: sanitizePrimitiveRecord(value.result) };
  }
  if (isRecord(value.summary)) {
    return { snapshot: summarizeSnapshotArtifact("command-response", sanitizeProjectionOperationsSnapshot(value)) };
  }
  return sanitizePrimitiveRecord(value);
}

function sanitizePrimitiveRecord(value) {
  return Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).flatMap(([key, rawValue]) => {
      if (typeof rawValue === "boolean" || typeof rawValue === "number") {
        return [[key, rawValue]];
      }
      if (typeof rawValue === "string" && !hasUnsafeText(rawValue) && rawValue.length <= 120) {
        return [[key, rawValue]];
      }
      return [];
    }),
  );
}

function classifyError(error) {
  if (error === null || error === undefined || error === "") {
    return null;
  }
  const text = redactSupportUnsafeText(stripSupportUnsafeIdentifiers(readFirstErrorLine(error)));
  if (text.includes("projection-group-lease-busy")) {
    return "projection-group-lease-busy";
  }
  if (text.includes("timeout")) {
    return "timeout";
  }
  if (text.includes("version") || text.includes("revision")) {
    return "revision-or-version";
  }
  if (text.includes("[redacted]")) {
    return "redacted-error";
  }
  return text.slice(0, 120) || "error";
}

function reconcileProjectionGroupCounters(groups, blockedProjections) {
  const blockedByProjectionKey = new Map(
    blockedProjections.map((projection) => [projection.projectionKey, projection]),
  );

  return groups.map((group) => {
    const subscriptionKeys = group.subscriptions.map((subscription) => subscription.checkpointKey).filter(Boolean);
    const projectionKeys = uniqueStrings([group.projectionKey, ...subscriptionKeys].filter(Boolean));
    const groupBlockedStreamCount = Math.max(
      group.blockedStreamCount,
      sumProjectionCounts(projectionKeys, blockedByProjectionKey, "blockedStreamCount"),
    );
    const groupPoisonEventCount = Math.max(
      group.poisonEventCount,
      sumProjectionCounts(projectionKeys, blockedByProjectionKey, "poisonEventCount"),
    );
    const poisonEventErrorClasses = uniqueStrings(
      projectionKeys.flatMap(
        (projectionKey) => blockedByProjectionKey.get(projectionKey)?.poisonEventErrorClasses ?? [],
      ),
    ).sort();

    return {
      ...group,
      blockedStreamCount: groupBlockedStreamCount,
      poisonEventCount: groupPoisonEventCount,
      poisonEventErrorClasses,
      subscriptions: group.subscriptions.map((subscription) => {
        const blockedProjection = blockedByProjectionKey.get(subscription.checkpointKey);
        if (!blockedProjection) {
          return subscription;
        }
        return {
          ...subscription,
          blockedStreamCount: Math.max(subscription.blockedStreamCount, blockedProjection.blockedStreamCount),
          poisonEventCount: Math.max(subscription.poisonEventCount, blockedProjection.poisonEventCount),
          poisonEventErrorClasses: blockedProjection.poisonEventErrorClasses,
        };
      }),
    };
  });
}

function sumProjectionCounts(projectionKeys, blockedByProjectionKey, countKey) {
  return projectionKeys.reduce(
    (sum, projectionKey) => sum + (blockedByProjectionKey.get(projectionKey)?.[countKey] ?? 0),
    0,
  );
}

function resolveProjectionKeysWithBlockedAttention(snapshot, extraProjectionKeys = []) {
  const keys = new Set(extraProjectionKeys.map(String).filter(Boolean));

  for (const projection of readArray(snapshot?.blockedProjections)) {
    const projectionKey = String(projection?.projectionKey ?? "");
    if (
      projectionKey &&
      (readNumber(projection?.blockedStreamCount) > 0 ||
        readNumber(projection?.poisonEventCount) > 0 ||
        readArray(projection?.blockedStreams).length > 0 ||
        readArray(projection?.poisonEvents).length > 0)
    ) {
      keys.add(projectionKey);
    }
  }

  for (const group of readArray(snapshot?.projectionGroups)) {
    const groupProjectionKey = readRawGroupProjectionKey(group);
    const subscriptionKeysWithAttention = [];
    for (const subscription of readArray(group?.subscriptions)) {
      const checkpointKey = String(subscription?.checkpointKey ?? "");
      if (
        checkpointKey &&
        (readNumber(subscription?.blockedStreamCount) > 0 || readNumber(subscription?.poisonEventCount) > 0)
      ) {
        subscriptionKeysWithAttention.push(checkpointKey);
      }
    }
    if (subscriptionKeysWithAttention.length > 0) {
      for (const checkpointKey of subscriptionKeysWithAttention) {
        keys.add(checkpointKey);
      }
    } else if (
      groupProjectionKey &&
      (readNumber(group?.blockedStreamCount) > 0 || readNumber(group?.poisonEventCount) > 0)
    ) {
      keys.add(groupProjectionKey);
    }
  }

  for (const target of extraProjectionKeys) {
    for (const group of readArray(snapshot?.projectionGroups)) {
      if (readRawGroupProjectionKey(group) !== target) {
        continue;
      }
      for (const subscription of readArray(group?.subscriptions)) {
        const checkpointKey = String(subscription?.checkpointKey ?? "");
        if (
          checkpointKey &&
          (readNumber(subscription?.blockedStreamCount) > 0 || readNumber(subscription?.poisonEventCount) > 0)
        ) {
          keys.add(checkpointKey);
        }
      }
    }
  }

  return [...keys].sort();
}

function mergeBlockedProjectionDetails(snapshot, details) {
  const blockedByProjectionKey = new Map(
    readArray(snapshot?.blockedProjections).flatMap((projection) => {
      const projectionKey = String(projection?.projectionKey ?? "");
      return projectionKey ? [[projectionKey, { ...projection }]] : [];
    }),
  );

  for (const detail of details) {
    const projectionKey = String(detail?.projectionKey ?? "");
    if (!projectionKey) {
      continue;
    }
    const existing = blockedByProjectionKey.get(projectionKey) ?? {};
    const blockedStreams = readArray(detail?.blockedStreams);
    const poisonEvents = readArray(detail?.poisonEvents);
    blockedByProjectionKey.set(projectionKey, {
      ...existing,
      ...detail,
      projectionKey,
      blockedStreamCount: Math.max(
        readNumber(existing.blockedStreamCount),
        readNumber(detail.blockedStreamCount),
        blockedStreams.length,
      ),
      poisonEventCount: Math.max(
        readNumber(existing.poisonEventCount),
        readNumber(detail.poisonEventCount),
        poisonEvents.length,
      ),
      blockedStreams,
      poisonEvents,
    });
  }

  return {
    ...snapshot,
    blockedProjections: [...blockedByProjectionKey.values()],
  };
}

function resolveRetryBlockedStreamsForTarget(target, snapshot) {
  const sourceProjectionKeys = resolveProjectionKeysForRetryTarget(target, snapshot);
  const blockedByProjectionKey = new Map(
    readArray(snapshot?.blockedProjections).flatMap((projection) => {
      const projectionKey = String(projection?.projectionKey ?? "");
      return projectionKey ? [[projectionKey, projection]] : [];
    }),
  );
  const seen = new Set();
  const streams = [];

  for (const sourceProjectionKey of sourceProjectionKeys) {
    for (const stream of readArray(blockedByProjectionKey.get(sourceProjectionKey)?.blockedStreams)) {
      const streamId = String(stream?.streamId ?? "");
      const streamProjectionKey = String(stream?.projectionKey ?? sourceProjectionKey);
      if (!streamId) {
        streams.push({ ...stream, projectionKey: streamProjectionKey });
        continue;
      }
      const dedupeKey = `${streamProjectionKey}\u0000${streamId}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      streams.push({ ...stream, projectionKey: streamProjectionKey });
    }
  }

  return { sourceProjectionKeys, streams };
}

async function hydrateRetryTargetBlockedDetails(target, snapshot, auth) {
  const details = [];
  const errors = [];
  for (const sourceProjectionKey of resolveProjectionKeysForRetryTarget(target, snapshot)) {
    try {
      details.push(await fetchProjectionBlockedStreamDetails(auth, sourceProjectionKey));
    } catch (error) {
      errors.push({
        projectionKey: sourceProjectionKey,
        error: summarizeSafeError(error),
      });
    }
  }

  return {
    snapshot: mergeBlockedProjectionDetails(snapshot, details),
    errors,
  };
}

function retryTargetHasBlockedAttention(target, snapshot) {
  for (const projectionKey of resolveProjectionKeysForRetryTarget(target, snapshot)) {
    const blockedProjection = readArray(snapshot?.blockedProjections).find(
      (projection) => String(projection?.projectionKey ?? "") === projectionKey,
    );
    if (
      blockedProjection &&
      (readNumber(blockedProjection.blockedStreamCount) > 0 ||
        readNumber(blockedProjection.poisonEventCount) > 0 ||
        readArray(blockedProjection.blockedStreams).length > 0 ||
        readArray(blockedProjection.poisonEvents).length > 0)
    ) {
      return true;
    }
  }

  for (const group of readArray(snapshot?.projectionGroups)) {
    if (readRawGroupProjectionKey(group) !== target) {
      continue;
    }
    if (readNumber(group?.blockedStreamCount) > 0 || readNumber(group?.poisonEventCount) > 0) {
      return true;
    }
    for (const subscription of readArray(group?.subscriptions)) {
      if (readNumber(subscription?.blockedStreamCount) > 0 || readNumber(subscription?.poisonEventCount) > 0) {
        return true;
      }
    }
  }

  return false;
}

function resolveProjectionKeysForRetryTarget(target, snapshot) {
  const keys = new Set([String(target)]);

  for (const group of readArray(snapshot?.projectionGroups)) {
    const groupProjectionKey = readRawGroupProjectionKey(group);
    if (groupProjectionKey !== target) {
      continue;
    }
    for (const subscription of readArray(group?.subscriptions)) {
      const checkpointKey = String(subscription?.checkpointKey ?? "");
      if (
        checkpointKey &&
        (readNumber(subscription?.blockedStreamCount) > 0 || readNumber(subscription?.poisonEventCount) > 0)
      ) {
        keys.add(checkpointKey);
      }
    }
  }

  return [...keys].sort();
}

function readRawGroupProjectionKey(group) {
  const targetContextName = String(group?.targetContextName ?? "");
  const projectionName = String(group?.projectionName ?? "");
  return targetContextName && projectionName ? `${targetContextName}.${projectionName}` : "";
}

function readPoisonError(value) {
  return value.errorMessage ?? value.error_message ?? value.errorStack ?? value.error_stack ?? null;
}

function readFirstErrorLine(error) {
  if (error instanceof Error) {
    return error.stack?.split(/\r?\n/, 1)[0] ?? error.message;
  }
  if (isRecord(error)) {
    const constructorName = typeof error.name === "string" ? error.name : "";
    const message = error.message ?? error.errorMessage ?? error.error_message ?? error.stack ?? error.error_stack;
    const firstLine = String(message ?? JSON.stringify(error)).split(/\r?\n/, 1)[0] ?? "";
    return constructorName && !firstLine.startsWith(`${constructorName}:`)
      ? `${constructorName}: ${firstLine}`
      : firstLine;
  }
  return String(error).split(/\r?\n/, 1)[0] ?? "";
}

function stripSupportUnsafeIdentifiers(value) {
  return String(value)
    .replace(
      /\b(?:stream|user|account|customer|session|order|payment|event|tenant|listing|cart|checkout|identity)[._:-][A-Za-z0-9._:-]+\b/gi,
      "[identifier]",
    )
    .replace(/\b[A-Za-z]+_[A-Za-z0-9._:-]{4,}\b/g, "[identifier]")
    .replace(/\b[A-Za-z0-9._:-]*[0-9][A-Za-z0-9._:-]{5,}\b/g, "[identifier]")
    .replace(/(["']).{33,}?\1/g, "[identifier]")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  return [...new Set(values.map(String).filter(Boolean))];
}

function supportSafeRedaction() {
  return {
    credentials: "never-recorded",
    sessionTokens: "never-recorded",
    streamIds: "fingerprinted",
    eventIds: "fingerprinted",
    operationIds: "fingerprinted",
    workerAndPodIds: "fingerprinted",
    poisonErrorClasses: "first-error-line-with-identifiers-stripped",
    customerOrProviderData: "not-recorded",
    rawSnapshot: "not-written",
  };
}

function readTargetCsv(value) {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function isProjectionKey(value) {
  return isProjectionName(value) && String(value).includes(".");
}

function isContextName(value) {
  return /^[a-z][a-z0-9-]*$/.test(String(value ?? ""));
}

function isProjectionName(value) {
  return /^[a-z][a-z0-9-]*(?:[.-][a-z0-9]+[a-z0-9-]*)*$/.test(String(value ?? ""));
}

function readSafeName(value) {
  const text = String(value ?? "");
  return isContextName(text) ? text : null;
}

function readSafeProjectionName(value) {
  const text = String(value ?? "");
  return isProjectionName(text) ? text : null;
}

function readSafeProjectionKey(value) {
  const text = String(value ?? "");
  return isProjectionKey(text) || /^[a-z][a-z0-9.-]*:[a-z][a-z0-9-]*:v[0-9]+$/.test(text) ? text : null;
}

function readSafeCheckpointKey(value) {
  const text = String(value ?? "");
  return /^[a-z][a-z0-9.-]*:[a-z][a-z0-9-]*:v[0-9]+$/.test(text) ? text : fingerprint(text);
}

function readSafeEventType(value) {
  const text = String(value ?? "");
  return /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/.test(text) ? text : "unknown";
}

function readSafeEnum(value, fallback) {
  const text = String(value ?? "");
  return /^[a-z][a-z0-9_-]{0,80}$/.test(text) ? text : fallback;
}

function readSafeTimestamp(value) {
  const text = String(value ?? "");
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readCountString(value) {
  const text = String(value ?? "0");
  return /^-?[0-9]+$/.test(text) ? text : "0";
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function fingerprint(value) {
  const text = String(value ?? "");
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null;
}

function hasUnsafeText(value) {
  return redactSupportUnsafeText(value) !== value;
}

function isSafeRuntimeString(value) {
  return /^[A-Za-z0-9._:/ -]{1,160}$/.test(value) && !hasUnsafeText(value);
}

function toCamelRuntimeKey(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function compareGroup(left, right) {
  return String(left.projectionKey ?? "").localeCompare(String(right.projectionKey ?? ""));
}

function compareSubscription(left, right) {
  return `${left.projectionName}:${left.sourceContextName}`.localeCompare(
    `${right.projectionName}:${right.sourceContextName}`,
  );
}

function compareBlockedStream(left, right) {
  return String(left.streamIdFingerprint ?? "").localeCompare(String(right.streamIdFingerprint ?? ""));
}

function comparePoisonEvent(left, right) {
  return String(left.eventIdFingerprint ?? "").localeCompare(String(right.eventIdFingerprint ?? ""));
}

function compareOperation(left, right) {
  return String(left.requestedAt ?? "").localeCompare(String(right.requestedAt ?? ""));
}

function compareRuntimeRecord(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function summarizeSafeError(error) {
  return redactSupportUnsafeText(error instanceof Error ? error.message : String(error));
}

async function main(argv, env = process.env) {
  const options = parseStagingProjectionOperationsArgs(argv, env);
  const { record, passesGate } = await runStagingProjectionOperations(options);
  console.log(JSON.stringify(record, null, 2));
  return passesGate ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
