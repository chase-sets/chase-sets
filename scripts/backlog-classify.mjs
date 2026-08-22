const EPIC_LABEL = "kind:epic";
const TRACKING_ONLY_LABEL = "status:tracking-only";
const NON_EXECUTABLE_MILESTONES = new Set(["Deferred / Incubation", "Operations"]);
const KNOWN_ISSUE_TYPES = new Set(["Epic", "Slice", "Bug", "Decision", "Probe"]);

export class BacklogClassificationInputError extends TypeError {
  constructor(field, reason) {
    super(`Invalid backlog classification field "${field}": ${reason}`);
    this.name = "BacklogClassificationInputError";
    this.field = field;
  }
}

function requireField(input, field) {
  if (!Object.hasOwn(input, field)) {
    throw new BacklogClassificationInputError(field, "field is required");
  }
  return input[field];
}

function validate(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BacklogClassificationInputError("input", "expected an object");
  }

  const number = requireField(input, "number");
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new BacklogClassificationInputError("number", "expected a finite number");
  }

  const state = requireField(input, "state");
  if (state !== "open" && state !== "closed") {
    throw new BacklogClassificationInputError("state", 'expected "open" or "closed"');
  }

  const labels = requireField(input, "labels");
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    throw new BacklogClassificationInputError("labels", "expected an array of strings");
  }

  const issueTypeName = requireField(input, "issueTypeName");
  if (issueTypeName !== null && typeof issueTypeName !== "string") {
    throw new BacklogClassificationInputError("issueTypeName", "expected a string or null");
  }

  const milestoneTitle = requireField(input, "milestoneTitle");
  if (milestoneTitle !== null && typeof milestoneTitle !== "string") {
    throw new BacklogClassificationInputError("milestoneTitle", "expected a string or null");
  }

  const blockedByCount = requireField(input, "blockedByCount");
  if (typeof blockedByCount !== "number" || !Number.isInteger(blockedByCount) || blockedByCount < 0) {
    throw new BacklogClassificationInputError("blockedByCount", "expected a non-negative integer");
  }

  const hasParent = requireField(input, "hasParent");
  if (typeof hasParent !== "boolean") {
    throw new BacklogClassificationInputError("hasParent", "expected a boolean");
  }

  return input;
}

export function isEpic(input) {
  const value = validate(input);
  if (value.issueTypeName !== null) return value.issueTypeName === "Epic";
  return value.labels.includes(EPIC_LABEL);
}

export function isTrackingOnly(input) {
  return validate(input).labels.includes(TRACKING_ONLY_LABEL);
}

export function isExecutableMilestone(milestoneTitle) {
  return (
    typeof milestoneTitle === "string" && milestoneTitle.length > 0 && !NON_EXECUTABLE_MILESTONES.has(milestoneTitle)
  );
}

export function classified(input) {
  const value = validate(input);
  if (value.state !== "open") return false;
  if (value.issueTypeName !== null && !KNOWN_ISSUE_TYPES.has(value.issueTypeName)) return false;
  if (isEpic(value) || isTrackingOnly(value)) return false;
  if (!isExecutableMilestone(value.milestoneTitle)) return false;

  return (
    value.labels.some((label) => label.startsWith("priority:")) &&
    value.labels.some((label) => label.startsWith("area:")) &&
    value.labels.some((label) => label.startsWith("kind:"))
  );
}

export function refined(input) {
  return classified(input);
}
