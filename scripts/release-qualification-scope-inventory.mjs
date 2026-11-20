import { validateReleaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";

export function buildReviewedSurfaceInventory(input) {
  for (const key of [
    "paths",
    "readFileAt",
    "registry",
    "classify",
    "evaluateApplicability",
    "releaseWorkflowScriptReferences",
    "base",
    "candidate",
    "now",
  ]) {
    if (!Object.hasOwn(input, key) || input[key] === undefined)
      throw new TypeError(`Missing inventory capability: ${key}`);
  }
  const {
    paths,
    readFileAt,
    registry,
    classify,
    evaluateApplicability,
    releaseWorkflowScriptReferences,
    base,
    candidate,
    now,
  } = input;
  const registryStatus = validateReleaseQualificationScopeRegistry(registry).length === 0 ? "valid" : "unreadable";
  const records = [];
  const misses = [];
  const counts = { discovered: 0, persistentRequired: 0, ruled: 0 };
  for (const filePath of new Set(paths)) {
    const ruling =
      registryStatus === "valid"
        ? registry.reviewedNonPersistentSurfaces.find((entry) =>
            new RegExp(entry.pattern.source, entry.pattern.flags).test(filePath),
          )
        : null;
    const applicabilityKind = ruling?.applicability.kind ?? null;
    let applies = applicabilityKind === "path-scope/v0";
    let withdrawalCodes = [];
    if (applicabilityKind === "pure-module/v1") {
      const evaluation = evaluateApplicability({
        rootPath: filePath,
        applicability: ruling.applicability,
        registry,
        readFileAt,
        now,
      });
      applies = evaluation.applies;
      withdrawalCodes = evaluation.withdrawalCodes;
    }
    const expected = ruling ? (applies ? ruling.expectedClass : "persistent_required") : "persistent_required";
    const record = classify({
      base,
      candidate,
      changedFiles: [{ path: filePath, status: "modified" }],
      registry,
      readFileAt,
      releaseWorkflowScriptReferences,
      now,
    });
    const miss =
      record.class !== expected && record.class !== "persistent_required"
        ? `${filePath}: expected ${expected}, got ${record.class} (${record.reasonCodes.join(", ")})`
        : null;
    if (miss !== null) misses.push(miss);
    else if (record.class === "persistent_required") counts.persistentRequired += 1;
    else counts.ruled += 1;
    counts.discovered += 1;
    records.push({
      path: filePath,
      matchedPattern: ruling?.pattern.source ?? null,
      applicabilityKind,
      applies,
      withdrawalCodes,
      expectedClass: expected,
      class: record.class,
      reasonCodes: record.reasonCodes,
      miss,
    });
  }
  return { records, misses, counts, registryStatus };
}
