// Closed contract for the trace-free market-following journey package. The
// reporter, packager and inspector share these constants; every value that
// leaves the runner is one of them or matches one of the bounded patterns here.

export const journeyPackageSchemaVersion = "journey-package/v1";
export const journeyPackageRecordSchemaVersion = "journey-package-record/v1";

// The only enrolled target. It is enrolled only on an attempt that attaches a
// v1 timeline under `timelineAttachmentName`.
export const journeyPackageTarget = Object.freeze({
  file: "deployables/marketplace/e2e/market-following-offers.spec.ts",
  project: "marketplace-chromium",
});

// A packaged test title is plain text from this bounded alphabet.
export const titlePattern = /^[A-Za-z0-9 ,.:;@()'/_+&-]{1,200}$/;

export const timelineAttachmentName = "market-following-command-timeline";
export const timelineContract = "market-following-command-timeline";
export const timelineVersion = 1;

// Paths relative to the repository (or fixture) root.
export const rawRoot = "artifacts/playwright/test-results";
export const recordDirectory = "journey-package-record";
export const packageRoot = "artifacts/journey-package";
export const stagingRoot = "artifacts/journey-package.staging";

const KiB = 1024;
const MiB = 1024 * KiB;
export const caps = Object.freeze({ capture: 12 * MiB, timeline: 256 * KiB, result: 64 * KiB, manifest: 64 * KiB });

const mobile = Object.freeze({ width: 390, height: 844 });
const desktop = Object.freeze({ width: 1440, height: 1000 });
const buyerRoute = "/account/offers/submitted";
const sellerConfirmationRoute = "/checkout/sell/session/:sessionId/confirmation";

export const checkpoints = Object.freeze({
  "journey-review-390": Object.freeze({ actor: "buyer", route: buyerRoute, viewport: mobile, phase: "review" }),
  "journey-review-1440": Object.freeze({ actor: "buyer", route: buyerRoute, viewport: desktop, phase: "review" }),
  "journey-active-390": Object.freeze({ actor: "buyer", route: buyerRoute, viewport: mobile, phase: "active" }),
  "journey-active-1440": Object.freeze({ actor: "buyer", route: buyerRoute, viewport: desktop, phase: "active" }),
  "journey-checkout-confirmation-1440": Object.freeze({
    actor: "seller",
    route: sellerConfirmationRoute,
    viewport: desktop,
    phase: "confirmation",
  }),
});
export const checkpointNames = Object.freeze(Object.keys(checkpoints));
export const aggregateCap = checkpointNames.length * caps.capture + caps.timeline + caps.result + caps.manifest;

export const automaticAttachmentNames = Object.freeze(["screenshot", "video", "trace", "error-context"]);

const buyerCommands = Object.freeze([
  "CreateBuyerOfferPolicy",
  "PreviewBuyerOfferPolicy",
  "AuthorizeBuyerOfferPolicy",
  "PauseBuyerOfferPolicy",
  "StopBuyerOfferPolicy",
]);
const sellerIntents = Object.freeze([
  "add-selected-offer",
  "review-sell-list-checkout",
  "select-optimization-goal",
  "refresh-checkout-preview",
  "confirm-checkout",
]);
const offerEventTypes = Object.freeze([
  "marketplace.offer.submitted",
  "marketplace.offer.buyer-policy-bound",
  "marketplace.offer.managed-evaluated",
  "marketplace.offer.price-updated",
  "marketplace.offer.accepted",
  "marketplace.offer.paused",
  "marketplace.offer.resumed",
  "marketplace.offer.withdrawn",
]);
const offerStatuses = Object.freeze(["draft", "submitted", "paused", "withdrawn", "accepted"]);
const convergenceOutcomes = Object.freeze(["converged", "not-converged"]);
const observations = Object.freeze([
  "estimate-seeded",
  "target-observed",
  "offer-accepted",
  "payout-readiness-recorded",
  "policy-paused",
  "policy-stopped",
]);
export const failureClassifications = Object.freeze(["assertion", "timeout", "setup", "teardown", "unknown"]);
export const maxConvergenceBudgetMs = 180_000;

// Playwright renders these locators verbatim on `Locator:` and `waiting for`
// lines; only the enum key ever leaves the runner.
export const knownLocators = Object.freeze({
  "follow-the-market-switch": "getByRole('switch', { name: 'Follow the market for selected Offers' })",
  "preview-selected-offers": "getByRole('button', { name: 'Preview selected Offers' })",
  "authorize-consent": "getByRole('checkbox', { name: /^I authorize/ })",
  "authorize-reviewed-offers": "getByRole('button', { name: 'Authorize reviewed Offers' })",
  "active-status": "getByText('Active', { exact: true })",
  "pause-market-following": "getByRole('button', { name: 'Pause market following' })",
  "stop-market-following": "getByRole('button', { name: 'Stop market following' })",
  "accept-offer-match": "getByRole('button', { name: 'Accept offer match', exact: true })",
});
export const knownLocatorNames = Object.freeze([...Object.keys(knownLocators), "unknown"]);

export const testStatuses = Object.freeze(["passed", "failed", "timedOut", "skipped", "interrupted"]);
export const testOutcomes = Object.freeze(["expected", "unexpected", "flaky", "skipped"]);
export const resultStates = Object.freeze([
  "passed",
  "skipped",
  "expected-failure",
  "retry-recovered",
  "failed",
  "timed-out",
  "interrupted",
  "not-executed",
]);
export const packageKinds = Object.freeze(["success", "diagnostics"]);
export const producerOutcomes = Object.freeze(["success", "failure"]);

const ulid = "[0-9A-HJKMNP-TV-Z]{26}";
const offerIdPattern = new RegExp(`^off_${ulid}$`);
const orderIdPattern = new RegExp(`^ord_${ulid}$`);
const eventIdPattern = new RegExp(`^evt_${ulid}$`);
const amountPattern = /^(?:0|[1-9][0-9]{0,8})\.[0-9]{2}$/;
const estimateVersionPattern = /^[1-9][0-9]{0,11}$/;
const repoPathSegment = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}";
const locationPattern = new RegExp(`^(?:${repoPathSegment}/){0,15}${repoPathSegment}:[1-9][0-9]{0,6}:[1-9][0-9]{0,5}$`);
const instantPattern =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$/;

