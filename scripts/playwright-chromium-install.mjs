import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { buildPackageManagerInvocation } from "./lib/process.mjs";
import {
  INSTALLER_TIMEOUT_GRACE_MS,
  resolveInstallerIdentity,
  runInstaller,
} from "./provider-browser-install-timeout.mjs";
import { TIMING_RECORD_PREFIX } from "./provider-browser-install-timing.mjs";

export const PLAYWRIGHT_INSTALL_COMMAND = ["exec", "playwright", "install", "--with-deps", "chromium"];
export const PLAYWRIGHT_INSTALL_SITE = "playwright-chromium";
export const PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS = 540;
export const PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS = 570;
export const PLAYWRIGHT_INSTALL_RETRY_DELAY_MS = 5_000;
export const PLAYWRIGHT_NATIVE_FONT_PACKAGES = [
  "fonts-freefont-ttf",
  "fonts-ipafont-gothic",
  "fonts-tlwg-loma-otf",
  "fonts-unifont",
  "fonts-wqy-zenhei",
  "xfonts-cyrillic",
  "xfonts-encodings",
  "xfonts-scalable",
  "xfonts-utils",
];

const aptBounds = 'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "1";\n';
const aptBoundsPath = "/etc/apt/apt.conf.d/99-chase-sets-e2e";
const officialArchive = "https://archive.ubuntu.com/ubuntu";
const officialSecurity = "https://security.ubuntu.com/ubuntu";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function sourceEntries(text, filename) {
  if (filename.endsWith(".sources")) {
    return text
      .split(/\n\s*\n/)
      .filter((block) => /^(?!#)\S/m.test(block))
      .map((block) => {
        const fields = new Map();
        let key;
        for (const line of block.split("\n")) {
          if (!line.trim() || line.startsWith("#")) continue;
          if (/^\s/.test(line) && key) fields.set(key, `${fields.get(key)}\n${line}`);
          else {
            const match = /^([\w-]+):\s*(.*)$/.exec(line);
            if (!match || fields.has(match[1].toLowerCase())) {
              if (/ubuntu-archive-keyring|ubuntu\.com|mirror\+file:/.test(block)) throw new Error("malformed-sources");
              return { block, fields: new Map(), uris: [], suites: [], key: "" };
            }
            key = match[1].toLowerCase();
            fields.set(key, match[2]);
          }
        }
        return {
          block,
          fields,
          uris: (fields.get("uris") ?? "").split(/\s+/),
          suites: (fields.get("suites") ?? "").split(/\s+/),
          key: fields.get("signed-by") ?? "",
        };
      });
  }
  return text
    .split("\n")
    .filter((line) => /^\s*deb(?:-src)?\s/.test(line))
    .map((block) => {
      const match = /^(\s*deb(?:-src)?\s+)(\[[^\]]*\]\s+)?(\S+)\s+(\S+)(.*)$/.exec(block);
      if (!match) throw new Error("malformed-sources");
      return {
        block,
        match,
        uris: [match[3]],
        suites: [match[4]],
        key: /signed-by=([^\s\]]+)/i.exec(match[2] ?? "")?.[1] ?? "",
      };
    });
}

function isUbuntuEntry(entry, mirrors) {
  return (
    /ubuntu-archive-keyring/.test(entry.key) ||
    entry.uris.some((uri) => {
      if (Object.hasOwn(mirrors, uri) && /https?:\/\/(?:[\w.-]+\.)?ubuntu\.com\/ubuntu/.test(mirrors[uri])) return true;
      try {
        return /(^|\.)ubuntu\.com$/.test(new URL(uri).hostname);
      } catch {
        return false;
      }
    })
  );
}

