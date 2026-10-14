import { createHash } from "node:crypto";

export function revocationActivationProofDigest(proof: RevocationActivationProof): string {
  // JSONB does not preserve object-key order. Arrays retain their captured order.
  const keys = [...Object.keys(proof), ...Object.keys(proof.replicas[0])].sort();
  return createHash("sha256").update(JSON.stringify(proof, keys)).digest("hex");
}

export const AGENT_GRANT_REVOCATION_SUPPORT_VERSION = 1;
export type RevocationActivationProof = Readonly<{
  environment: "staging" | "production";
  namespace: string;
  releaseCommit: string;
  imageDigest: string;
  evidenceId: string;
  fenceId: string;
  capturedAt: string;
  expectedReplicas: readonly string[];
  replicas: readonly Readonly<{
    id: string;
    uid: string;
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
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("revocation_support_floor");
  const age = Date.parse(now) - Date.parse(proof.capturedAt);
  if (
    !proof ||
    typeof proof !== "object" ||
    Object.keys(proof).sort().join() !==
      "capturedAt,environment,evidenceId,expectedReplicas,fenceId,imageDigest,namespace,releaseCommit,replicas" ||
    !["staging", "production"].includes(proof.environment) ||
    [proof.namespace, proof.evidenceId, proof.fenceId].some(
      (value) => typeof value !== "string" || !/^[A-Za-z0-9_.:/-]{1,256}$/.test(value),
    ) ||
    typeof proof.releaseCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(proof.releaseCommit) ||
    typeof proof.imageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(proof.imageDigest) ||
    !Array.isArray(proof.expectedReplicas) ||
    !Array.isArray(proof.replicas) ||
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
    proof.replicas.some((replica) => !replica || typeof replica !== "object" || Array.isArray(replica)) ||
    new Set(proof.replicas.map((replica) => replica.id)).size !== proof.replicas.length ||
    new Set(proof.replicas.map((replica) => replica.uid)).size !== proof.replicas.length ||
    !proof.replicas.some((replica) => replica.role === "platform-api") ||
    !proof.replicas.some((replica) => replica.role === "platform-worker") ||
    proof.replicas.some(
      (replica) =>
        !replica ||
        typeof replica !== "object" ||
        Object.keys(replica).sort().join() !== "commit,digest,id,role,supportVersion,uid" ||
        typeof replica.uid !== "string" ||
        !/^[A-Za-z0-9-]{1,128}$/.test(replica.uid) ||
        !proof.expectedReplicas.includes(replica.id) ||
        !["platform-api", "platform-worker"].includes(replica.role) ||
        replica.supportVersion !== AGENT_GRANT_REVOCATION_SUPPORT_VERSION ||
        replica.commit !== proof.releaseCommit ||
        replica.digest !== proof.imageDigest ||
        typeof replica.commit !== "string" ||
        typeof replica.digest !== "string" ||
        !/^[a-f0-9]{40}$/.test(replica.commit) ||
        !/^sha256:[a-f0-9]{64}$/.test(replica.digest),
    ) ||
    Buffer.byteLength(JSON.stringify(proof), "utf8") > 64 * 1024
  )
    throw new Error("revocation_support_floor");
}
