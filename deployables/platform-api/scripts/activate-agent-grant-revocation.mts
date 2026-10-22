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

// Only a bounded code crosses this boundary; raw errors can carry connection strings.
export function activationRefusalCode(error: unknown): string {
  return error instanceof Error && /^revocation_[a-z_]{1,64}$/.test(error.message)
    ? error.message
    : "revocation_activation_refused";
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
    process.exitCode = 1;
  });
}