// Classify Azure Ubuntu entries before projection; non-Ubuntu blocks remain byte-identical.
export function projectUbuntuSources({ distribution, release, codename, architecture, sources, mirrors }) {
  if (distribution !== "ubuntu" || release !== "24.04" || codename !== "noble" || architecture !== "X64")
    return { projected: false, sources };
  const mirrorLines = Object.values(mirrors).flatMap((text) =>
    text.split(/\r?\n/).map((line) => line.trim().split(/\s/)[0].replace(/\/$/, "")),
  );
  if (![officialArchive, officialSecurity].every((uri) => mirrorLines.includes(uri)))
    return { projected: false, sources };
  const projected = {};
  let ubuntuCount = 0;
  for (const [filename, text] of Object.entries(sources)) {
    let result = text;
    for (const entry of sourceEntries(text, filename)) {
      if (!isUbuntuEntry(entry, mirrors)) continue;
      ubuntuCount += 1;
      if (
        /\b(?:trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)(?:\s*[:=]\s*)(?:yes|true|1)\b/i.test(
          entry.block,
        )
      )
        throw new Error("trust-bypass");
      if (!entry.uris.every(Boolean) || !entry.suites.every((suite) => /^noble(?:-[\w-]+)?$/.test(suite)))
        throw new Error("malformed-sources");
      const groups = [
        entry.suites.filter((suite) => !suite.endsWith("-security")),
        entry.suites.filter((suite) => suite.endsWith("-security")),
      ];
      const replacement = groups
        .flatMap((suites, index) => {
          if (!suites.length) return [];
          const uri = index ? officialSecurity : officialArchive;
          if (entry.match)
            return [`${entry.match[1]}${entry.match[2] ?? ""}${uri} ${suites.join(" ")}${entry.match[5]}`];
          if (!entry.fields.get("types") || !entry.fields.get("components")) throw new Error("malformed-sources");
          return [
            entry.block
              .replace(/^URIs:[^\n]*(?:\n[ \t]+[^\n]*)*/im, `URIs: ${uri}`)
              .replace(/^Suites:[^\n]*(?:\n[ \t]+[^\n]*)*/im, `Suites: ${suites.join(" ")}`),
          ];
        })
        .join("\n\n");
      result = result.replace(entry.block, replacement);
    }
    projected[filename] = result;
  }
  if (!ubuntuCount) return { projected: false, sources };
  validateUbuntuProjection(sources, projected, mirrors);
  return { projected: true, sources: projected };
}

export function validateUbuntuProjection(original, projected, mirrors) {
  for (const [filename, text] of Object.entries(original)) {
    const before = sourceEntries(text, filename);
    const after = sourceEntries(projected[filename] ?? "", filename);
    const expected = before.flatMap((entry) => entry.suites.map((suite) => ({ entry, suite })));
    const actual = after.flatMap((entry) => entry.suites.map((suite) => ({ entry, suite })));
    if (expected.length !== actual.length) throw new Error("malformed-sources");
    for (const { entry, suite } of expected) {
      const match = actual.find(
        (candidate) =>
          candidate.suite === suite &&
          candidate.entry.key === entry.key &&
          (isUbuntuEntry(entry, mirrors) || candidate.entry.block === entry.block),
      );
      if (!match) throw new Error("projected-key-swap");
      actual.splice(actual.indexOf(match), 1);
      if (!isUbuntuEntry(entry, mirrors)) continue;
      if (
        /\b(?:trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)\s*[:=]\s*(?:yes|true|1)\b/i.test(
          match.entry.block,
        )
      )
        throw new Error("trust-bypass");
      if (entry.fields) {
        const invariantFields = (fields) => [...fields].filter(([name]) => !["uris", "suites"].includes(name));
        if (JSON.stringify(invariantFields(entry.fields)) !== JSON.stringify(invariantFields(match.entry.fields)))
          throw new Error("malformed-sources");
      } else if (
        entry.match[1] !== match.entry.match?.[1] ||
        entry.match[2] !== match.entry.match?.[2] ||
        entry.match[5] !== match.entry.match?.[5]
      )
        throw new Error("malformed-sources");
      const official = suite.endsWith("-security") ? officialSecurity : officialArchive;
      if (match.entry.uris.length !== 1 || match.entry.uris[0] !== official) throw new Error("mixed-sources");
    }
  }
}

