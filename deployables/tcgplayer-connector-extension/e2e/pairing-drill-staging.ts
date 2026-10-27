import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import {
  PairingDrillRefusal,
  type PairingDrillInput,
  type PairingDrillPreflight,
  type PairingDrillPreflightRow,
  runPairingDrill,
} from "./pairing-drill";

const mountPath = "/channel-connector/oauth/authorize";
const callbackHost = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host;
const stagingOrigin = linkIntentOrigins["marketplace-web"].staging;

export type PairingDrillStagingArgs = Readonly<{
  smoke: boolean;
  deployRun: string;
  deployCommit: string;
  platformOrigin: string;
  clientId?: string;
  artifactDigest?: string;
  personaAlias?: string;
}>;

export type StagingDrillDependencies = Readonly<{
  fetch?: typeof fetch;
  resolveDeployBinding?: (run: string, commit: string) => Promise<PairingDrillPreflight["binding"]>;
}>;

function option(argv: readonly string[], name: string) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

export function parsePairingDrillStagingArgs(argv: readonly string[]): PairingDrillStagingArgs {
  const smoke = argv.includes("--smoke");
  const known = new Set([
    "--smoke",
    "--deploy-run",
    "--deploy-commit",
    "--platform-origin",
    "--client-id",
    "--artifact-digest",
    "--persona-alias",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!known.has(token)) throw new Error(`connector-drill-unknown-argument:${token}`);
    if (token !== "--smoke" && (!argv[index + 1] || argv[index + 1].startsWith("--")))
      throw new Error(`connector-drill-missing-argument:${token}`);
    if (token !== "--smoke") index++;
  }
  const deployRun = option(argv, "--deploy-run");
  const deployCommit = option(argv, "--deploy-commit");
  const platformOrigin = option(argv, "--platform-origin");
  if (!deployRun || !deployCommit || !platformOrigin) throw new Error("connector-drill-staging-input-incomplete");
  if (platformOrigin !== stagingOrigin) throw new Error("connector-drill-production-origin-refused");
  if (
    !smoke &&
    (!option(argv, "--client-id") || !option(argv, "--artifact-digest") || !option(argv, "--persona-alias"))
  )
    throw new Error("connector-drill-staging-input-incomplete");
  return {
    smoke,
    deployRun,
    deployCommit,
    platformOrigin,
    clientId: option(argv, "--client-id"),
    artifactDigest: option(argv, "--artifact-digest"),
    personaAlias: option(argv, "--persona-alias"),
  };
}

function jsonCode(body: unknown) {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
}

async function probe(fetcher: typeof fetch, origin: string, clientId: string): Promise<PairingDrillPreflightRow[]> {
  const mountResponse = await fetcher(`${origin}${mountPath}`, { redirect: "manual" });
  const mountBody = await mountResponse.json().catch(() => undefined);
  const rows: PairingDrillPreflightRow[] = [
    {
      name: "mount",
      host: new URL(origin).host,
      path: mountPath,
      status: mountResponse.status,
      contentType: mountResponse.headers.get("content-type") ?? undefined,
      bodyCode: jsonCode(mountBody),
    },
  ];
  const challenge = randomBytes(32).toString("base64url").slice(0, 43);
  const state = randomBytes(32).toString("base64url").slice(0, 43);
  const redirect = TCGPLAYER_CONNECTOR_REDIRECT_URI;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const clientResponse = await fetcher(`${origin}${mountPath}?${query}`, { redirect: "manual" });
  const location = clientResponse.headers.get("location");
  const parsedLocation = location ? new URL(location) : undefined;
  const unregistered = new URL(`${origin}${mountPath}?${query}`);
  unregistered.searchParams.set("client_id", `${clientId}-unregistered`);
  const unregisteredResponse = await fetcher(unregistered, { redirect: "manual" });
  rows.push({
    name: "client",
    host: new URL(origin).host,
    path: mountPath,
    status: clientResponse.status,
    locationHost: parsedLocation?.host,
    errorDescription: parsedLocation?.searchParams.get("error_description") ?? undefined,
    unregisteredStatus: unregisteredResponse.status,
  });
  return rows;
}

export async function runPairingDrillStaging(
  args: PairingDrillStagingArgs,
  options: StagingDrillDependencies &
    Omit<
      PairingDrillInput,
      | "mode"
      | "platformOrigin"
      | "clientId"
      | "artifactDigest"
      | "deployRun"
      | "deployCommit"
      | "personaAlias"
      | "smoke"
    >,
) {
  if (args.platformOrigin !== stagingOrigin) throw new Error("connector-drill-production-origin-refused");
  if (!options.resolveDeployBinding) throw new Error("connector-drill-deploy-binding-unavailable");
  const binding = await options.resolveDeployBinding(args.deployRun, args.deployCommit);
  const preflight: PairingDrillPreflight = {
    deployRun: args.deployRun,
    deployCommit: args.deployCommit,
    binding: binding ?? undefined,
    rows: [
      {
        name: "deploy",
        host: "deploy-authority",
        path: `/run/${args.deployRun}`,
        status: binding?.state === "completed" && !binding.superseded ? "completed" : "refused",
      },
      ...(args.smoke ? [] : await probe(options.fetch ?? fetch, args.platformOrigin, args.clientId!)),
    ],
  };
  const input: PairingDrillInput = {
    ...options,
    mode: "deployed",
    platformOrigin: args.platformOrigin,
    clientId: args.clientId ?? "",
    artifactDigest: args.artifactDigest ?? "",
    deployRun: args.deployRun,
    deployCommit: args.deployCommit,
    personaAlias: args.personaAlias,
    preflight,
    smoke: args.smoke,
  };
  return runPairingDrill(input);
}

async function main() {
  const args = parsePairingDrillStagingArgs(process.argv.slice(2));
  const result = await runPairingDrillStaging(args, {
    dist: resolve(import.meta.dirname, "../dist"),
    signIn: async () => {
      throw new PairingDrillRefusal("connector-drill-sign-in-unavailable", {
        forwardCount: 0,
        forwards: [],
        requests: [],
        lifecycle: [],
      });
    },
    preparePairing: async () => {
      throw new Error("connector-drill-sign-in-unavailable");
    },
    revoke: async () => undefined,
  });
  process.stdout.write(`${JSON.stringify(result.receipt)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

export { callbackHost };
