import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const defaultCacheDir = path.join(rootDir, "artifacts", "remote-dev");
const templateDir = path.join(rootDir, "infrastructure", "remote-dev");
const helperTemplatePath = path.join(templateDir, "remote-session.sh");
const caddyTemplatePath = path.join(templateDir, "Caddyfile.template");
const cloudInitTemplatePath = path.join(templateDir, "cloud-init.yml");

export const remoteDevDefaults = {
  region: "nyc3",
  size: "s-2vcpu-4gb",
  image: "ubuntu-24-04-x64",
  ttlHours: 48,
  sshUser: "codex",
  sessionLimitWarning: 3,
  baseTag: "chase-sets-remote-dev",
  namePrefix: "chase-sets-dev",
  repoDir: "/opt/chase-sets/app",
  remoteEnvPath: "/etc/chase-sets/remote-dev.env",
  providerMode: "fake",
};

const serviceHosts = {
  portal: 6170,
  marketplace: 6173,
  admin: 6172,
  api: 6182,
};

const webhookPathPrefixes = [
  "/api/payments/provider/webhooks",
  "/api/settlement/provider/money-movement/webhooks",
];

const persistedEnvKeys = [
  "DIGITALOCEAN_ACCESS_TOKEN",
  "REMOTE_DEV_DOMAIN",
  "REMOTE_DEV_DNS_ZONE",
  "REMOTE_DEV_SSH_KEY_ID",
  "REMOTE_DEV_SSH_PUBLIC_KEY_PATH",
  "REMOTE_DEV_SSH_USER",
  "REMOTE_DEV_SSH_CIDR",
  "REMOTE_DEV_REGION",
  "REMOTE_DEV_SIZE",
  "REMOTE_DEV_IMAGE",
  "REMOTE_DEV_TTL_HOURS",
  "REMOTE_DEV_BASIC_AUTH_USER",
  "REMOTE_DEV_BASIC_AUTH_PASSWORD",
  "REMOTE_DEV_BASIC_AUTH_HASH",
  "REMOTE_DEV_CADDY_EMAIL",
  "REMOTE_DEV_SECRET_ENV_PATH",
];

function printUsage() {
  console.log(`Usage:
  pnpm run remote-dev -- create [--dry-run] [--name <slug>] [--branch <branch>]
  pnpm run remote-dev -- list
  pnpm run remote-dev -- status <slug>
  pnpm run remote-dev -- ssh <slug>
  pnpm run remote-dev -- open <slug> [service]
  pnpm run remote-dev -- sync <slug>
  pnpm run remote-dev -- sync-from <slug>
  pnpm run remote-dev -- up <slug> [--observability]
  pnpm run remote-dev -- preview <slug> [--observability]
  pnpm run remote-dev -- logs <slug> [service]
  pnpm run remote-dev -- reset-db <slug>
  pnpm run remote-dev -- renew <slug> [--ttl-hours <hours>]
  pnpm run remote-dev -- destroy <slug> [--dry-run] [--force]
  pnpm run remote-dev -- prune-expired [--dry-run] [--force]
  pnpm run remote-dev -- observability <slug> <up|down|open>

Required for create:
  DIGITALOCEAN_ACCESS_TOKEN
  REMOTE_DEV_DOMAIN
  REMOTE_DEV_DNS_ZONE, optional when different from REMOTE_DEV_DOMAIN
  REMOTE_DEV_SSH_KEY_ID or REMOTE_DEV_SSH_PUBLIC_KEY_PATH
  REMOTE_DEV_BASIC_AUTH_USER and either REMOTE_DEV_BASIC_AUTH_HASH or REMOTE_DEV_BASIC_AUTH_PASSWORD
`);
}

export function parseArgs(argv) {
  const command = argv[0] ?? "help";
  const positionals = [];
  const flags = {};

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const flag = arg.slice(2);
    const equalsIndex = flag.indexOf("=");
    if (equalsIndex !== -1) {
      flags[flag.slice(0, equalsIndex)] = flag.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[flag] = true;
      continue;
    }

    flags[flag] = next;
    index += 1;
  }

  return { command, positionals, flags };
}

export function sanitizeSlugPart(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42) || "session";
}

export function createSessionSlug({ branch, sha, random = randomSuffix() }) {
  const branchPart = sanitizeSlugPart(branch);
  const shaPart = sanitizeSlugPart(sha).slice(0, 8) || "git";
  const randomPart = sanitizeSlugPart(random).slice(0, 6) || randomSuffix();
  return `${branchPart}-${shaPart}-${randomPart}`.slice(0, 63).replace(/-$/g, "");
}

