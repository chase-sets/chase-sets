export const guardReserveMs = 60000;

export function nonminimalCaptureViolation(minimum) {
  return `the shipped topology spends 3 execution units where the schedule model's minimumUnitCount for the same file set is ${minimum}; execution units of one workspace run serially, so an unnecessary unit is spent aggregate budget`;
}

export function classifyGuardScreen({ result, census, elapsedMs, complete, exitCode }) {
  const refuse = (reason) => ({ classification: "REFUSAL", reason });
  if (!complete || exitCode !== 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > guardReserveMs)
    return refuse("missing, failed, truncated, or over-deadline screen");
  if (
    result?.caseCount !== 62 ||
    result.expectedCaseCount !== 62 ||
    result.fileCount !== 12 ||
    result.partitionUnitCount !== 3 ||
    result.schedule?.observedUnitCount !== 3 ||
    census?.bootstrapEntries?.length !== 12 ||
    census.dbEntries?.length !== 18 ||
    census.violations?.length !== 0 ||
    !Array.isArray(result.violations)
  )
    return refuse("capture counts or census mismatch");
  const minimum = result.schedule.minimumUnitCount;
  if (![1, 2, 3].includes(minimum)) return refuse("missing or unsupported minimum");
  const expected = minimum === 3 ? [] : [nonminimalCaptureViolation(minimum)];
  if (JSON.stringify(result.violations) !== JSON.stringify(expected)) return refuse("unexpected raw violations");
  const units = result.schedule.units;
  if (
    !Array.isArray(units) ||
    units.length !== 3 ||
    units.some(
      (unit) =>
        !Number.isSafeInteger(unit.makespanMs) ||
        unit.makespanMs < 0 ||
        unit.makespanMs > 420000 ||
        unit.makespanMs + guardReserveMs >= 600000,
    ) ||
    !Number.isSafeInteger(result.schedule.aggregateWithOverheadMs) ||
    result.schedule.aggregateWithOverheadMs < 0 ||
    result.schedule.aggregateWithOverheadMs > 1080000 ||
    result.schedule.aggregateWithOverheadMs + 3 * guardReserveMs >= 1800000
  )
    return refuse("raw model or reserved capture projection does not fit");
  return {
    classification: minimum === 3 ? "SCREEN_OK" : "EXPECTED_CAPTURE_NONMINIMAL",
    guardPass: minimum === 3,
    productQualification: false,
    captureProjection: {
      unitMs: units.map((unit) => unit.makespanMs + guardReserveMs),
      aggregateMs: result.schedule.aggregateWithOverheadMs + 3 * guardReserveMs,
    },
    // The public guard does not expose the minimum witness's individual costs.
    // Its unchanged feasibility predicate supplies these bounds, not new pins.
    derivedMinimumProjectionBound: {
      units: minimum,
      unitMs: 420000 + guardReserveMs,
      aggregateMs: 1080000 + minimum * guardReserveMs,
    },
  };
}
