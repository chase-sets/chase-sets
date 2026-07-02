export type ProjectionReplayRuntime = Readonly<{
  projectionGroups: readonly Readonly<{
    targetContextName: string;
    projectionName: string;
  }>[];
}>;

export type ProjectionReplayTarget = Readonly<{
  contextName: string;
  projectionNames: readonly string[];
}>;

type RebuildProjectionSelectionOptions<T extends ProjectionReplayRuntime> = Readonly<{
  rebuildAllContextProjectionGroups?: (runtime: T, contextName: string) => Promise<void>;
  rebuildContextProjectionGroup?: (runtime: T, contextName: string, projectionName: string) => Promise<void>;
}>;

function formatValidValues(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current[rightIndex + 1] =
        left[leftIndex] === right[rightIndex]
          ? previous[rightIndex]
          : Math.min(previous[rightIndex], previous[rightIndex + 1], current[rightIndex]) + 1;
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? left.length;
}

function findNearestMatch(value: string, candidates: readonly string[]): string | null {
  const normalizedValue = value.toLowerCase();
  const prefixMatch = candidates.find((candidate) => candidate.toLowerCase().startsWith(normalizedValue));

  if (prefixMatch) {
    return prefixMatch;
  }

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      distance: levenshteinDistance(normalizedValue, candidate.toLowerCase()),
    }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));
  const best = ranked[0];
  const threshold = Math.max(2, Math.floor(value.length / 3));

  return best && best.distance <= threshold ? best.candidate : null;
}

function formatSuggestion(value: string, candidates: readonly string[]): string {
  const suggestion = findNearestMatch(value, candidates);
  return suggestion ? ` Did you mean "${suggestion}"?` : "";
}

export function listProjectionReplayTargets(runtime: ProjectionReplayRuntime): readonly ProjectionReplayTarget[] {
  const byContext = new Map<string, Set<string>>();

  for (const group of runtime.projectionGroups) {
    const projections = byContext.get(group.targetContextName) ?? new Set<string>();
    projections.add(group.projectionName);
    byContext.set(group.targetContextName, projections);
  }

  return [...byContext.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([contextName, projectionNames]) => ({
      contextName,
      projectionNames: [...projectionNames].sort((left, right) => left.localeCompare(right)),
    }));
}

export function validateProjectionReplaySelection(
  runtime: ProjectionReplayRuntime,
  contextName: string,
  projectionName: string,
): void {
  const targets = listProjectionReplayTargets(runtime);
  const validContextNames = targets.map((target) => target.contextName);
  const target = targets.find((candidate) => candidate.contextName === contextName);

  if (!target) {
    throw new Error(
      `Unknown projection context "${contextName}". Use one of: ${formatValidValues(validContextNames)}.${formatSuggestion(
        contextName,
        validContextNames,
      )}`,
    );
  }

  if (projectionName === "--all") {
    return;
  }

  if (!target.projectionNames.includes(projectionName)) {
    throw new Error(
      `Unknown projection "${projectionName}" for context "${contextName}". Use one of: ${formatValidValues(
        target.projectionNames,
      )}.${formatSuggestion(projectionName, target.projectionNames)}`,
    );
  }
}

export async function rebuildProjectionSelection<T extends ProjectionReplayRuntime>(
  runtime: T,
  contextName: string,
  projectionName: string,
  options: RebuildProjectionSelectionOptions<T>,
): Promise<void> {
  validateProjectionReplaySelection(runtime, contextName, projectionName);

  if (projectionName === "--all") {
    await options.rebuildAllContextProjectionGroups?.(runtime, contextName);
    return;
  }

  await options.rebuildContextProjectionGroup?.(runtime, contextName, projectionName);
}
