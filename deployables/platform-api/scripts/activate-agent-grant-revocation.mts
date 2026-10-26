import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createPgPool, createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { getContextDatabaseEnvName } from "@chase-sets/platform-runtime/config-schema";
import { closeContextPools } from "@chase-sets/platform-runtime/context-pools";
import {
  AGENT_GRANT_REVOCATION_SUPPORT_VERSION,
  assertRevocationActivationProof,
  revocationActivationProofDigest,
  createAgentGrantRevocations,
  readAgentGrantRevocationStatus,
  type AgentGrantRevocations,
  type RevocationActivationProof,
} from "@chase-sets/identity/server";

const FAILURE_CATEGORIES = new Set([
  "pod_exec",
  "rbac",
  "database_connectivity",
  "schema_permission",
  "application",
  "unknown",
]);
type ActivationDiagnosticProof = Readonly<{ environment: string; releaseCommit: string; imageDigest: string }>;
const activationDiagnosticProof = Symbol("activationDiagnosticProof");

function safeDiagnosticProof(proof: Partial<RevocationActivationProof>): ActivationDiagnosticProof {
  return {
    environment: proof.environment === "staging" || proof.environment === "production" ? proof.environment : "unknown",
    releaseCommit: /^[a-f0-9]{40}$/.test(proof.releaseCommit ?? "") ? proof.releaseCommit! : "unknown",
    imageDigest: /^sha256:[a-f0-9]{64}$/.test(proof.imageDigest ?? "") ? proof.imageDigest! : "unknown",
  };
}

function attachDiagnosticProof(error: unknown, proof: Partial<RevocationActivationProof>) {
  if (!error || typeof error !== "object") return;
  try {
    Object.defineProperty(error, activationDiagnosticProof, {
      configurable: true,
      value: safeDiagnosticProof(proof),
    });
  } catch {
    // A non-extensible error cannot carry context; retain the safe unknown fallback.
  }
}

// Only a bounded code crosses this boundary; raw errors can carry connection strings.
export function activationRefusalCode(error: unknown): string {
  return error instanceof Error && /^revocation_[a-z_]{1,64}$/.test(error.message)
    ? error.message
    : "revocation_activation_refused";
}

export function activationDiagnostic(error: unknown, proof?: Partial<RevocationActivationProof>) {
  const inheritedProof =
    error && typeof error === "object"
      ? (error as { [activationDiagnosticProof]?: ActivationDiagnosticProof })[activationDiagnosticProof]
      : undefined;
  const context = proof ?? inheritedProof;
  const candidate =
    error && typeof error === "object" ? (error as { failureCategory?: unknown }).failureCategory : undefined;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return {
    schemaVersion: "agent-grant-revocation-diagnostic/v1",
    evidenceId: /^\d+\/\d+$/.test(`${process.env.GITHUB_RUN_ID ?? ""}/${process.env.GITHUB_RUN_ATTEMPT ?? ""}`)
      ? `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}`
      : "unknown/unknown",
    environment:
      context?.environment === "staging" || context?.environment === "production" ? context.environment : "unknown",
    releaseCommit: /^[a-f0-9]{40}$/.test(context?.releaseCommit ?? "") ? context?.releaseCommit : "unknown",
    imageDigest: /^sha256:[a-f0-9]{64}$/.test(context?.imageDigest ?? "") ? context?.imageDigest : "unknown",
    identity: { state: "unknown" },
    code: activationRefusalCode(error),
    sqlstateClass: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code.slice(0, 2) : "unknown",
    failureCategory: typeof candidate === "string" && FAILURE_CATEGORIES.has(candidate) ? candidate : "unknown",
  };
}

export async function runActivationCommand(
  input: Readonly<{
    owner: Pick<AgentGrantRevocations, "activate" | "activationProof">;
    environment: string;
    readProof: () => Promise<RevocationActivationProof>;
    write: (value: object) => void;
  }>,
) {
  const proof = await input.readProof();
  const existing = await input.owner.activationProof();
  assertRevocationActivationProof(proof, existing ? proof.capturedAt : new Date().toISOString());
  if (proof.environment !== input.environment) throw new Error("revocation_activation_environment_mismatch");
  try {
    await input.owner.activate(
      proof,
      {
        tenantId: "tnt_identity",
        audit: { performedByUserId: "usr_identity_deployment", forAccountId: "acc_identity_deployment" },
      },
      {
        revalidate: async () => {
          input.write({ state: "revalidate" });
          return input.readProof();
        },
      },
    );
    input.write({
      state: "activated",
      supportVersion: AGENT_GRANT_REVOCATION_SUPPORT_VERSION,
      environment: proof.environment,
      releaseCommit: proof.releaseCommit,
      proofDigest: revocationActivationProofDigest(proof),
    });
  } catch (error) {
    attachDiagnosticProof(error, proof);
    throw error;
  }
}

async function main() {
  if (process.argv[2] === "--support") {
    process.stdout.write(`${JSON.stringify({ supportVersion: AGENT_GRANT_REVOCATION_SUPPORT_VERSION })}\n`);
    return;
  }
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === "--status"))
    throw new Error("revocation_activation_arguments_invalid");
  const databaseUrl = process.env[getContextDatabaseEnvName("identity")];
  if (!databaseUrl) throw new Error("revocation_activation_database_missing");
  const pool = createPgPool(databaseUrl, { max: 1 });
  const lines = createInterface({ input: process.stdin });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    const eventStore = createPostgresEventStore({ pool });
    if (process.argv[2] === "--status") {
      process.stdout.write(`${JSON.stringify(await readAgentGrantRevocationStatus(pool, eventStore))}\n`);
      return;
    }
    await runActivationCommand({
      owner: createAgentGrantRevocations(pool, eventStore),
      environment: process.env.DEPLOYMENT_ENVIRONMENT ?? "",
      readProof: async () => {
        const line = await iterator.next();
        if (line.done || Buffer.byteLength(line.value, "utf8") > 64 * 1024)
          throw new Error("revocation_activation_proof_missing");
        return JSON.parse(line.value);
      },
      write: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    });
  } finally {
    lines.close();
    await closeContextPools({ identity: pool });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${activationRefusalCode(error)}\n`);
    process.stderr.write(`${JSON.stringify(activationDiagnostic(error))}\n`);
    process.exitCode = 1;
  });
}
