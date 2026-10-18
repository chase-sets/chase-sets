export const OUTCOME_METADATA_VERSION = 1;

const OUTCOME_MARKER_START = /<!--\s*outcome\s*:/gi;
const OUTCOME_MARKER = /<!--\s*outcome\s*:\s*([\s\S]*?)\s*-->/gi;
const OUTCOME_KEYS = ["order", "status", "track", "version"];
const TRACK = /^[a-z][a-z0-9-]*$/;
const STEERING_MARKER_START = /<!--\s*steering\s*:/gi;
const STEERING_MARKER = /<!--\s*steering\s*:\s*([\s\S]*?)\s*-->/gi;
const STEERING_KEYS = ["source", "until", "version"];
const STEERING_SOURCE = /^https:\/\/github\.com\/chase-sets\/chase-sets\/issues\/\d+#issuecomment-\d+$/;

export class MilestonePolicyError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "MilestonePolicyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, milestone) {
  throw new MilestonePolicyError(code, {
    id: milestone?.id ?? null,
    number: milestone?.number ?? null,
    title: milestone?.title ?? null,
  });
}

function stableIdentity(milestone) {
  if (typeof milestone?.id === "string" && milestone.id.length > 0) return `id:${milestone.id}`;
  if (Number.isSafeInteger(milestone?.number) && milestone.number > 0) return `number:${milestone.number}`;
  fail("OUTCOME_MILESTONE_IDENTITY_INVALID", milestone);
}

/**
 * Reads the sole outcome-ordering authority from a milestone description.
 */
export function readOutcomePolicy(milestone) {
  const description = milestone?.description;
  if (description !== null && description !== undefined && typeof description !== "string") {
    fail("OUTCOME_DESCRIPTION_INVALID", milestone);
  }
  const text = description ?? "";
  const starts = [...text.matchAll(OUTCOME_MARKER_START)];
  if (starts.length === 0) return null;
  if (starts.length > 1) fail("OUTCOME_METADATA_DUPLICATE", milestone);

  const matches = [...text.matchAll(OUTCOME_MARKER)];
  if (matches.length !== 1) fail("OUTCOME_METADATA_MALFORMED", milestone);
  let metadata;
  try {
    metadata = JSON.parse(matches[0][1]);
  } catch {
    fail("OUTCOME_METADATA_MALFORMED", milestone);
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join("\0") !== OUTCOME_KEYS.join("\0") ||
    metadata.version !== OUTCOME_METADATA_VERSION ||
    !TRACK.test(metadata.track ?? "") ||
    !Number.isSafeInteger(metadata.order) ||
    metadata.order < 0 ||
    !["committed", "candidate"].includes(metadata.status)
  ) {
    fail("OUTCOME_METADATA_INVALID", milestone);
  }
  return Object.freeze({
    version: metadata.version,
    track: metadata.track,
    order: metadata.order,
    status: metadata.status,
    source: "description",
  });
}

/**
 * Reads Todd's current steering override from a milestone description.
 */
export function readSteeringPolicy(milestone) {
  const description = milestone?.description;
  if (description !== null && description !== undefined && typeof description !== "string") {
    fail("STEERING_DESCRIPTION_INVALID", milestone);
  }
  const text = description ?? "";
  const starts = [...text.matchAll(STEERING_MARKER_START)];
  if (starts.length === 0) return null;
  if (starts.length > 1) fail("STEERING_METADATA_DUPLICATE", milestone);

  const matches = [...text.matchAll(STEERING_MARKER)];
  if (matches.length !== 1) fail("STEERING_METADATA_MALFORMED", milestone);
  let metadata;
  try {
    metadata = JSON.parse(matches[0][1]);
  } catch {
    fail("STEERING_METADATA_MALFORMED", milestone);
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join("\0") !== STEERING_KEYS.join("\0") ||
    metadata.version !== 1 ||
    !STEERING_SOURCE.test(metadata.source ?? "") ||
    typeof metadata.until !== "string" ||
    metadata.until.length === 0 ||
    metadata.until.length > 500
  ) {
    fail("STEERING_METADATA_INVALID", milestone);
  }
  return Object.freeze({ version: metadata.version, source: metadata.source, until: metadata.until });
}

export function compareOutcomeMilestones(left, right) {
  const leftPolicy = readOutcomePolicy(left);
  const rightPolicy = readOutcomePolicy(right);
  if (leftPolicy === null || rightPolicy === null) {
    if (leftPolicy === rightPolicy) return stableIdentity(left).localeCompare(stableIdentity(right));
    return leftPolicy === null ? 1 : -1;
  }
  return (
    leftPolicy.track.localeCompare(rightPolicy.track) ||
    leftPolicy.order - rightPolicy.order ||
    stableIdentity(left).localeCompare(stableIdentity(right))
  );
}

function milestoneNumber(milestone) {
  if (Number.isSafeInteger(milestone?.number) && milestone.number > 0) return milestone.number;
  fail("OUTCOME_MILESTONE_IDENTITY_INVALID", milestone);
}

/**
 * Ranks outcomes by `order` alone across tracks, then by milestone number.
 * Track names never decide; outcomes without metadata sort last.
 */
export function compareOutcomeOrder(left, right) {
  const leftPolicy = readOutcomePolicy(left);
  const rightPolicy = readOutcomePolicy(right);
  if (leftPolicy === null || rightPolicy === null) {
    if (leftPolicy !== rightPolicy) return leftPolicy === null ? 1 : -1;
  } else if (leftPolicy.order !== rightPolicy.order) {
    return leftPolicy.order - rightPolicy.order;
  }
  return milestoneNumber(left) - milestoneNumber(right);
}

/**
 * Groups executable outcomes that share an `order`, across tracks. The caller
 * passes only the outcomes it ranks; a tie never fails the ranking itself.
 */
export function findOutcomeOrderTies(milestones) {
  const byOrder = new Map();
  for (const milestone of milestones) {
    if (!isExecutableOutcome(milestone)) continue;
    const { order } = readOutcomePolicy(milestone);
    const numbers = byOrder.get(order) ?? new Set();
    numbers.add(milestoneNumber(milestone));
    byOrder.set(order, numbers);
  }
  return [...byOrder]
    .filter(([, numbers]) => numbers.size > 1)
    .sort(([left], [right]) => left - right)
    .map(([order, numbers]) => ({
      code: "OUTCOME_ORDER_TIE",
      order,
      milestones: [...numbers].sort((left, right) => left - right),
    }));
}

export function isExecutableOutcome(milestone) {
  const policy = readOutcomePolicy(milestone);
  return policy !== null && policy.status === "committed" && String(milestone?.state ?? "").toLowerCase() === "open";
}
