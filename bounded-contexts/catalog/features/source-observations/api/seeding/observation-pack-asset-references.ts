import { sha256 } from "./observation-pack";

export function recoverObservationPackAssetReferences(
  candidates: readonly string[],
  expectedHash: string,
  resolveImageReference?: (reference: string) => string,
): readonly string[] {
  const hash = (values: readonly string[]) => sha256(new TextEncoder().encode([...values].sort().join("\n")));
  if (hash(candidates) === expectedHash) {
    return candidates;
  }
  const singles = candidates.filter((candidate) => hash([candidate]) === expectedHash);
  if (singles.length === 1) {
    return singles;
  }
  if (resolveImageReference) {
    const groups = new Map<string, string[]>();
    for (const candidate of candidates) {
      const key = resolveImageReference(candidate);
      const group = groups.get(key) ?? [];
      group.push(candidate);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (hash(group) === expectedHash) {
        return group;
      }
    }
  }
  if (candidates.length > 16) {
    return [];
  }
  for (let mask = 1; mask < 2 ** candidates.length; mask += 1) {
    const subset = candidates.filter((_, index) => (mask & (1 << index)) !== 0);
    if (hash(subset) === expectedHash) {
      return subset;
    }
  }
  return [];
}
