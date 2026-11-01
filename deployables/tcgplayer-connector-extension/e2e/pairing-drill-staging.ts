import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { BrowserContext } from "@playwright/test";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import {
  deployedRequiredIssues,
  PairingDrillRefusal,
  providerEnvironmentPattern,
  runPairingDrill,
  type DeployedPairingDrillInput,
  type DeployedPairingDrillReceipt,
  type PairingDrillDeployBinding,
  type PairingDrillPreflightRow,
  type PairingDrillRefusalCode,
  type PairingDrillResolver,
} from "./pairing-drill";

const stagingOrigin = linkIntentOrigins["marketplace-web"].staging;
const productionOrigin = linkIntentOrigins["marketplace-web"].production;
const authorizePath = "/channel-connector/oauth/authorize";
const valueFlags = [
  "--deploy-run",
  "--deploy-commit",
  "--platform-origin",
  "--client-id",
  "--artifact-digest",
  "--persona-alias",
] as const;
const pairingFlags = ["--client-id", "--artifact-digest", "--persona-alias"] as const;
const probeTimeoutMs = 10_000;

export type StagingDrillArgs = Readonly<{
  smoke: boolean;
  deployRun: string;
  deployCommit: string;
  platformOrigin: string;
  clientId?: string;
  artifactDigest?: string;
  personaAlias?: string;
}>;
export type DeployBindingRequest = Readonly<{
  run: string;
  commit: string;
  requiredIssues: readonly number[];
  requireReceiptFloor: boolean;
}>;
export type DeployBindingResult = Readonly<{ binding: PairingDrillDeployBinding } | { stop: string }>;
export type StagingDrillPorts = Readonly<{
  /** The delivery-owned deploy-authority adapter: product code never reads GitHub itself. */
  resolveDeployBinding(request: DeployBindingRequest): Promise<DeployBindingResult>;
  /** Persona sign-in; absent until staging persona sign-in wires it, so a pairing run refuses before any read. */
  signIn?: (context: BrowserContext, personaAlias: string) => Promise<void>;
  dist: string;
  outputDir: string;
  /** Fake seam only; the composed staging command never supplies one. */
  resolver?: PairingDrillResolver;
  fakeDocuments?: DeployedPairingDrillInput["fakeDocuments"];
  secretMarkers?: readonly string[];
  /** Test seams: an active trace, and the profile's launcher. */
  traceActive?: boolean;
  launch?: DeployedPairingDrillInput["launch"];
}>;

const refusal = (code: PairingDrillRefusalCode, deployStop?: string) =>
  new PairingDrillRefusal(code, {
    forwardCount: 0,
    forwards: [],
    requests: [],
    lifecycle: [],
    ...(deployStop ? { deployStop } : {}),
  });

/** `--smoke` takes the deploy and origin inputs only; a pairing run takes all six. */
export function parseStagingDrillArgs(argv: readonly string[]): StagingDrillArgs {
  const values = new Map<string, string>();
  let smoke = false;
  for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--smoke" && !smoke) {
      smoke = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      !(valueFlags as readonly string[]).includes(token) ||
      values.has(token) ||
      value === undefined ||
      value.startsWith("--")
    )
      throw refusal("connector-drill-input-incomplete");
    values.set(token, value);
    index++;
  }
  const platformOrigin = values.get("--platform-origin");
  if (platformOrigin === productionOrigin) throw refusal("connector-drill-production-origin-refused");
  const deployRun = values.get("--deploy-run") ?? "";
  const deployCommit = values.get("--deploy-commit") ?? "";
  if (
    !platformOrigin ||
    !/^[1-9]\d{0,19}$/.test(deployRun) ||
    !/^[a-f0-9]{40}$/.test(deployCommit) ||
    pairingFlags.some((flag) => values.has(flag) === smoke)
  )
    throw refusal("connector-drill-input-incomplete");
  if (platformOrigin !== stagingOrigin) throw refusal("connector-drill-platform-origin-refused");
  return {
    smoke,
    deployRun,
    deployCommit,
    platformOrigin,
    clientId: values.get("--client-id"),
    artifactDigest: values.get("--artifact-digest"),
    personaAlias: values.get("--persona-alias"),
  };
}

type Probe = Readonly<{ status: number; contentType: string | null; location: string | null; body: string }>;

