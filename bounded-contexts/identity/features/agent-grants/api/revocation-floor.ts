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
    typeof proof.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proof.capturedAt) ||
    !Number.isFinite(age) ||
    new Date(proof.capturedAt).toISOString() !== proof.capturedAt ||
    age < 0 ||
    age > 5 * 60_000 ||
    proof.expectedReplicas.length === 0 ||
    proof.expectedReplicas.length > 500 ||
    proof.expectedReplicas.some((id) => typeof id !== "string" || id.length === 0 || id.length > 256) ||
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
        typeof replica.commit !== "string" ||
        typeof replica.digest !== "string" ||
        !/^[a-f0-9]{40}$/.test(replica.commit) ||
        !/^sha256:[a-f0-9]{64}$/.test(replica.digest),
    ) ||
    Buffer.byteLength(JSON.stringify(proof), "utf8") > 64 * 1024
  )
    throw new Error("revocation_support_floor");
}