export function resolveExpiresAt(now = new Date(), ttlHours = remoteDevDefaults.ttlHours) {
  const hours = Number(ttlHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("--ttl-hours must be a positive number.");
  }

  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

export function createSessionTags({ slug, branch, expiresAt }) {
  return [
    remoteDevDefaults.baseTag,
    `rd-slug:${slug}`,
    `rd-exp:${Math.floor(expiresAt.getTime() / 1000)}`,
    `rd-branch:${sanitizeSlugPart(branch).slice(0, 40)}`,
  ];
}

export function normalizeDomain(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

export function resolveSessionUrls(slug, domain) {
  const normalizedDomain = normalizeDomain(domain);
  return Object.fromEntries(
    Object.keys(serviceHosts).map((service) => [
      service,
      `https://${service}.${slug}.${normalizedDomain}`,
    ]),
  );
}

export function resolveDnsRecordNames(slug, domain, dnsZone = domain) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedZone = normalizeDomain(dnsZone);
  const rootName = relativeDnsRecordName(`${slug}.${normalizedDomain}`, normalizedZone);
  return {
    root: rootName,
    wildcard: `*.${rootName}`,
  };
}

function relativeDnsRecordName(fqdn, dnsZone) {
  const normalizedFqdn = normalizeDomain(fqdn);
  const normalizedZone = normalizeDomain(dnsZone);
  if (normalizedFqdn === normalizedZone) {
    return "@";
  }
  if (normalizedFqdn.endsWith(`.${normalizedZone}`)) {
    return normalizedFqdn.slice(0, -normalizedZone.length - 1);
  }
  throw new Error(`${normalizedFqdn} is not inside DNS zone ${normalizedZone}.`);
}

export function buildCaddyfile({
  slug,
  domain,
  basicAuthUser,
  basicAuthHash,
  email,
  apiPort = serviceHosts.api,
}) {
  const normalizedDomain = normalizeDomain(domain);
  const authUser = assertNonBlank(basicAuthUser, "REMOTE_DEV_BASIC_AUTH_USER");
  const authHash = assertNonBlank(basicAuthHash, "REMOTE_DEV_BASIC_AUTH_HASH");
  const emailLine = email ? `\n  email ${email}` : "";
  const webhookMatchers = webhookPathPrefixes
    .map((prefix, index) => `@webhook${index + 1} path ${prefix} ${prefix}/*`)
    .join("\n");
  const webhookHandlers = webhookPathPrefixes
    .map((_prefix, index) => `  reverse_proxy @webhook${index + 1} 127.0.0.1:${apiPort}`)
    .join("\n");

  return `{
  auto_https on${emailLine}
}

(remote_auth) {
  basicauth {
    ${authUser} ${authHash}
  }
}

(api_proxy) {
${webhookMatchers}
${webhookHandlers}

  handle /api/* {
    import remote_auth
    reverse_proxy 127.0.0.1:${apiPort}
  }
}

portal.${slug}.${normalizedDomain} {
  import remote_auth
  reverse_proxy 127.0.0.1:${serviceHosts.portal}
}

marketplace.${slug}.${normalizedDomain} {
  import api_proxy
  import remote_auth
  reverse_proxy 127.0.0.1:${serviceHosts.marketplace}
}

admin.${slug}.${normalizedDomain} {
  import api_proxy
  import remote_auth
  reverse_proxy 127.0.0.1:${serviceHosts.admin}
}

api.${slug}.${normalizedDomain} {
  import api_proxy
  import remote_auth
  reverse_proxy 127.0.0.1:${apiPort}
}
`;
}

export function buildCloudInit({
  sshPublicKey,
  helperScript,
  sessionSlug,
  expiresAt,
}) {
  return readTemplate(cloudInitTemplatePath)
    .replaceAll("{{SSH_PUBLIC_KEY}}", indentYamlScalar(assertNonBlank(sshPublicKey, "SSH public key"), 6))
    .replaceAll("{{REMOTE_HELPER_B64}}", Buffer.from(helperScript, "utf8").toString("base64"))
    .replaceAll("{{SESSION_SLUG}}", sessionSlug)
    .replaceAll("{{EXPIRES_AT}}", expiresAt.toISOString());
}

export function buildSessionEnv({
  domain,
  slug,
  providerMode = remoteDevDefaults.providerMode,
  extraEnv = {},
}) {
  const urls = resolveSessionUrls(slug, domain);
  const base = {
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/chase_sets",
    POSTGRES_DEV_ADMIN_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/postgres",
    POSTGRES_DEV_DATABASE_NAME: "chase_sets",
    PLATFORM_CONTROL_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/chase_sets",
    PORT: "6182",
    DEPLOYMENT_ENVIRONMENT: "remote-dev",
    OBSERVABILITY_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    LOG_LEVEL: "info",
    LOG_FILE_PATH: "../../artifacts/observability/platform-api.jsonl",
    REMOTE_DEV_SESSION_SLUG: slug,
    REMOTE_DEV_DOMAIN: normalizeDomain(domain),
    REMOTE_DEV_PROVIDER_MODE: providerMode,
    STRIPE_CONNECT_RETURN_URL: `${urls.marketplace}/account/payouts`,
    STRIPE_CONNECT_REFRESH_URL: `${urls.marketplace}/account/payouts/setup`,
    STRIPE_WEBHOOK_FORWARD_URL: "http://host.docker.internal:6182/api/payments/provider/webhooks",
  };

  return formatEnvFile({ ...base, ...extraEnv });
}

export function buildCreatePlan(config) {
  const domain = normalizeDomain(config.domain);
  const dnsZone = normalizeDomain(config.dnsZone ?? domain);
  const dnsRecords = resolveDnsRecordNames(config.slug, domain, dnsZone);
  const slug = assertNonBlank(config.slug, "session slug");
  const name = dropletName(slug);
  const tags = createSessionTags({
    slug,
    branch: config.branch,
    expiresAt: config.expiresAt,
  });
  const tagNames = tags.join(",");
  const sshKey = assertNonBlank(config.sshKeyId, "REMOTE_DEV_SSH_KEY_ID");
  const firewallName = firewallNameForSlug(slug);

  return [
    {
      label: "Create remote-dev base tag",
      command: "doctl",
      args: ["compute", "tag", "create", remoteDevDefaults.baseTag],
      allowFailure: true,
    },
    ...tags.slice(1).map((tag) => ({
      label: `Create session tag ${tag}`,
      command: "doctl",
      args: ["compute", "tag", "create", tag],
      allowFailure: true,
    })),
    {
      label: "Create cloud firewall",
      command: "doctl",
      args: [
        "compute",
        "firewall",
        "create",
        "--name",
        firewallName,
        "--tag-names",
        tagNames,
        "--inbound-rules",
        `protocol:tcp,ports:22,address:${config.sshCidr ?? "0.0.0.0/0"},address:::/0`,
        "--inbound-rules",
        "protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0",
        "--inbound-rules",
        "protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0",
        "--outbound-rules",
        "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0",
        "--outbound-rules",
        "protocol:udp,ports:all,address:0.0.0.0/0,address:::/0",
        "--outbound-rules",
        "protocol:icmp,address:0.0.0.0/0,address:::/0",
      ],
    },
    {
      label: "Create Droplet",
      command: "doctl",
      args: [
        "compute",
        "droplet",
        "create",
        name,
        "--region",
        config.region,
        "--image",
        config.image,
        "--size",
        config.size,
        "--ssh-keys",
        sshKey,
        "--tag-names",
        tagNames,
        "--user-data-file",
        config.userDataPath,
        "--wait",
        "--format",
        "ID,Name,PublicIPv4,Status",
        "--no-header",
      ],
    },
    {
      label: "Create root DNS record",
      command: "doctl",
      args: [
        "compute",
        "domain",
        "records",
        "create",
        dnsZone,
        "--record-type",
        "A",
        "--record-name",
        dnsRecords.root,
        "--record-data",
        config.publicIpPlaceholder ?? "<droplet-ip>",
        "--record-ttl",
        "60",
      ],
    },
    {
      label: "Create wildcard DNS record",
      command: "doctl",
      args: [
        "compute",
        "domain",
        "records",
        "create",
        dnsZone,
        "--record-type",
        "A",
        "--record-name",
        dnsRecords.wildcard,
        "--record-data",
        config.publicIpPlaceholder ?? "<droplet-ip>",
        "--record-ttl",
        "60",
      ],
    },
  ];
}

export function buildDestroyPlan({ slug, domain, dnsZone = domain, dropletId, dnsRecordIds = [], firewallId }) {
  const steps = [];
  if (dropletId) {
    steps.push({
      label: "Delete Droplet",
      command: "doctl",
      args: ["compute", "droplet", "delete", String(dropletId), "--force"],
    });
  }

  for (const recordId of dnsRecordIds) {
    steps.push({
      label: `Delete DNS record ${recordId}`,
      command: "doctl",
      args: ["compute", "domain", "records", "delete", normalizeDomain(dnsZone), String(recordId), "--force"],
    });
  }

  if (firewallId) {
    steps.push({
      label: "Delete cloud firewall",
      command: "doctl",
      args: ["compute", "firewall", "delete", String(firewallId), "--force"],
    });
  }

  for (const tag of [`rd-slug:${slug}`]) {
    steps.push({
      label: `Delete session tag ${tag}`,
      command: "doctl",
      args: ["compute", "tag", "delete", tag, "--force"],
      allowFailure: true,
    });
  }

  return steps;
}

export function selectExpiredSessions(sessions, now = new Date()) {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return sessions.filter((session) => {
    const expiresAt = session.tags
      ?.find((tag) => String(tag).startsWith("rd-exp:"))
      ?.split(":")[1];
    const expiresAtSeconds = Number(expiresAt);
    return Number.isFinite(expiresAtSeconds) && expiresAtSeconds <= nowSeconds;
  });
}

export function toSshRepoUrl(remoteUrl) {
  const value = String(remoteUrl ?? "").trim();
  const httpsMatch = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return `git@github.com:${httpsMatch[1]}/${httpsMatch[2]}.git`;
  }

  return value;
}