function aptCommand(command, args, input) {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) throw new Error("apt-config-refusal");
  return result.stdout;
}

export function prepareE2eApt({
  env = process.env,
  read = readFileSync,
  list = readdirSync,
  exists = existsSync,
  command = aptCommand,
  write = console.log,
} = {}) {
  const releaseText = read("/etc/os-release", "utf8");
  const field = (name) => new RegExp(`^${name}=["']?([^"'\\n]+)`, "m").exec(releaseText)?.[1];
  const sources = {};
  if (exists("/etc/apt/sources.list")) sources["/etc/apt/sources.list"] = read("/etc/apt/sources.list", "utf8");
  for (const name of list("/etc/apt/sources.list.d"))
    if (/\.(?:list|sources)$/.test(name)) {
      const filename = `/etc/apt/sources.list.d/${name}`;
      sources[filename] = read(filename, "utf8");
    }
  const mirrors = {};
  for (const text of Object.values(sources))
    for (const match of text.matchAll(/mirror\+file:(\/[^\s]+)|mirror:\/\/([^\s]+)/g)) {
      if (!match[1]) continue;
      try {
        mirrors[match[0]] = read(match[1], "utf8");
      } catch {
        mirrors[match[0]] = "";
      }
    }
  const keys = {};
  const ubuntuKeys = new Set();
  for (const [filename, text] of Object.entries(sources)) {
    let entries;
    try {
      entries = sourceEntries(text, filename);
    } catch {
      keys[filename] = "unparsed-source";
      continue;
    }
    for (const entry of entries)
      for (const key of entry.key.split(/\s+/).filter((key) => key.startsWith("/"))) {
        try {
          keys[key] = digest(read(key));
        } catch {
          keys[key] = "unreadable-key";
        }
        if (isUbuntuEntry(entry, mirrors) && keys[key] !== "unreadable-key") ubuntuKeys.add(key);
      }
  }
  const profile = {
    distribution: field("ID"),
    release: field("VERSION_ID"),
    codename: field("VERSION_CODENAME"),
    architecture: env.RUNNER_ARCH,
  };
  write(
    `playwright-e2e-apt-before ${JSON.stringify({ ...profile, releaseText, ImageOS: env.ImageOS, ImageVersion: env.ImageVersion, sources, mirrors, keys })}`,
  );
  const plan = projectUbuntuSources({ ...profile, sources, mirrors });
  if (!plan.projected) {
    write(`playwright-e2e-apt ${JSON.stringify({ state: "image-drift-unmitigated", ...profile })}`);
    return { projected: false, restore() {} };
  }
  const originals = new Map();
  const restore = () => {
    let failed = false;
    for (const [filename, original] of [...originals].reverse()) {
      try {
        if (original === null) command("sudo", ["-n", "rm", "--", filename]);
        else command("sudo", ["-n", "tee", filename], original);
        if (original === null ? exists(filename) : !read(filename).equals(Buffer.from(original))) failed = true;
      } catch {
        failed = true;
      }
    }
    write(
      `playwright-e2e-apt-restore ${JSON.stringify({ state: failed ? "restore-failure" : "restored", files: [...originals.keys()] })}`,
    );
    if (failed) throw new Error("restore-failure");
    originals.clear();
  };
  try {
    for (const [filename, projected] of Object.entries(plan.sources))
      if (projected !== sources[filename]) {
        const original = read(filename);
        if (!original.equals(Buffer.from(sources[filename]))) throw new Error("malformed-sources");
        originals.set(filename, original);
        command("sudo", ["-n", "tee", filename], projected);
      }
    originals.set(aptBoundsPath, exists(aptBoundsPath) ? read(aptBoundsPath) : null);
    command("sudo", ["-n", "tee", aptBoundsPath], aptBounds);
    const effectiveSources = Object.fromEntries(
      Object.keys(sources).map((filename) => [filename, read(filename, "utf8")]),
    );
    validateUbuntuProjection(sources, effectiveSources, mirrors);
    for (const key of ubuntuKeys) if (digest(read(key)) !== keys[key]) throw new Error("projected-key-swap");
    const effective = command("sudo", ["-n", "apt-config", "dump"]);
    for (const [name, value] of [
      ["Acquire::http::Timeout", "30"],
      ["Acquire::https::Timeout", "30"],
      ["Acquire::Retries", "1"],
    ]) {
      if (!effective.includes(`${name} "${value}";`)) throw new Error("ineffective-elevated-config");
    }
    for (const [name, values] of [
      ["Dir", ["/"]],
      ["Dir::Etc", ["etc/apt", "/etc/apt"]],
      ["Dir::Etc::sourcelist", ["sources.list", "/etc/apt/sources.list"]],
      ["Dir::Etc::sourceparts", ["sources.list.d", "/etc/apt/sources.list.d"]],
    ]) {
      if (!values.some((value) => effective.includes(`${name} "${value}";`)))
        throw new Error("ineffective-elevated-config");
    }
    for (const line of effective.split("\n")) {
      const option = /^(\S+) "([^"\n]*)";$/.exec(line.trim());
      if (!option) continue;
      const [, name, value] = option;
      if (
        (/::Verify-(?:Peer|Host)$/i.test(name) && value !== "true") ||
        (/(?:^|::)Allow(?:Unauthenticated|InsecureRepositories|WeakRepositories|DowngradeToInsecureRepositories)$/i.test(
          name,
        ) &&
          value !== "false")
      )
        throw new Error("trust-bypass");
      if (
        (/Acquire::https?::.*Timeout/i.test(name) && (!/^\d+$/.test(value) || Number(value) > 30)) ||
        (/Acquire::Retries$/i.test(name) && (!/^\d+$/.test(value) || Number(value) > 1)) ||
        /^Binary::apt-get::Dir(?:::|$)/i.test(name)
      )
        throw new Error("ineffective-elevated-config");
    }
    write(`playwright-e2e-apt-effective ${JSON.stringify({ sources: effectiveSources, keys, effective })}`);
    return { projected: true, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

export function resolveE2eCache(env = process.env) {
  const require = createRequire(import.meta.url);
  const playwrightRequire = createRequire(require.resolve("@playwright/test/package.json"));
  const coreRequire = createRequire(playwrightRequire.resolve("playwright/package.json"));
  const coreRoot = path.dirname(coreRequire.resolve("playwright-core/package.json"));
  const manifest = JSON.parse(readFileSync(path.join(coreRoot, "browsers.json"), "utf8"));
  const payloads = manifest.browsers
    .filter((browser) => ["chromium", "chromium-headless-shell", "ffmpeg"].includes(browser.name))
    .map((browser) => ({ name: browser.name.replaceAll("-", "_"), revision: browser.revision }));
  if (payloads.length !== 3) throw new Error("invalid-browser-manifest");
  const version = JSON.parse(readFileSync(path.join(coreRoot, "package.json"), "utf8")).version;
  const cachePath = validateCachePath(path.join(env.HOME, ".cache", "chase-sets-e2e-playwright"));
  return {
    cachePath,
    payloads,
    nativePackages: PLAYWRIGHT_NATIVE_FONT_PACKAGES,
    key: `e2e-playwright-${env.RUNNER_OS}-${env.RUNNER_ARCH}-${version}-${payloads.map((p) => p.revision).join("-")}`,
  };
}

function safeField(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : fallback;
}

export function validateCachePath(cachePath, pathApi = path) {
  if (
    typeof cachePath !== "string" ||
    cachePath.length === 0 ||
    cachePath.includes("~") ||
    !pathApi.isAbsolute(cachePath)
  ) {
    throw new Error("invalid-cache-path");
  }
  const resolved = pathApi.resolve(cachePath);
  if (resolved === pathApi.parse(resolved).root) throw new Error("invalid-cache-path");
  return resolved;
}

function cacheEntries(root, { lstat = lstatSync, readdir = readdirSync } = {}) {
  const entries = [];
  const visit = (current) => {
    const stat = lstat(current);
    entries.push({ path: current, stat });
    if (!stat.isDirectory()) return;
    for (const name of readdir(current)) visit(path.join(current, name));
  };
  visit(root);
  return entries;
}

export function inspectCache(
  cachePath,
  {
    exists = existsSync,
    lstat = lstatSync,
    readdir = readdirSync,
    ownerUid = process.getuid?.(),
    payloads,
    access = accessSync,
  } = {},
) {
  if (!exists(cachePath)) return { state: "cold", complete: false, owned: true, manifestCount: 0 };
  let entries;
  try {
    entries = cacheEntries(cachePath, { lstat, readdir });
  } catch {
    return { state: "mismatched", complete: false, owned: false, manifestCount: 0 };
  }
  const owned = entries.every(({ stat }) => {
    if (stat.isSymbolicLink?.()) return false;
    return ownerUid === undefined || stat.uid === undefined || stat.uid === ownerUid;
  });
  const manifestCount = entries.filter(
    ({ path: entryPath, stat }) => !stat.isDirectory() && /(?:^|[\\/])(?:package|pnpm-lock)\.json$/.test(entryPath),
  ).length;
  const payload = entries.some(
    ({ path: entryPath, stat }) => !stat.isDirectory() && /(?:^|[\\/])chrome(?:\.exe)?$/.test(entryPath),
  );
  if (!owned) return { state: "mismatched", complete: false, owned, manifestCount };
  if (payloads) {
    try {
      for (const { path: entryPath, stat } of entries)
        access(entryPath, constants.R_OK | (stat.isDirectory() ? constants.X_OK : 0));
      const complete = payloads.every(({ name, revision }) => {
        const root = path.join(cachePath, `${name}-${revision}`);
        const files = entries.filter(
          ({ path: entryPath, stat }) => !stat.isDirectory() && entryPath.startsWith(`${root}${path.sep}`),
        );
        const executable =
          name === "chromium"
            ? /[\\/]chrome$/
            : name === "chromium_headless_shell"
              ? /[\\/]chrome-headless-shell$/
              : /[\\/]ffmpeg-linux$/;
        return (
          files.some(({ path: entryPath, stat }) => executable.test(entryPath) && stat.size > 0) &&
          files.some(({ path: entryPath }) => path.basename(entryPath) === "INSTALLATION_COMPLETE")
        );
      });
      return {
        state: complete ? "complete" : "incomplete",
        complete,
        owned,
        manifestCount: payloads.filter(({ name, revision }) =>
          exists(path.join(cachePath, `${name}-${revision}`, "INSTALLATION_COMPLETE")),
        ).length,
      };
    } catch {
      return { state: "unreadable", complete: false, owned, manifestCount };
    }
  }
  if (!payload) return { state: "incomplete", complete: false, owned, manifestCount };
  return { state: "complete", complete: true, owned, manifestCount };
}

export function removeCache(cachePath, { remove = rmSync, exists = existsSync } = {}) {
  remove(cachePath, { recursive: true, force: true });
  if (exists(cachePath)) throw new Error("cleanup-refusal");
}

function identityFromEnvironment(env) {
  const runId = /^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? "") ? env.GITHUB_RUN_ID : "1";
  const jobId = /^\d{1,20}$/.test(env.GITHUB_JOB_ID ?? "") ? env.GITHUB_JOB_ID : runId;
  const runAttempt = /^\d{1,20}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ? Number(env.GITHUB_RUN_ATTEMPT) : 1;
  const headSha = /^[a-f0-9]{40}$/.test(env.BOUNDARY_HEAD_SHA ?? "")
    ? env.BOUNDARY_HEAD_SHA
    : /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")
      ? env.GITHUB_SHA
      : "0".repeat(40);
  return { runId, jobId, runAttempt, headSha };
}