/** One unauthenticated GET that never follows a redirect; the fake seam alone may resolve and trust the host. */
function probe(url: URL, resolver?: PairingDrillResolver) {
  const lookup = ((_hostname, options, callback) =>
    options.all
      ? callback(null, [{ address: resolver!.address, family: 4 }])
      : callback(null, resolver!.address, 4)) as LookupFunction;
  return new Promise<Probe>((resolve) => {
    const unreachable = { status: 0, contentType: null, location: null, body: "" };
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: { accept: "application/json" },
        timeout: probeTimeoutMs,
        ...(resolver ? { port: resolver.port, ca: resolver.certificatePem, lookup } : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 65_536) body += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"] ?? null,
            location: response.headers.location ?? null,
            body,
          }),
        );
        response.on("error", () => resolve(unreachable));
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(unreachable));
    request.end();
  });
}

/**
 * The edge rows carried verbatim from the deployed drill's preflight: the unauthenticated authorize mount, the registered client's
 * no-follow refusal to the pinned callback, and an unregistered client's 400. Each records host, path, status,
 * content type and body code; a redirect records only its host and `error_description`.
 */
export async function stagingPreflightRows(
  platformOrigin: string,
  clientId: string,
  resolver?: PairingDrillResolver,
): Promise<PairingDrillPreflightRow[]> {
  const host = new URL(platformOrigin).host;
  const authorize = (client?: string) => {
    const url = new URL(authorizePath, platformOrigin);
    if (client) {
      const verifier = randomBytes(32).toString("base64url");
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: client,
        redirect_uri: TCGPLAYER_CONNECTOR_REDIRECT_URI,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: randomBytes(32).toString("base64url"),
      }).toString();
    }
    return url;
  };
  const row = (name: PairingDrillPreflightRow["row"], response: Probe): PairingDrillPreflightRow => {
    let location: URL | null = null;
    let body: unknown;
    try {
      location = response.location ? new URL(response.location, platformOrigin) : null;
    } catch {
      location = null;
    }
    try {
      body = JSON.parse(response.body);
    } catch {
      body = undefined;
    }
    return {
      row: name,
      host,
      path: authorizePath,
      status: response.status,
      contentType: response.contentType,
      bodyCode:
        body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null,
      locationHost: location?.host ?? null,
      errorDescription: location?.searchParams.get("error_description") ?? null,
    };
  };
  return [
    row("mount", await probe(authorize(), resolver)),
    row("client", await probe(authorize(clientId), resolver)),
    row("unregistered-client", await probe(authorize(`cc_client_${randomUUID()}`), resolver)),
  ];
}

/**
 * The `pairing-drill:staging` command: parse, refuse a provider environment or an unavailable sign-in, bind the
 * deploy through the injected adapter, run the edge rows, then hand the deployed-origin drill its inputs.
 */
export async function runStagingDrill(argv: readonly string[], ports: StagingDrillPorts) {
  const args = parseStagingDrillArgs(argv);
  if (ports.fakeDocuments && !ports.resolver) throw refusal("connector-drill-page-status");
  if (Object.keys(process.env).some((key) => providerEnvironmentPattern.test(key)))
    throw refusal("connector-drill-provider-environment-refused");
  const { signIn } = ports;
  if (!args.smoke && !signIn) throw refusal("connector-drill-sign-in-unavailable");
  const bound = await ports.resolveDeployBinding({
    run: args.deployRun,
    commit: args.deployCommit,
    requiredIssues: deployedRequiredIssues[args.smoke ? "smoke" : "pairing"],
    requireReceiptFloor: !args.smoke,
  });
  if (!("binding" in bound)) throw refusal("connector-drill-deploy-binding-refused", bound.stop);
  const rows = args.smoke ? [] : await stagingPreflightRows(args.platformOrigin, args.clientId!, ports.resolver);
  return runPairingDrill({
    mode: "deployed",
    smoke: args.smoke,
    platformOrigin: args.platformOrigin,
    deployRun: args.deployRun,
    deployCommit: args.deployCommit,
    preflight: { deploy: bound.binding, rows },
    dist: ports.dist,
    clientId: args.clientId,
    artifactDigest: args.artifactDigest,
    personaAlias: args.personaAlias,
    signIn: signIn && args.personaAlias ? (context) => signIn(context, args.personaAlias!) : undefined,
    resolver: ports.resolver,
    fakeDocuments: ports.fakeDocuments,
    secretMarkers: ports.secretMarkers,
    outputDir: ports.outputDir,
    traceActive: ports.traceActive,
    launch: ports.launch,
  });
}

/** The redacted receipt comment; only a run against deployed staging, never the fake seam, may produce one. */
export function stagingReceiptComment(receipt: DeployedPairingDrillReceipt) {
  if (receipt.origin !== "staging") throw new Error("connector-drill-fake-receipt-refused");
  return [`### ${receipt.kind} receipt`, "", "```json", JSON.stringify(receipt, null, 2), "```", ""].join("\n");
}