async function main() {
  hydratePersistedEnvironment();
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  try {
    if (command === "help" || command === "--help" || command === "-h") {
      printUsage();
      return;
    }

    await runCli(command, positionals, flags);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function hydratePersistedEnvironment() {
  if (process.platform !== "win32") {
    return;
  }

  for (const key of persistedEnvKeys) {
    if (process.env[key]) {
      continue;
    }

    const value = readWindowsUserEnvironmentValue(key);
    if (value) {
      process.env[key] = value;
    }
  }
}

function readWindowsUserEnvironmentValue(key) {
  const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", key], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return "";
  }

  const line = result.stdout
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(key));
  if (!line) {
    return "";
  }

  return line.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s+REG_\\w+\\s+`), "").trim();
}

async function runCli(command, positionals, flags) {
  switch (command) {
    case "create":
      await createSession(flags);
      break;
    case "list":
      await listSessions();
      break;
    case "status":
      await statusSession(requiredSlug(positionals));
      break;
    case "ssh":
      await sshSession(requiredSlug(positionals), positionals.slice(1));
      break;
    case "open":
      await openSession(requiredSlug(positionals), positionals[1] ?? "portal");
      break;
    case "sync":
      await syncToSession(requiredSlug(positionals), flags);
      break;
    case "sync-from":
      await syncFromSession(requiredSlug(positionals), flags);
      break;
    case "up":
      await remoteHelperCommand(requiredSlug(positionals), ["up", "dev", flags.observability ? "--observability" : ""]);
      break;
    case "preview":
      await remoteHelperCommand(requiredSlug(positionals), ["up", "preview", flags.observability ? "--observability" : ""]);
      break;
    case "logs":
      await remoteHelperCommand(requiredSlug(positionals), ["logs", positionals[1] ?? "all"]);
      break;
    case "reset-db":
      await remoteHelperCommand(requiredSlug(positionals), ["reset-db"]);
      break;
    case "renew":
      await renewSession(requiredSlug(positionals), flags);
      break;
    case "destroy":
      await destroySession(requiredSlug(positionals), flags);
      break;
    case "prune-expired":
      await pruneExpired(flags);
      break;
    case "observability":
      await remoteHelperCommand(requiredSlug(positionals), ["observability", positionals[1] ?? "up"]);
      break;
    default:
      printUsage();
      throw new Error(`Unknown remote-dev command "${command}".`);
  }
}

async function createSession(flags) {
  const dryRun = Boolean(flags["dry-run"]);
  const env = loadEnvConfig(flags);
  validateCreateEnvironment(env, { dryRun });
  const branch = String(flags.branch ?? currentBranch());
  const sha = currentSha();
  const slug = sanitizeSlugPart(flags.name ?? createSessionSlug({ branch, sha }));
  const expiresAt = resolveExpiresAt(new Date(), flags["ttl-hours"] ?? env.ttlHours);
  const sshPublicKey = readSshPublicKey(env.sshPublicKeyPath, { dryRun });
  const helperScript = readTemplate(helperTemplatePath);
  const userData = buildCloudInit({ sshPublicKey, helperScript, sessionSlug: slug, expiresAt });
  const sessionDir = ensureSessionDir(slug);
  const userDataPath = path.join(sessionDir, "cloud-init.yml");
  const caddyFilePath = path.join(sessionDir, "Caddyfile");
  const remoteEnvPath = path.join(sessionDir, "remote-dev.env");
  const basicAuthHash = await resolveBasicAuthHash(env, { dryRun });
  const extraEnv = readOptionalEnvFile(env.secretEnvPath);
  const caddyFile = buildCaddyfile({
    slug,
    domain: env.domain,
    basicAuthUser: env.basicAuthUser,
    basicAuthHash,
    email: env.caddyEmail,
  });
  const remoteEnv = buildSessionEnv({
    slug,
    domain: env.domain,
    providerMode: flags["stripe-test"] ? "stripe-test" : remoteDevDefaults.providerMode,
    extraEnv,
  });

  writeFileSync(userDataPath, userData, "utf8");
  writeFileSync(caddyFilePath, caddyFile, "utf8");
  writeFileSync(remoteEnvPath, remoteEnv, "utf8");

  const activeSessions = dryRun ? [] : await fetchSessions();
  if (activeSessions.length >= remoteDevDefaults.sessionLimitWarning && !flags.force) {
    console.warn(
      `There are ${activeSessions.length} active remote-dev sessions. Re-run with --force if this is intentional.`,
    );
    process.exitCode = 1;
    return;
  }

  const planConfig = {
    slug,
    branch,
    expiresAt,
    region: String(flags.region ?? env.region),
    size: String(flags.size ?? env.size),
    image: String(flags.image ?? env.image),
    domain: env.domain,
    dnsZone: env.dnsZone,
    sshKeyId: env.sshKeyId,
    sshCidr: flags["ssh-cidr"] ?? env.sshCidr,
    userDataPath,
  };
  const plan = buildCreatePlan(planConfig);
  printPlan(`Create remote-dev session ${slug}`, plan);

  if (dryRun) {
    printSessionSummary({ slug, domain: env.domain, expiresAt });
    return;
  }

  await assertPrerequisites(["doctl", "ssh", "git", "pnpm"]);
  await runPlan(plan.slice(0, -2));
  const droplet = await fetchSession(slug);
  const publicIp = droplet?.publicIp;
  if (!publicIp) {
    throw new Error(`Droplet ${dropletName(slug)} was created, but no public IPv4 address was found.`);
  }

  await runPlan(
    buildCreatePlan({ ...planConfig, publicIpPlaceholder: publicIp }).slice(-2),
  );
  await waitForSsh(publicIp, env.sshUser);
  await installRemoteSession({ slug, env, publicIp, caddyFilePath, remoteEnvPath, branch });
  writeSessionCache(slug, {
    slug,
    domain: normalizeDomain(env.domain),
    dnsZone: normalizeDomain(env.dnsZone),
    branch,
    sha,
    publicIp,
    expiresAt: expiresAt.toISOString(),
    urls: resolveSessionUrls(slug, env.domain),
  });
  printSessionSummary({ slug, domain: env.domain, expiresAt, publicIp });
}

async function listSessions() {
  const sessions = await fetchSessions();
  if (sessions.length === 0) {
    console.log("No remote-dev sessions found.");
    return;
  }

  for (const session of sessions) {
    const expiresAt = session.tags.find((tag) => tag.startsWith("rd-exp:"))?.split(":")[1];
    const expiresText = expiresAt ? new Date(Number(expiresAt) * 1000).toISOString() : "unknown";
    console.log(`${session.slug.padEnd(44)} ${String(session.status).padEnd(10)} ${session.publicIp ?? "-"} expires ${expiresText}`);
  }
}

async function statusSession(slug) {
  const session = await fetchSession(slug);
  if (!session) {
    throw new Error(`No remote-dev session found for ${slug}.`);
  }

  console.log(JSON.stringify(session, null, 2));
}

async function sshSession(slug, extraArgs) {
  const session = await requireSession(slug);
  const env = loadEnvConfig({});
  const args = sshArgs(env.sshUser, session.publicIp, extraArgs);
  await runInteractive("ssh", args);
}

async function openSession(slug, service) {
  const env = loadEnvConfig({});
  const urls = resolveSessionUrls(slug, env.domain);
  const url = urls[service] ?? urls.portal;
  const opener = process.platform === "win32" ? ["cmd", ["/d", "/s", "/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
      : ["xdg-open", [url]];
  await runInteractive(opener[0], opener[1]);
}

async function syncToSession(slug, flags) {
  const session = await requireSession(slug);
  const env = loadEnvConfig(flags);
  const excludes = [
    ".git",
    "node_modules",
    "artifacts",
    "coverage",
    ".react-router",
    "build",
    "dist",
  ];
  const excludeArgs = excludes.flatMap((entry) => ["--exclude", entry]);
  await runInteractive("rsync", [
    "-az",
    "--delete",
    ...excludeArgs,
    `${rootDir.replaceAll("\\", "/")}/`,
    `${env.sshUser}@${session.publicIp}:${remoteDevDefaults.repoDir}/`,
  ]);
}

async function syncFromSession(slug, flags) {
  const session = await requireSession(slug);
  const env = loadEnvConfig(flags);
  const target = flags.target ? path.resolve(String(flags.target)) : path.join(defaultCacheDir, `${slug}-sync-from`);
  mkdirSync(target, { recursive: true });
  await runInteractive("rsync", [
    "-az",
    `${env.sshUser}@${session.publicIp}:${remoteDevDefaults.repoDir}/`,
    `${target.replaceAll("\\", "/")}/`,
  ]);
  console.log(`Synced ${slug} into ${target}`);
}

async function remoteHelperCommand(slug, helperArgs) {
  const session = await requireSession(slug);
  const env = loadEnvConfig({});
  await runInteractive("ssh", sshArgs(env.sshUser, session.publicIp, [
    "sudo",
    "/usr/local/bin/chase-sets-remote-dev",
    ...helperArgs.filter(Boolean),
  ]));
}

async function renewSession(slug, flags) {
  const session = await requireSession(slug);
  const expiresAt = resolveExpiresAt(new Date(), flags["ttl-hours"] ?? remoteDevDefaults.ttlHours);
  const tag = `rd-exp:${Math.floor(expiresAt.getTime() / 1000)}`;
  await runPlan([
    {
      label: `Create renewed expiration tag ${tag}`,
      command: "doctl",
      args: ["compute", "tag", "create", tag],
      allowFailure: true,
    },
    {
      label: "Attach renewed expiration tag",
      command: "doctl",
      args: ["compute", "droplet", "tag", String(session.id), "--tag-name", tag],
    },
  ], Boolean(flags["dry-run"]));
}

async function destroySession(slug, flags) {
  const dryRun = Boolean(flags["dry-run"]);
  const env = loadEnvConfig(flags);
  const session = dryRun ? { id: "<droplet-id>", slug } : await requireSession(slug);
  const dnsRecordIds = dryRun ? ["<root-record-id>", "<wildcard-record-id>"] : await findDnsRecordIds(slug, env.domain, env.dnsZone);
  const firewallId = dryRun ? "<firewall-id>" : await findFirewallId(slug);
  const plan = buildDestroyPlan({
    slug,
    domain: env.domain,
    dnsZone: env.dnsZone,
    dropletId: session.id,
    dnsRecordIds,
    firewallId,
  });
  printPlan(`Destroy remote-dev session ${slug}`, plan);

  if (dryRun) {
    return;
  }

  if (!flags.force) {
    console.log("Destroying a session deletes its Droplet and DNS records. Re-run with --force to confirm.");
    process.exitCode = 1;
    return;
  }

  await runPlan(plan);
}

async function pruneExpired(flags) {
  const dryRun = Boolean(flags["dry-run"]);
  const sessions = dryRun
    ? [{ slug: "expired-example", id: "<droplet-id>", tags: ["rd-exp:1"] }]
    : await fetchSessions();
  const expired = selectExpiredSessions(sessions);
  if (expired.length === 0) {
    console.log("No expired remote-dev sessions found.");
    return;
  }

  for (const session of expired) {
    await destroySession(session.slug, { ...flags, force: flags.force ?? dryRun });
  }
}

async function installRemoteSession({ slug, env, publicIp, caddyFilePath, remoteEnvPath, branch }) {
  await runInteractive("scp", [caddyFilePath, `${env.sshUser}@${publicIp}:/tmp/chase-sets-Caddyfile`]);
  await runInteractive("scp", [remoteEnvPath, `${env.sshUser}@${publicIp}:/tmp/chase-sets-remote-dev.env`]);
  const repoUrl = toSshRepoUrl(currentRemoteUrl());
  await runInteractive("ssh", [
    "-A",
    ...sshArgs(env.sshUser, publicIp, [
      "sudo",
      "--preserve-env=SSH_AUTH_SOCK",
      "/usr/local/bin/chase-sets-remote-dev",
      "bootstrap",
      repoUrl,
      branch,
      slug,
    ]),
  ]);
}

async function fetchSessions() {
  const result = runJson("doctl", [
    "compute",
    "droplet",
    "list",
    "--tag-name",
    remoteDevDefaults.baseTag,
    "--output",
    "json",
  ]);
  return result.map(mapDroplet);
}

async function fetchSession(slug) {
  const sessions = await fetchSessions();
  return sessions.find((session) => session.slug === slug || session.name === dropletName(slug)) ?? null;
}

async function requireSession(slug) {
  const session = await fetchSession(slug);
  if (!session?.publicIp) {
    throw new Error(`No reachable remote-dev session found for ${slug}.`);
  }
  return session;
}

async function findDnsRecordIds(slug, domain, dnsZone = domain) {
  const dnsRecords = resolveDnsRecordNames(slug, domain, dnsZone);
  const records = runJson("doctl", [
    "compute",
    "domain",
    "records",
    "list",
    normalizeDomain(dnsZone),
    "--output",
    "json",
  ]);
  return records
    .filter((record) =>
      record.type === "A" && (record.name === dnsRecords.root || record.name === dnsRecords.wildcard),
    )
    .map((record) => record.id);
}

async function findFirewallId(slug) {
  const firewalls = runJson("doctl", ["compute", "firewall", "list", "--output", "json"]);
  return firewalls.find((firewall) => firewall.name === firewallNameForSlug(slug))?.id ?? null;
}

function mapDroplet(droplet) {
  const tags = droplet.tags ?? [];
  const slug =
    tags.find((tag) => String(tag).startsWith("rd-slug:"))?.split(":").slice(1).join(":")
    ?? String(droplet.name ?? "").replace(`${remoteDevDefaults.namePrefix}-`, "");
  return {
    id: droplet.id,
    name: droplet.name,
    slug,
    publicIp: droplet.networks?.v4?.find((network) => network.type === "public")?.ip_address
      ?? droplet.public_ipv4
      ?? droplet.PublicIPv4,
    status: droplet.status,
    tags,
  };
}

function loadEnvConfig(flags) {
  return {
    domain: normalizeDomain(flags.domain ?? process.env.REMOTE_DEV_DOMAIN),
    dnsZone: normalizeDomain(flags["dns-zone"] ?? process.env.REMOTE_DEV_DNS_ZONE ?? flags.domain ?? process.env.REMOTE_DEV_DOMAIN),
    sshKeyId: flags["ssh-key-id"] ?? process.env.REMOTE_DEV_SSH_KEY_ID,
    sshPublicKeyPath:
      flags["ssh-public-key-path"]
      ?? process.env.REMOTE_DEV_SSH_PUBLIC_KEY_PATH
      ?? path.join(os.homedir(), ".ssh", "id_ed25519.pub"),
    sshUser: flags["ssh-user"] ?? process.env.REMOTE_DEV_SSH_USER ?? remoteDevDefaults.sshUser,
    sshCidr: flags["ssh-cidr"] ?? process.env.REMOTE_DEV_SSH_CIDR,
    region: flags.region ?? process.env.REMOTE_DEV_REGION ?? remoteDevDefaults.region,
    size: flags.size ?? process.env.REMOTE_DEV_SIZE ?? remoteDevDefaults.size,
    image: flags.image ?? process.env.REMOTE_DEV_IMAGE ?? remoteDevDefaults.image,
    ttlHours: flags["ttl-hours"] ?? process.env.REMOTE_DEV_TTL_HOURS ?? remoteDevDefaults.ttlHours,
    basicAuthUser: flags["basic-auth-user"] ?? process.env.REMOTE_DEV_BASIC_AUTH_USER,
    basicAuthPassword: flags["basic-auth-password"] ?? process.env.REMOTE_DEV_BASIC_AUTH_PASSWORD,
    basicAuthHash: flags["basic-auth-hash"] ?? process.env.REMOTE_DEV_BASIC_AUTH_HASH,
    caddyEmail: flags["caddy-email"] ?? process.env.REMOTE_DEV_CADDY_EMAIL,
    secretEnvPath: flags["secret-env-path"] ?? process.env.REMOTE_DEV_SECRET_ENV_PATH,
  };
}

function validateCreateEnvironment(env, { dryRun }) {
  assertNonBlank(env.domain, "REMOTE_DEV_DOMAIN");
  assertNonBlank(env.dnsZone, "REMOTE_DEV_DNS_ZONE");
  assertNonBlank(env.sshKeyId, "REMOTE_DEV_SSH_KEY_ID");
  assertNonBlank(env.basicAuthUser, "REMOTE_DEV_BASIC_AUTH_USER");
  if (!env.basicAuthHash && !env.basicAuthPassword) {
    throw new Error("REMOTE_DEV_BASIC_AUTH_HASH or REMOTE_DEV_BASIC_AUTH_PASSWORD is required.");
  }
  if (!dryRun) {
    assertNonBlank(process.env.DIGITALOCEAN_ACCESS_TOKEN, "DIGITALOCEAN_ACCESS_TOKEN");
  }
}

async function resolveBasicAuthHash(env, { dryRun }) {
  if (env.basicAuthHash) {
    return env.basicAuthHash;
  }
  if (dryRun) {
    return "$2a$14$dryrunhashdryrunhashdryrunhashdryrunhashdryrunhashdryrunhashdr";
  }

  const result = spawnSync("caddy", ["hash-password", "--plaintext", env.basicAuthPassword], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error("Install Caddy locally or set REMOTE_DEV_BASIC_AUTH_HASH.");
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to hash remote-dev Basic Auth password.");
  }
  return result.stdout.trim();
}

function readOptionalEnvFile(filePath) {
  if (!filePath) {
    return {};
  }
  if (!existsSync(filePath)) {
    throw new Error(`Secret env file not found: ${filePath}`);
  }
  return parseEnv(readFileSync(filePath, "utf8"));
}

function parseEnv(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function formatEnvFile(values) {
  return `${Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${escapeEnvValue(String(value))}`)
    .join("\n")}\n`;
}

function escapeEnvValue(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(" ")} failed.`);
  }
  return JSON.parse(result.stdout || "[]");
}

async function runPlan(plan, dryRun = false) {
  for (const step of plan) {
    if (dryRun) {
      console.log(`DRY RUN: ${formatCommand(step.command, step.args)}`);
      continue;
    }

    const result = spawnSync(step.command, step.args, {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0 && !step.allowFailure) {
      throw new Error(`${step.label} failed.`);
    }
  }
}

function printPlan(title, plan) {
  console.log("");
  console.log(title);
  for (const step of plan) {
    console.log(`  - ${step.label}: ${formatCommand(step.command, step.args)}`);
  }
  console.log("");
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuoteForDisplay).join(" ");
}

function shellQuoteForDisplay(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@*=-]+$/.test(text) ? text : JSON.stringify(text);
}

function runInteractive(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function assertPrerequisites(commands) {
  for (const command of commands) {
    const result = spawnSync(command, ["--version"], {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error) {
      throw new Error(`Required command not found: ${command}`);
    }
  }
}

async function waitForSsh(publicIp, sshUser) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = spawnSync("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${sshUser}@${publicIp}`,
      "true",
    ], {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Timed out waiting for SSH on ${publicIp}.`);
}

function sshArgs(user, host, extraArgs = []) {
  return [
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${user}@${host}`,
    ...extraArgs,
  ];
}

