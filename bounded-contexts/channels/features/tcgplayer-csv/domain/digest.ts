import { createHash } from "node:crypto";
import type { ChannelSyncRunMember } from "./contracts";

export function digestChannelSyncRunMembers(members: readonly ChannelSyncRunMember[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(members)), "utf8")
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUnicodeScalars(left, right))
      .map(([key, member]) => [key, canonicalize(member)]),
  );
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightScalars = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftScalars.length, rightScalars.length); index += 1) {
    const difference = (leftScalars[index] ?? 0) - (rightScalars[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
}
