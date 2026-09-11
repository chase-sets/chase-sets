export const OUTCOME_METADATA_VERSION = 1;

const OUTCOME_MARKER_START = /<!--\s*outcome\s*:/gi;
const OUTCOME_MARKER = /<!--\s*outcome\s*:\s*([\s\S]*?)\s*-->/gi;
const OUTCOME_KEYS = ["order", "status", "track", "version"];
const TRACK = /^[a-z][a-z0-9-]*$/;
const LEGACY_OUTCOME_TITLE = /^(Wave|Mobile)\s+(\d+)\b/;

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

function legacyPolicy(milestone) {
  if (typeof milestone?.title !== "string") return null;
  const match = LEGACY_OUTCOME_TITLE.exec(milestone.title);
  if (!match) return null;
  const order = Number(match[2]);
  if (!Number.isSafeInteger(order) || order < 0) return null;
  return Object.freeze({
    version: OUTCOME_METADATA_VERSION,
    track: match[1],
    order,
    status: "committed",
    source: "legacy-title",
  });
}

/**
 * Reads the sole outcome-ordering authority from a milestone description.
 * Untagged Wave/Mobile titles are accepted only as migration compatibility.
 */
export function readOutcomePolicy(milestone) {
  const description = milestone?.description;
  if (description !== null && description !== undefined && typeof description !== "string") {
    fail("OUTCOME_DESCRIPTION_INVALID", milestone);
  }
  const text = description ?? "";
  const starts = [...text.matchAll(OUTCOME_MARKER_START)];
  if (starts.length === 0) return legacyPolicy(milestone);
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

export function isExecutableOutcome(milestone) {
  const policy = readOutcomePolicy(milestone);
  return policy !== null && policy.status === "committed" && String(milestone?.state ?? "").toLowerCase() === "open";
}
