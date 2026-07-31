import {
  compareGroupIdentity,
  compareStringArrays,
  type AssemblyRow,
  type CensusRow,
  type DuplicateGroup,
  type MountRecord,
  type OccurrenceCount,
  type RouteCapture,
} from "./model.mts";

export type SequenceDiff<T> = Readonly<{
  kind: "added" | "removed" | "changed";
  baseIndex: number | null;
  candidateIndex: number | null;
  changedFields: readonly string[];
  base: T | null;
  candidate: T | null;
}>;

export type CountDiff = Readonly<{
  field: string;
  base: number;
  candidate: number;
}>;

export type GroupDiff = Readonly<{
  kind: "added" | "removed" | "changed";
  method: string;
  collisionShape: readonly string[];
  baseMembers: readonly OccurrenceCount[] | null;
  candidateMembers: readonly OccurrenceCount[] | null;
}>;

export type RouteComparison = Readonly<{
  expectedState: "empty" | "nonempty";
  actualState: "empty" | "nonempty";
  countDiffs: readonly CountDiff[];
  mountDiffs: readonly SequenceDiff<MountRecord>[];
  censusDiffs: readonly SequenceDiff<CensusRow>[];
  duplicateGroupDiffs: readonly GroupDiff[];
  assemblyDiffs: readonly SequenceDiff<AssemblyRow>[];
}>;

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sequenceDiff<T>(
  base: readonly T[],
  candidate: readonly T[],
  sameAnchor: (left: T, right: T) => boolean,
  changedFields: (left: T, right: T) => readonly string[],
): SequenceDiff<T>[] {
  const lcs = Array.from({ length: base.length + 1 }, () => new Uint32Array(candidate.length + 1));
  for (let baseIndex = base.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let candidateIndex = candidate.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      lcs[baseIndex][candidateIndex] = sameAnchor(base[baseIndex], candidate[candidateIndex])
        ? 1 + lcs[baseIndex + 1][candidateIndex + 1]
        : Math.max(lcs[baseIndex + 1][candidateIndex], lcs[baseIndex][candidateIndex + 1]);
    }
  }
  const diffs: SequenceDiff<T>[] = [];
  let baseIndex = 0;
  let candidateIndex = 0;
  while (baseIndex < base.length || candidateIndex < candidate.length) {
    if (
      baseIndex < base.length &&
      candidateIndex < candidate.length &&
      sameAnchor(base[baseIndex], candidate[candidateIndex])
    ) {
      const fields = changedFields(base[baseIndex], candidate[candidateIndex]);
      if (fields.length > 0) {
        diffs.push({
          kind: "changed",
          baseIndex: baseIndex + 1,
          candidateIndex: candidateIndex + 1,
          changedFields: fields,
          base: base[baseIndex],
          candidate: candidate[candidateIndex],
        });
      }
      baseIndex += 1;
      candidateIndex += 1;
      continue;
    }
    const removalScore = baseIndex < base.length ? lcs[baseIndex + 1][candidateIndex] : -1;
    const additionScore = candidateIndex < candidate.length ? lcs[baseIndex][candidateIndex + 1] : -1;
    if (baseIndex < base.length && removalScore >= additionScore) {
      diffs.push({
        kind: "removed",
        baseIndex: baseIndex + 1,
        candidateIndex: null,
        changedFields: [],
        base: base[baseIndex],
        candidate: null,
      });
      baseIndex += 1;
    } else {
      diffs.push({
        kind: "added",
        baseIndex: null,
        candidateIndex: candidateIndex + 1,
        changedFields: [],
        base: null,
        candidate: candidate[candidateIndex],
      });
      candidateIndex += 1;
    }
  }
  return diffs;
}

function fields<T extends object>(left: T, right: T, names: readonly (keyof T)[]): string[] {
  return names.filter((name) => !same(left[name], right[name])).map(String);
}

