import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const AGENT_GRANT_REVOCATION_SUPPORT_VERSION = 1;
export type RevocationActivationProof = Readonly<{
  capturedAt: string;
  expectedReplicas: readonly string[];
  replicas: readonly Readonly<{
    id: string;
    role: "platform-api" | "platform-worker";
    commit: string;
    digest: string;
    supportVersion: number;
  }>[];
}>;

export function assertRevocationActivationProof(
  proof: RevocationActivationProof,
  now: string,
  runtimeSupportVersion = AGENT_GRANT_REVOCATION_SUPPORT_VERSION,
): void {
  const age = Date.parse(now) - Date.parse(proof.capturedAt);
  if (
    runtimeSupportVersion !== AGENT_GRANT_REVOCATION_SUPPORT_VERSION ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 5 * 60_000 ||
    proof.expectedReplicas.length === 0 ||
    proof.expectedReplicas.length > 500 ||
    new Set(proof.expectedReplicas).size !== proof.expectedReplicas.length ||
    proof.replicas.length !== proof.expectedReplicas.length ||
    new Set(proof.replicas.map((replica) => replica.id)).size !== proof.replicas.length ||
    !proof.replicas.some((replica) => replica.role === "platform-api") ||
    !proof.replicas.some((replica) => replica.role === "platform-worker") ||
    proof.replicas.some(
      (replica) =>
        !proof.expectedReplicas.includes(replica.id) ||
        !["platform-api", "platform-worker"].includes(replica.role) ||
        replica.supportVersion !== AGENT_GRANT_REVOCATION_SUPPORT_VERSION ||
        !/^[a-f0-9]{40}$/.test(replica.commit) ||
        !/^sha256:[a-f0-9]{64}$/.test(replica.digest),
    ) ||
    Buffer.byteLength(JSON.stringify(proof), "utf8") > 64 * 1024
  )
    throw new Error("revocation_support_floor");
}

export const identityAgentGrantRevocationSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261012_identity_agent_grant_revocation_support",
    description: "Index retained owner and attempt facts; installing support never activates revocation routes.",
    statements: [
      `CREATE INDEX IF NOT EXISTS identity_agent_grant_revocation_pending_idx ON event_store_events (global_position)
      WHERE event_type = 'identity.agent-grant-revocation.admitted'`,
      `CREATE INDEX IF NOT EXISTS identity_agent_grant_revocation_attempt_owner_idx ON event_store_events ((payload->>'ownerStream'))
      WHERE event_type = 'identity.agent-grant-revocation-attempt.admitted'`,
    ],
  },
];