export const refusalCodes = Object.freeze([
  "identity-invalid",
  "checkout-mismatch",
  "record-invalid",
  "record-stale",
  "target-conflict",
  "outcome-conflict",
  "timeline-conflict",
  "timeline-invalid",
  "timeline-version",
  "timeline-incomplete",
  "capture-conflict",
  "capture-invalid",
  "capture-provenance",
  "capture-incomplete",
  "over-cap",
  "containment",
  "inspect-mismatch",
]);

// A refusal carries a closed code, a structural path built only from contract
// keys and indexes, and numeric detail. It never echoes an input value.
export class JourneyPackageRefusal extends Error {
  constructor(code, { path = null, detail = null } = {}) {
    if (!refusalCodes.includes(code)) throw new Error("unknown journey package refusal code");
    super(path ? `${code} at ${path}` : code);
    this.name = "JourneyPackageRefusal";
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

export function refuse(code, options) {
  throw new JourneyPackageRefusal(code, options);
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireClosed(value, keys, code, path) {
  if (!isPlainObject(value)) refuse(code, { path });
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !actual.every((key) => keys.includes(key))) refuse(code, { path });
  return value;
}

function requireEnum(value, members, code, path) {
  if (typeof value !== "string" || !members.includes(value)) refuse(code, { path });
  return value;
}

function requireInteger(value, minimum, maximum, code, path) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) refuse(code, { path });
  return value;
}

function requirePattern(value, pattern, code, path) {
  if (typeof value !== "string" || !pattern.test(value)) refuse(code, { path });
  return value;
}

function nullable(value, check) {
  return value === null ? null : check(value);
}

