import { createHash } from "node:crypto";
export type DriftGenerationMember = Readonly<{
  identity: string;
  kind: "foreign-edit" | "structural" | "repairable" | "source-unavailable";
  expectedFingerprint: string | null;
  observedFingerprint: string | null;
  settlement: "open" | "accepted" | "recovered";
  decisionRevision: number;
  recoveryRequested: boolean;
}>;
export type RetainedDriftGeneration = Readonly<{
  generation: number;
  fingerprint: string;
  members: readonly DriftGenerationMember[];
  resolution: "handled-on-channel" | "recovered-automatically" | null;
}>;

export function decodeRetainedDriftGeneration(value: unknown): RetainedDriftGeneration | null {
  if (value === null) return null;
  const row = closed(value, ["generation", "fingerprint", "members", "resolution"]);
  if (
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    !Array.isArray(row.members) ||
    (row.resolution !== null && row.resolution !== "handled-on-channel" && row.resolution !== "recovered-automatically")
  )
    invalid();
  const members = row.members.map((value): DriftGenerationMember => {
    const member = closed(value, [
      "identity",
      "kind",
      "expectedFingerprint",
      "observedFingerprint",
      "settlement",
      "decisionRevision",
      "recoveryRequested",
    ]);
    if (
      typeof member.identity !== "string" ||
      member.identity.length < 1 ||
      member.identity.length > 512 ||
      (member.kind !== "foreign-edit" &&
        member.kind !== "structural" &&
        member.kind !== "repairable" &&
        member.kind !== "source-unavailable") ||
      (member.settlement !== "open" && member.settlement !== "accepted" && member.settlement !== "recovered") ||
      typeof member.decisionRevision !== "number" ||
      !Number.isSafeInteger(member.decisionRevision) ||
      member.decisionRevision < 0 ||
      typeof member.recoveryRequested !== "boolean"
    )
      invalid();
    return {
      identity: member.identity,
      kind: member.kind,
      settlement: member.settlement,
      expectedFingerprint: member.expectedFingerprint === null ? null : digest(member.expectedFingerprint),
      observedFingerprint: member.observedFingerprint === null ? null : digest(member.observedFingerprint),
      decisionRevision: member.decisionRevision,
      recoveryRequested: member.recoveryRequested,
    };
  });
  const result: RetainedDriftGeneration = {
    generation: row.generation,
    fingerprint: digest(row.fingerprint),
    members,
    resolution: row.resolution,
  };
  if (
    result.members.length === 0 ||
    new Set(result.members.map((member) => member.identity)).size !== result.members.length ||
    result.fingerprint !== generationFingerprint(result.generation, result.members)
  ) {
    throw new Error("Channel drift generation membership does not match its fingerprint.");
  }
  if (
    result.resolution !== null &&
    (members.some((member) => member.settlement === "open") ||
      (result.resolution === "handled-on-channel" &&
        members.some(
          (member) => member.kind !== "foreign-edit" || member.settlement !== "accepted" || member.recoveryRequested,
        )))
  )
    invalid();
  return result;
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalid();
  return record;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function invalid(): never {
  throw new Error("Invalid retained channel drift generation.");
}

export function retainDriftGeneration(
  previous: RetainedDriftGeneration | null,
  observed: readonly DriftGenerationMember[],
  clean: boolean,
): RetainedDriftGeneration | null {
  const open = observed.filter((member) => member.settlement === "open");
  const previousMembers = new Map(previous?.members.map((member) => [member.identity, member]));
  const currentMembers = new Map(observed.map((member) => [member.identity, member]));
  const changed = open.some((member) => {
    const prior = previousMembers.get(member.identity);
    return (
      !prior ||
      prior.settlement === "recovered" ||
      prior.expectedFingerprint !== member.expectedFingerprint ||
      prior.observedFingerprint !== member.observedFingerprint
    );
  });
  if (open.length > 0 && (!previous || previous.resolution !== null || changed)) {
    const generation = (previous?.generation ?? 0) + 1;
    const members = [...open].sort((a, b) => a.identity.localeCompare(b.identity));
    return { generation, fingerprint: generationFingerprint(generation, members), members, resolution: null };
  }
  if (!previous || previous.resolution !== null) return previous;
  const members = previous.members.map((member) => {
    const current = currentMembers.get(member.identity);
    if (!current) return clean === true ? { ...member, settlement: "recovered" as const } : member;
    const accepted =
      member.kind === "foreign-edit" &&
      current.settlement === "accepted" &&
      member.expectedFingerprint === current.expectedFingerprint &&
      member.observedFingerprint === current.observedFingerprint;
    return {
      ...member,
      recoveryRequested: member.recoveryRequested || current.recoveryRequested,
      settlement: accepted
        ? ("accepted" as const)
        : current.settlement === "recovered"
          ? ("recovered" as const)
          : ("open" as const),
    };
  });
  const settled = clean && members.every((member) => member.settlement !== "open");
  return {
    ...previous,
    members,
    resolution: !settled
      ? null
      : members.every(
            (member) => member.kind === "foreign-edit" && member.settlement === "accepted" && !member.recoveryRequested,
          )
        ? "handled-on-channel"
        : "recovered-automatically",
  };
}

function generationFingerprint(generation: number, members: readonly DriftGenerationMember[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        generation,
        [...members]
          .sort((a, b) => a.identity.localeCompare(b.identity))
          .map(({ identity, kind, expectedFingerprint, observedFingerprint }) => [
            identity,
            kind,
            expectedFingerprint,
            observedFingerprint,
          ]),
      ]),
    )
    .digest("hex");
}