function readSshPublicKey(filePath, { dryRun = false } = {}) {
  if (!existsSync(filePath)) {
    if (dryRun) {
      return "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDryRunRemoteDevPlaceholderKey remote-dev-dry-run";
    }
    throw new Error(`SSH public key not found: ${filePath}`);
  }
  return readFileSync(filePath, "utf8").trim();
}

function readTemplate(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Remote dev template not found: ${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

function ensureSessionDir(slug) {
  const sessionDir = path.join(defaultCacheDir, slug);
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function writeSessionCache(slug, state) {
  writeFileSync(path.join(ensureSessionDir(slug), "session.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function requiredSlug(positionals) {
  if (!positionals[0]) {
    throw new Error("A remote-dev session slug is required.");
  }
  return sanitizeSlugPart(positionals[0]);
}

function dropletName(slug) {
  return `${remoteDevDefaults.namePrefix}-${slug}`;
}

function firewallNameForSlug(slug) {
  return `${remoteDevDefaults.namePrefix}-${slug}-fw`.slice(0, 63);
}

function currentBranch() {
  return runGit(["branch", "--show-current"]) || "detached";
}

function currentSha() {
  return runGit(["rev-parse", "--short", "HEAD"]) || "unknown";
}

function currentRemoteUrl() {
  return runGit(["remote", "get-url", "origin"]);
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function assertNonBlank(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${name} is required.`);
  }
  return text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentYamlScalar(value, spaces) {
  const indent = " ".repeat(spaces);
  return String(value).split(/\r?\n/).join(`\n${indent}`);
}

function printSessionSummary({ slug, domain, expiresAt, publicIp }) {
  const urls = resolveSessionUrls(slug, domain);
  console.log(`Remote dev session: ${slug}`);
  if (publicIp) {
    console.log(`  IP:          ${publicIp}`);
  }
  console.log(`  Expires:     ${expiresAt.toISOString()}`);
  console.log(`  Portal:      ${urls.portal}`);
  console.log(`  Marketplace: ${urls.marketplace}`);
  console.log(`  Admin:       ${urls.admin}`);
  console.log(`  API:         ${urls.api}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