export function isOffsetInstant(value) {
  if (typeof value !== "string") return false;
  const match = instantPattern.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offset] = match.map((part, index) =>
    index === 0 || index === 7 ? part : Number(part),
  );
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (offset !== "Z") {
    const [offsetHours, offsetMinutes] = offset.slice(1).split(":").map(Number);
    if (offsetHours > 23 || offsetMinutes > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function requireInstant(value, path) {
  if (!isOffsetInstant(value)) refuse("timeline-invalid", { path });
  return value;
}

export function isRepoLocation(value) {
  return typeof value === "string" && locationPattern.test(value) && !value.split("/").includes("..");
}

export function artifactName(kind, runId, runAttempt, jobIndex) {
  requireEnum(kind, packageKinds, "identity-invalid", "kind");
  const prefix = kind === "success" ? "journey-package" : "journey-package-diagnostics";
  return `${prefix}-${runId}-${runAttempt}-${jobIndex}`;
}

export function classifyAttachment(name) {
  if (name === timelineAttachmentName) return "timeline";
  if (checkpointNames.includes(name)) return "capture";
  if (automaticAttachmentNames.includes(name)) return "automatic";
  return "unlisted";
}

export function knownLocatorFor(message) {
  if (typeof message !== "string") return "unknown";
  const candidates = new Set();
  for (const line of message.slice(0, 64 * KiB).split(/\r?\n/)) {
    const trimmed = line.trim();
    const locator = trimmed.startsWith("Locator: ")
      ? trimmed.slice("Locator: ".length)
      : trimmed.startsWith("- waiting for ")
        ? trimmed.slice("- waiting for ".length)
        : null;
    if (locator === null) continue;
    candidates.add(locator.replace(/\.(?:first|last)\(\)$|\.nth\([0-9]{1,3}\)$/, ""));
  }
  const matches = Object.entries(knownLocators).filter(([, locator]) => candidates.has(locator));
  return matches.length === 1 ? matches[0][0] : "unknown";
}

function validateFailureFields(entry, code, path) {
  requireEnum(entry.classification, failureClassifications, code, `${path}.classification`);
  requireEnum(entry.knownLocator, knownLocatorNames, code, `${path}.knownLocator`);
  if (entry.location !== null && !isRepoLocation(entry.location)) refuse(code, { path: `${path}.location` });
}

const entryKeys = Object.freeze({
  command: ["kind", "at", "actor", "command", "httpStatus", "offerIds"],
  convergence: [
    "kind",
    "startedAt",
    "endedAt",
    "elapsedMs",
    "budgetMs",
    "pollCount",
    "baselineStreamVersion",
    "currentStreamVersion",
    "eventTypes",
    "priceUpdateVersion",
    "evaluationVersion",
    "offerId",
    "amount",
    "currency",
    "offerStatus",
    "outcome",
  ],
  observation: ["kind", "at", "observation", "offerId", "orderId", "eventId", "amount", "quantity", "estimateVersion"],
  capture: ["kind", "at", "checkpoint", "route", "actor", "viewport", "selectionCount"],
  failure: ["kind", "at", "classification", "knownLocator", "location"],
});

function validateEntry(entry, path) {
  if (!isPlainObject(entry)) refuse("timeline-invalid", { path });
  const kind = requireEnum(entry.kind, Object.keys(entryKeys), "timeline-invalid", `${path}.kind`);
  requireClosed(entry, entryKeys[kind], "timeline-invalid", path);
  const code = "timeline-invalid";
  if (kind === "command") {
    requireInstant(entry.at, `${path}.at`);
    requireEnum(entry.actor, ["buyer", "seller"], code, `${path}.actor`);
    requireEnum(entry.command, entry.actor === "buyer" ? buyerCommands : sellerIntents, code, `${path}.command`);
    requireInteger(entry.httpStatus, 100, 599, code, `${path}.httpStatus`);
    if (!Array.isArray(entry.offerIds) || entry.offerIds.length > 16) refuse(code, { path: `${path}.offerIds` });
    entry.offerIds.forEach((id, index) => requirePattern(id, offerIdPattern, code, `${path}.offerIds[${index}]`));
    if (new Set(entry.offerIds).size !== entry.offerIds.length) refuse(code, { path: `${path}.offerIds` });
    return { ...entry, offerIds: [...entry.offerIds] };
  }
  if (kind === "convergence") {
    requireInstant(entry.startedAt, `${path}.startedAt`);
    requireInstant(entry.endedAt, `${path}.endedAt`);
    const window = Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
    if (window < 0) refuse(code, { path: `${path}.endedAt` });
    requireInteger(entry.budgetMs, 1, maxConvergenceBudgetMs, code, `${path}.budgetMs`);
    requireInteger(entry.elapsedMs, 0, entry.budgetMs, code, `${path}.elapsedMs`);
    if (Math.abs(window - entry.elapsedMs) > 1_000) refuse(code, { path: `${path}.elapsedMs` });
    requireInteger(entry.pollCount, 0, 10_000, code, `${path}.pollCount`);
    requireInteger(entry.baselineStreamVersion, 0, 1_000_000, code, `${path}.baselineStreamVersion`);
    requireInteger(
      entry.currentStreamVersion,
      entry.baselineStreamVersion,
      1_000_000,
      code,
      `${path}.currentStreamVersion`,
    );
    if (!Array.isArray(entry.eventTypes) || entry.eventTypes.length > 64) refuse(code, { path: `${path}.eventTypes` });
    entry.eventTypes.forEach((type, index) => requireEnum(type, offerEventTypes, code, `${path}.eventTypes[${index}]`));
    nullable(entry.priceUpdateVersion, (value) =>
      requireInteger(value, 0, 1_000_000, code, `${path}.priceUpdateVersion`),
    );
    nullable(entry.evaluationVersion, (value) =>
      requireInteger(value, 0, 1_000_000, code, `${path}.evaluationVersion`),
    );
    requirePattern(entry.offerId, offerIdPattern, code, `${path}.offerId`);
    nullable(entry.amount, (value) => requirePattern(value, amountPattern, code, `${path}.amount`));
    nullable(entry.currency, (value) => requireEnum(value, ["USD"], code, `${path}.currency`));
    nullable(entry.offerStatus, (value) => requireEnum(value, offerStatuses, code, `${path}.offerStatus`));
    requireEnum(entry.outcome, convergenceOutcomes, code, `${path}.outcome`);
    if (
      entry.outcome === "converged" &&
      [entry.priceUpdateVersion, entry.evaluationVersion, entry.amount, entry.currency, entry.offerStatus].includes(
        null,
      )
    ) {
      refuse(code, { path: `${path}.outcome` });
    }
    return { ...entry, eventTypes: [...entry.eventTypes] };
  }
  if (kind === "observation") {
    requireInstant(entry.at, `${path}.at`);
    requireEnum(entry.observation, observations, code, `${path}.observation`);
    nullable(entry.offerId, (value) => requirePattern(value, offerIdPattern, code, `${path}.offerId`));
    nullable(entry.orderId, (value) => requirePattern(value, orderIdPattern, code, `${path}.orderId`));
    nullable(entry.eventId, (value) => requirePattern(value, eventIdPattern, code, `${path}.eventId`));
    nullable(entry.amount, (value) => requirePattern(value, amountPattern, code, `${path}.amount`));
    nullable(entry.quantity, (value) => requireInteger(value, 1, 10_000, code, `${path}.quantity`));
    nullable(entry.estimateVersion, (value) =>
      requirePattern(value, estimateVersionPattern, code, `${path}.estimateVersion`),
    );
    return { ...entry };
  }
  if (kind === "capture") {
    requireInstant(entry.at, `${path}.at`);
    const checkpoint = checkpoints[requireEnum(entry.checkpoint, checkpointNames, code, `${path}.checkpoint`)];
    if (entry.route !== checkpoint.route) refuse(code, { path: `${path}.route` });
    if (entry.actor !== checkpoint.actor) refuse(code, { path: `${path}.actor` });
    requireClosed(entry.viewport, ["width", "height"], code, `${path}.viewport`);
    if (entry.viewport.width !== checkpoint.viewport.width || entry.viewport.height !== checkpoint.viewport.height) {
      refuse(code, { path: `${path}.viewport` });
    }
    requireInteger(entry.selectionCount, 0, 100, code, `${path}.selectionCount`);
    return { ...entry, viewport: { width: entry.viewport.width, height: entry.viewport.height } };
  }
  requireInstant(entry.at, `${path}.at`);
  validateFailureFields(entry, code, path);
  return { ...entry };
}

function orderKey(entry) {
  return Date.parse(entry.kind === "convergence" ? entry.startedAt : entry.at);
}

// Rebuilds a v1 timeline from parsed values. Any unknown key, enum, pattern,
// bound, version or order refuses; nothing is truncated or dropped.
export function validateTimeline(value) {
  requireClosed(value, ["contract", "version", "entries"], "timeline-invalid", "timeline");
  if (value.contract !== timelineContract) refuse("timeline-invalid", { path: "timeline.contract" });
  if (value.version !== timelineVersion) refuse("timeline-version", { path: "timeline.version" });
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 512) {
    refuse("timeline-invalid", { path: "timeline.entries" });
  }
  const entries = value.entries.map((entry, index) => validateEntry(entry, `entries[${index}]`));
  entries.forEach((entry, index) => {
    if (index > 0 && orderKey(entry) < orderKey(entries[index - 1])) {
      refuse("timeline-invalid", { path: `entries[${index}]` });
    }
  });
  const seen = new Set();
  entries.forEach((entry, index) => {
    if (entry.kind !== "capture") return;
    if (seen.has(entry.checkpoint)) refuse("timeline-conflict", { path: `entries[${index}].checkpoint` });
    seen.add(entry.checkpoint);
  });
  return { contract: timelineContract, version: timelineVersion, entries };
}

const okStatus = (entry) => entry.httpStatus >= 200 && entry.httpStatus <= 399;
const findIndex = (entries, from, predicate) => {
  for (let index = from; index < entries.length; index += 1) if (predicate(entries[index])) return index;
  return -1;
};

// A success timeline proves the journey in order: Preview, both review captures
// before consent, Authorize, a converged Offer, both active captures after it,
// the seller confirm-checkout command and its confirmation capture, no failure.
export function timelineCompleteness(timeline) {
  const entries = timeline.entries;
  const missing = [];
  if (entries.some((entry) => entry.kind === "failure")) missing.push("failure-entry");
  const isCommand = (actor, command) => (entry) =>
    entry.kind === "command" && entry.actor === actor && entry.command === command && okStatus(entry);
  const captureAt = (name) => entries.findIndex((entry) => entry.kind === "capture" && entry.checkpoint === name);
  const preview = findIndex(entries, 0, isCommand("buyer", "PreviewBuyerOfferPolicy"));
  const authorize = findIndex(entries, preview + 1, isCommand("buyer", "AuthorizeBuyerOfferPolicy"));
  if (preview < 0) missing.push("preview-command");
  if (authorize < 0) missing.push("authorize-command");
  for (const name of ["journey-review-390", "journey-review-1440"]) {
    const index = captureAt(name);
    if (index < 0 || index < preview || authorize < 0 || index > authorize) missing.push(name);
  }
  const convergence = findIndex(
    entries,
    authorize < 0 ? entries.length : authorize + 1,
    (entry) => entry.kind === "convergence" && entry.outcome === "converged",
  );
  if (convergence < 0) missing.push("converged-offer");
  for (const name of ["journey-active-390", "journey-active-1440"]) {
    const index = captureAt(name);
    if (
      index < 0 ||
      convergence < 0 ||
      index < convergence ||
      Date.parse(entries[index].at) < Date.parse(entries[convergence].endedAt)
    ) {
      missing.push(name);
    }
  }
  const confirm = findIndex(
    entries,
    convergence < 0 ? entries.length : convergence + 1,
    isCommand("seller", "confirm-checkout"),
  );
  if (confirm < 0) missing.push("confirm-checkout-command");
  const confirmation = captureAt("journey-checkout-confirmation-1440");
  if (confirmation < 0 || confirm < 0 || confirmation < confirm) missing.push("journey-checkout-confirmation-1440");
  return { complete: missing.length === 0, missing };
}

export function captureEntryFor(timeline, checkpoint) {
  return timeline.entries.find((entry) => entry.kind === "capture" && entry.checkpoint === checkpoint) ?? null;
}

const resultKeys = Object.freeze([
  "state",
  "expectedStatus",
  "status",
  "outcome",
  "retry",
  "durationMs",
  "classification",
  "knownLocator",
  "location",
]);

export function validateResult(value, code = "record-invalid") {
  requireClosed(value, resultKeys, code, "result");
  requireEnum(value.state, resultStates, code, "result.state");
  requireEnum(value.expectedStatus, testStatuses, code, "result.expectedStatus");
  nullable(value.status, (status) => requireEnum(status, testStatuses, code, "result.status"));
  nullable(value.outcome, (outcome) => requireEnum(outcome, testOutcomes, code, "result.outcome"));
  requireInteger(value.retry, 0, 0, code, "result.retry");
  nullable(value.durationMs, (duration) => requireInteger(duration, 0, 86_400_000, code, "result.durationMs"));
  if (value.classification === null) {
    if (value.knownLocator !== null || value.location !== null) refuse(code, { path: "result.classification" });
  } else {
    validateFailureFields(value, code, "result");
  }
  const executed = value.state !== "not-executed";
  if (executed !== (value.status !== null && value.outcome !== null && value.durationMs !== null)) {
    refuse(code, { path: "result.state" });
  }
  return { ...value };
}