function handlerChanged(left: CensusRow | AssemblyRow, right: CensusRow | AssemblyRow): boolean {
  return left.handler.name !== right.handler.name || left.handler.arity !== right.handler.arity;
}

export function compareDuplicateGroups(
  baseGroups: readonly DuplicateGroup[],
  candidateGroups: readonly DuplicateGroup[],
): GroupDiff[] {
  const diffs: GroupDiff[] = [];
  let baseIndex = 0;
  let candidateIndex = 0;
  while (baseIndex < baseGroups.length || candidateIndex < candidateGroups.length) {
    const base = baseGroups[baseIndex];
    const candidate = candidateGroups[candidateIndex];
    const order = !base ? 1 : !candidate ? -1 : compareGroupIdentity(base, candidate);
    if (order < 0) {
      diffs.push({
        kind: "removed",
        method: base.method,
        collisionShape: base.collisionShape,
        baseMembers: base.memberOccurrences,
        candidateMembers: null,
      });
      baseIndex += 1;
    } else if (order > 0) {
      diffs.push({
        kind: "added",
        method: candidate.method,
        collisionShape: candidate.collisionShape,
        baseMembers: null,
        candidateMembers: candidate.memberOccurrences,
      });
      candidateIndex += 1;
    } else {
      if (!same(base.memberOccurrences, candidate.memberOccurrences)) {
        diffs.push({
          kind: "changed",
          method: base.method,
          collisionShape: base.collisionShape,
          baseMembers: base.memberOccurrences,
          candidateMembers: candidate.memberOccurrences,
        });
      }
      baseIndex += 1;
      candidateIndex += 1;
    }
  }
  return diffs;
}

export function compareCaptures(
  base: RouteCapture,
  candidate: RouteCapture,
  expectedState: "empty" | "nonempty",
): RouteComparison {
  const countDiffs = Object.keys(base.counts)
    .filter(
      (field) =>
        base.counts[field as keyof typeof base.counts] !== candidate.counts[field as keyof typeof candidate.counts],
    )
    .map((field) => ({
      field,
      base: base.counts[field as keyof typeof base.counts],
      candidate: candidate.counts[field as keyof typeof candidate.counts],
    }));
  const mountDiffs = sequenceDiff(
    base.mountRecords,
    candidate.mountRecords,
    (left, right) => left.context === right.context && left.mountPath === right.mountPath,
    (left, right) => fields(left, right, ["mountKind", "requiresAuth", "freshnessRouteCount", "routeCount"]),
  );
  const censusDiffs = sequenceDiff(
    base.censusRows,
    candidate.censusRows,
    (left, right) =>
      left.context === right.context &&
      left.method === right.method &&
      left.rawPath === right.rawPath &&
      compareStringArrays(left.collisionShape, right.collisionShape) === 0,
    (left, right) => {
      const changed = fields(left, right, [
        "mountPath",
        "mountKind",
        "requiresAuth",
        "rawBasePath",
        "combinedPath",
        "acceptedPathProjections",
      ]);
      if (handlerChanged(left, right)) changed.push("handler");
      return changed;
    },
  );
  const duplicateGroupDiffs = compareDuplicateGroups(base.duplicateGroups, candidate.duplicateGroups);
  const assemblyDiffs = sequenceDiff(
    base.assemblyRows,
    candidate.assemblyRows,
    (left, right) => left.basePath === right.basePath && left.path === right.path && left.method === right.method,
    (left, right) => (handlerChanged(left, right) ? ["handler"] : []),
  );
  const actualState = [countDiffs, mountDiffs, censusDiffs, duplicateGroupDiffs, assemblyDiffs].every(
    (diffs) => diffs.length === 0,
  )
    ? "empty"
    : "nonempty";
  return {
    expectedState,
    actualState,
    countDiffs,
    mountDiffs,
    censusDiffs,
    duplicateGroupDiffs,
    assemblyDiffs,
  };
}