function diagnostic(site, attempt, reason, cache) {
  return `Playwright Chromium install failed ${JSON.stringify({ site, attempt, reason, cache })}`;
}

function refusal({ site, attempt, reason, cache, write }) {
  const line = diagnostic(site, attempt, reason, cache);
  write(line);
  return { status: 1, reason, cache, diagnostic: line };
}

export async function installPlaywrightChromium(options = {}) {
  const env = options.env ?? process.env;
  if (env.PLAYWRIGHT_INSTALL_POLICY !== "e2e-acquisition") return installAttempts(options);
  const write = options.write ?? console.log;
  const clock = () => {
    const value = options.now?.() ?? performance.now();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  const started = clock();
  let apt;
  let identity;
  let result;
  let cachePath;
  let invalidateCache = false;
  try {
    cachePath = validateCachePath(env.PLAYWRIGHT_BROWSERS_PATH);
    if (options.cancelSignal?.aborted)
      return refusal({ site: PLAYWRIGHT_INSTALL_SITE, attempt: "1", reason: "cancelled", cache: "invalid", write });
    identity =
      options.identity ??
      (await resolveInstallerIdentity(env, options.fetchImpl ?? fetch, {
        jobName: env.PLAYWRIGHT_INSTALL_JOB_NAME,
        write,
      }));
    apt = (options.prepareAptImpl ?? prepareE2eApt)({ env, write });
    const nativeBefore =
      options.nativeInventoryImpl?.("before") ?? (options.prepareAptImpl ? undefined : captureNativeInventory());
    write(`playwright-e2e-native-before ${JSON.stringify(nativeBefore ?? {})}`);
    const inspectCacheImpl =
      options.inspectCacheImpl ?? ((root) => inspectCache(root, { payloads: resolveE2eCache(env).payloads }));
    result = await installAttempts({ ...options, inspectCacheImpl, identity, envelopeStartedAt: started });
    if (result.status === 0) {
      const nativeAfter =
        options.nativeInventoryImpl?.("after") ?? (options.prepareAptImpl ? undefined : captureNativeInventory());
      write(`playwright-e2e-native-after ${JSON.stringify(nativeAfter ?? {})}`);
      if (apt.projected && nativeAfter) {
        const expected = options.nativePackages ?? resolveE2eCache(env).nativePackages;
        const installed = new Set(
          nativeAfter.packages
            .split("\n")
            .filter((line) => line.split("\t")[1] === "installed")
            .map((line) => line.split("\t")[0].split(":")[0]),
        );
        if (expected.some((name) => !installed.has(name)) || !nativeAfter.fonts.trim())
          throw new Error("native-validation-failure");
      }
    }
  } catch (error) {
    invalidateCache = result?.status === 0;
    const reason = [
      "restore-failure",
      "native-validation-failure",
      "ineffective-elevated-config",
      "projected-key-swap",
      "trust-bypass",
      "mixed-sources",
      "malformed-sources",
      "invalid-cache-path",
    ].includes(error.message)
      ? error.message
      : "apt-config-refusal";
    result = refusal({ site: PLAYWRIGHT_INSTALL_SITE, attempt: "1", reason, cache: "invalid", write });
  } finally {
    try {
      apt?.restore();
    } catch {
      invalidateCache = result?.status === 0;
      result = refusal({
        site: PLAYWRIGHT_INSTALL_SITE,
        attempt: "1",
        reason: "restore-failure",
        cache: "invalid",
        write,
      });
    }
  }
  if (result.status === 0 && clock() - started > PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS * 1000) {
    invalidateCache = true;
    result = { status: 1, reason: "budget-exhausted" };
  }
  if (invalidateCache && cachePath) {
    try {
      (options.removeCacheImpl ?? removeCache)(cachePath);
    } catch {
      result = { status: 1, reason: "cleanup-refusal" };
    }
  }
  write(
    `playwright-e2e-whole ${JSON.stringify({ ...identity, checkoutSha: env.GITHUB_SHA, step: "Install Playwright Chromium", elapsedMs: clock() - started, terminalOutcome: result.reason, projected: apt?.projected ?? false })}`,
  );
  return result;
}

function captureNativeInventory() {
  const capture = (command, args) => {
    try {
      return aptCommand(command, args);
    } catch {
      return "";
    }
  };
  return {
    packages: capture("dpkg-query", ["-W", "-f=${binary:Package}\t${db:Status-Status}\t${Version}\n"]),
    fonts: capture("fc-list", ["--format=%{family}\t%{file}\n"]),
  };
}

async function installAttempts({
  env = process.env,
  runInstallerImpl = runInstaller,
  inspectCacheImpl = inspectCache,
  removeCacheImpl = removeCache,
  buildInvocationImpl = buildPackageManagerInvocation,
  now,
  cancelSignal,
  delayImpl = delay,
  write = (line) => console.log(line),
  envelopeStartedAt,
  identity,
} = {}) {
  const rawSite = env.PLAYWRIGHT_INSTALL_SITE;
  const rawAttempt = env.PLAYWRIGHT_INSTALL_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT;
  if ((rawSite !== undefined && !safeField(rawSite, "")) || (rawAttempt !== undefined && !safeField(rawAttempt, ""))) {
    return refusal({
      site: PLAYWRIGHT_INSTALL_SITE,
      attempt: "1",
      reason: "invalid-environment",
      cache: "invalid",
      write,
    });
  }
  const site = safeField(rawSite, PLAYWRIGHT_INSTALL_SITE);
  const attempt = safeField(rawAttempt, "1");
  const policy = env.PLAYWRIGHT_INSTALL_POLICY ?? "single-attempt";
  if (!["single-attempt", "e2e-acquisition"].includes(policy)) {
    return refusal({ site, attempt, reason: "invalid-policy", cache: "invalid", write });
  }
  let cachePath;
  try {
    cachePath = validateCachePath(env.PLAYWRIGHT_BROWSERS_PATH);
  } catch {
    return refusal({ site, attempt, reason: "invalid-path", cache: "invalid", write });
  }
  const e2e = policy === "e2e-acquisition";
  const timeoutSeconds = e2e ? PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS : 600;
  const maxAttempts = e2e ? 2 : 1;
  const clockMs = () => {
    const value = typeof now === "function" ? now() : performance.now();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  const envelopeEndsAt = (envelopeStartedAt ?? clockMs()) + PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS * 1000;
  const fits = (delayMs = 0) =>
    clockMs() + delayMs + timeoutSeconds * 1000 + INSTALLER_TIMEOUT_GRACE_MS <= envelopeEndsAt;
  const callerEnv = {
    ...env,
    INSTALLER_TIMEOUT_SECONDS: "600",
  };
  const explicitEnv = {
    PLAYWRIGHT_BROWSERS_PATH: cachePath,
    PLAYWRIGHT_INSTALL_SITE: site,
    PLAYWRIGHT_INSTALL_ATTEMPT: attempt,
  };
  for (let installerAttempt = 1; installerAttempt <= maxAttempts; installerAttempt += 1) {
    const cacheBefore = inspectCacheImpl(cachePath);
    let result;
    let timingLine;
    const fail = (reason, cache = cacheBefore.state) => {
      if (e2e && timingLine) write(timingLine);
      return refusal({ site, attempt, reason, cache, write });
    };
    if (cancelSignal?.aborted) return fail("cancelled");
    if (e2e && !fits()) return fail("budget-exhausted");
    if (e2e) {
      write(
        `playwright-e2e-attempt-start ${JSON.stringify({ installerAttempt, cache: cacheBefore, elapsedMs: clockMs() - (envelopeEndsAt - PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS * 1000) })}`,
      );
      if (cacheBefore.state !== "cold" && !cacheBefore.complete) {
        try {
          removeCacheImpl(cachePath);
        } catch {
          return fail("cleanup-refusal");
        }
      }
    }
    try {
      const invocation = buildInvocationImpl(PLAYWRIGHT_INSTALL_COMMAND, { env: callerEnv });
      if (cancelSignal?.aborted) return fail("cancelled");
      if (e2e && !fits()) return fail("budget-exhausted");
      result = await runInstallerImpl({
        identity: identity ?? identityFromEnvironment(callerEnv),
        env: callerEnv,
        installerCommand: invocation.command,
        installerArgs: invocation.args,
        installerEnv: explicitEnv,
        cacheHit: cacheBefore.state === "complete",
        requireComplete: false,
        cancelSignal,
        timeoutSeconds,
        now,
        write: (line) => {
          if (typeof line === "string" && line.startsWith(TIMING_RECORD_PREFIX)) timingLine = line;
          else write(line);
        },
      });
    } catch {
      return fail("authority-refusal");
    }
    if (!result) return fail("authority-refusal");
    const cacheAfter = result?.status === 0 ? inspectCacheImpl(cachePath) : cacheBefore;
    if (e2e)
      write(
        `playwright-e2e-attempt-end ${JSON.stringify({ ...result.record, step: "Install Playwright Chromium", installerAttempt, cache: cacheAfter, status: result.status })}`,
      );
    const outcome = result?.record?.terminalOutcome;
    let reason = result?.startRefused === true ? "start-refusal" : (outcome ?? "incomplete-cache");
    if (["cleanup-failure", "cleanup-refusal"].includes(outcome)) return fail(outcome, cacheAfter.state);
    if (cancelSignal?.aborted || outcome === "cancelled") reason = "cancelled";
    else if (e2e && clockMs() > envelopeEndsAt) reason = "timeout";
    else if (result?.status === 0 && cacheAfter.complete) {
      if (e2e && timingLine) write(timingLine);
      timingLine = undefined;
      if (e2e && clockMs() > envelopeEndsAt) reason = "timeout";
      else return { ...result, reason: "success", cache: cacheAfter.state };
    } else if (result?.status === 0) reason = "incomplete-cache";
    try {
      removeCacheImpl(cachePath);
    } catch {
      return fail("cleanup-refusal", cacheAfter.state);
    }
    if (
      !["partial-download", "cache-restore-failure", "incomplete-cache"].includes(reason) ||
      installerAttempt === maxAttempts
    )
      return fail(reason, cacheAfter.state);
    if (cancelSignal?.aborted) return fail("cancelled", cacheAfter.state);
    if (!fits(PLAYWRIGHT_INSTALL_RETRY_DELAY_MS)) return fail("budget-exhausted", cacheAfter.state);
    if (e2e && timingLine) {
      write(timingLine);
      timingLine = undefined;
    }
    write(
      `Playwright Chromium install retry ${JSON.stringify({ site, attempt, installerAttempt, reason, cache: cacheAfter.state })}`,
    );
    try {
      await delayImpl(PLAYWRIGHT_INSTALL_RETRY_DELAY_MS);
    } catch {
      return fail("cancelled", cacheAfter.state);
    }
    if (cancelSignal?.aborted) return fail("cancelled", cacheAfter.state);
    if (!fits()) return fail("budget-exhausted", cacheAfter.state);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--cache-identity") {
    const cache = resolveE2eCache();
    appendFileSync(process.env.GITHUB_OUTPUT, `path=${cache.cachePath}\nkey=${cache.key}\n`);
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    let cache;
    try {
      if (process.env.PLAYWRIGHT_INSTALL_POLICY === "e2e-acquisition") {
        cache = resolveE2eCache();
        if (cache.cachePath !== process.env.PLAYWRIGHT_BROWSERS_PATH) throw new Error("invalid-cache-path");
      }
      const result = await installPlaywrightChromium({
        cancelSignal: controller.signal,
        ...(cache
          ? {
              nativePackages: cache.nativePackages,
              inspectCacheImpl: (root) => inspectCache(root, { payloads: cache.payloads }),
            }
          : {}),
      });
      process.exitCode = result.status;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
}
