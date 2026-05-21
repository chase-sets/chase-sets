import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
        return;
      }

      resolve(stdout);
    });
  });
}

async function commandJson(command, args, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)(command, args);
  return JSON.parse(output || "[]");
}

function parseDate(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeTag(tag) {
  return {
    name: tag.tag ?? tag.name ?? tag.Tag ?? tag.Name ?? "",
    digest: tag.digest ?? tag.manifest_digest ?? tag.ManifestDigest ?? "",
    updatedAt: tag.updated_at ?? tag.updatedAt ?? tag.UpdatedAt ?? tag.created_at ?? tag.CreatedAt ?? "",
  };
}

function collectImageTagsFromApp(app) {
  const spec = app.spec ?? app.Spec ?? {};
  const components = [
    ...(spec.services ?? spec.Services ?? []),
    ...(spec.workers ?? spec.Workers ?? []),
    ...(spec.jobs ?? spec.Jobs ?? []),
  ];

  return components
    .map((component) => component.image ?? component.Image)
    .filter(Boolean)
    .map((image) => image.tag ?? image.Tag)
    .filter((tag) => typeof tag === "string" && tag.length > 0);
}

export function selectTagsForDeletion(tags, options = {}) {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? 30;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const protectedTags = new Set(options.protectedTags ?? []);
  const protectedDigests = new Set(options.protectedDigests ?? []);
  const protectedPrefixes = options.protectedPrefixes ?? ["release-"];

  return tags
    .map(normalizeTag)
    .filter((tag) => tag.name)
    .filter((tag) => !protectedTags.has(tag.name))
    .filter((tag) => !tag.digest || !protectedDigests.has(tag.digest))
    .filter((tag) => !protectedPrefixes.some((prefix) => tag.name.startsWith(prefix)))
    .filter((tag) => parseDate(tag.updatedAt) < cutoff)
    .map((tag) => tag.name);
}

export async function fetchProtectedAppTags(appNames, options = {}) {
  if (appNames.length === 0) {
    return [];
  }

  const apps = await commandJson("doctl", ["apps", "list", "--output", "json"], options);
  const selectedApps = apps.filter((app) => {
    const spec = app.spec ?? app.Spec ?? {};
    const name = spec.name ?? spec.Name ?? app.name ?? app.Name;
    return appNames.includes(name);
  });

  const tags = [];
  for (const app of selectedApps) {
    const appId = app.id ?? app.ID;
    if (!appId) {
      tags.push(...collectImageTagsFromApp(app));
      continue;
    }

    const appDetails = await commandJson("doctl", ["apps", "get", appId, "--output", "json"], options);
    const detail = Array.isArray(appDetails) ? appDetails[0] : appDetails;
    tags.push(...collectImageTagsFromApp(detail ?? app));
  }

  return [...new Set(tags)];
}

function readRepeatedOption(argv, name) {
  const prefix = `${name}=`;
  return argv
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length))
    .filter(Boolean);
}

function readOption(argv, name, defaultValue) {
  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? defaultValue;
}

async function cleanup(argv) {
  const repository = readOption(argv, "--repository", "chase-sets-platform");
  const retentionDays = Number.parseInt(readOption(argv, "--retention-days", "30"), 10);
  const dryRun = argv.includes("--dry-run");
  const appNames = readRepeatedOption(argv, "--app-name");
  const protectedTags = [...readRepeatedOption(argv, "--protect-tag"), ...(await fetchProtectedAppTags(appNames))];

  const tags = await commandJson("doctl", ["registry", "repository", "list-tags", repository, "--output", "json"]);
  const deletions = selectTagsForDeletion(tags, { protectedTags, retentionDays });

  if (deletions.length === 0) {
    console.log("No registry tags are eligible for deletion.");
    return;
  }

  for (const tag of deletions) {
    if (dryRun) {
      console.log(`Would delete ${repository}:${tag}`);
      continue;
    }

    console.log(`Deleting ${repository}:${tag}`);
    await commandOutput("doctl", ["registry", "repository", "delete-tag", repository, tag, "--force"]);
  }

  if (dryRun) {
    console.log("Dry run complete; skipping registry garbage collection.");
    return;
  }

  await commandOutput("doctl", ["registry", "garbage-collection", "start", "--force"]);
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "cleanup") {
    await cleanup(args);
    return;
  }

  throw new Error(
    "Usage: node ./scripts/digitalocean-registry-cleanup.mjs cleanup [--repository=<name>] [--retention-days=<days>] [--app-name=<name>] [--protect-tag=<tag>] [--dry-run]",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
