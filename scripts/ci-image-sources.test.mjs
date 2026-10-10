import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  assertTrustedPublisherContext,
  classifyDockerHubCanaryPull,
  createRegistryClient,
  dockerHubBlockPreflight,
  dockerHubHosts,
  dockerHubHostsLines,
  loadImageSources,
  manifestIdentity,
  mirrorReference,
  probeAnonymousMirrors,
  publishMirrors,
  publisherAdmission,
  publisherBoundaryViolations,
  publisherWorkflowPath,
  skopeoCopy,
  sourceReference,
  trustedCheckoutRef,
  validateImageSources,
  verifyPinnedIdentity,
} from "./ci-image-sources.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");
const modulePath = path.join(repoRoot, "scripts/ci-image-sources.mjs");

// Synthetic daemon output for a pull refused at the IPv4 block sink.
const sinkRefusal =
  'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp 0.0.0.0:443: connect: connection refused';
const sinkResolver = () => ({ status: 0, addresses: ["0.0.0.0", "::"] });

// Synthetic registry fixtures: identities below are fabricated test bytes, never
// real upstream digests.
function syntheticIndex(platforms, { attestations = true, salt = "" } = {}) {
  const manifests = platforms.flatMap((platform, index) => {
    const [os, architecture, variant] = platform.split("/");
    const child = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${createHash("sha256").update(`synthetic-${platform}-${salt}`).digest("hex")}`,
      size: 100 + index,
      platform: { os, architecture, ...(variant ? { variant } : {}) },
    };
    if (!attestations) return [child];
    return [
      child,
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: `sha256:${createHash("sha256").update(`synthetic-attestation-${platform}-${salt}`).digest("hex")}`,
        size: 50,
        annotations: {
          "vnd.docker.reference.digest": child.digest,
          "vnd.docker.reference.type": "attestation-manifest",
        },
        platform: { os: "unknown", architecture: "unknown" },
      },
    ];
  });
  return Buffer.from(
    JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests }),
  );
}

const digestOf = (raw) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;

function syntheticEntry(raw, overrides = {}) {
  return {
    id: "synthetic",
    source: "docker.io/synthetic/image",
    tag: "1",
    mirror: "ghcr.io/chase-sets/ci-mirror-synthetic",
    digest: digestOf(raw),
    platforms: ["linux/amd64", "linux/arm64"],
    ...overrides,
  };
}

const trustedEnv = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  CI_IMAGE_MIRROR_DEFAULT_BRANCH: "main",
  GHCR_PUBLISH_USER: "github-actions",
  GHCR_PUBLISH_TOKEN: "synthetic-job-token",
};

// In-memory registry keyed by image reference; HEAD answers from the same table.
// With staleTokens, a client created before a mirror existed keeps getting 401
// for it, like a registry token minted before the package was created.
function fakeRegistry(table, { staleTokens = false } = {}) {
  const calls = [];
  const lookup = (reference) => table.get(reference) ?? { status: 404 };
  const createClient = ({ basicAuth } = {}) => {
    const auth = basicAuth?.["ghcr.io"] ? "ghcr" : "anonymous";
    const knownAtCreation = new Set(table.keys());
    const answer = (reference) => {
      if (staleTokens && auth === "ghcr" && !knownAtCreation.has(reference) && table.has(reference)) {
        return { status: 401 };
      }
      return lookup(reference);
    };
    return {
      head: async (reference) => {
        calls.push(["HEAD", reference, auth]);
        const hit = answer(reference);
        return { status: hit.status ?? 200, digest: hit.raw ? digestOf(hit.raw) : null, raw: null };
      },
      get: async (reference) => {
        calls.push(["GET", reference, auth]);
        const hit = answer(reference);
        return { status: hit.status ?? 200, digest: hit.raw ? digestOf(hit.raw) : null, raw: hit.raw ?? null };
      },
    };
  };
  return { createClient, calls, table };
}

// Registry where the publisher's copy materializes the mirror from the source.
function publishableRegistry(
  entry,
  sourceRaw,
  { tagRaw = sourceRaw, mirrorRaw = sourceRaw, children = true, staleTokens = false } = {},
) {
  const registry = fakeRegistry(
    new Map([
      [sourceReference(entry), { raw: sourceRaw }],
      [`${entry.source}:${entry.tag}`, { raw: tagRaw }],
    ]),
    { staleTokens },
  );
  const copies = [];
  const copyImage = ({ from, to, credentials }) => {
    copies.push({ from, to, credentials });
    registry.table.set(`${entry.mirror}@${entry.digest}`, { raw: mirrorRaw });
    registry.table.set(to, { raw: mirrorRaw });
    if (children) {
      for (const child of manifestIdentity(mirrorRaw).children) {
        registry.table.set(`${entry.mirror}@${child.digest}`, { raw: Buffer.from("{}") });
      }
    }
  };
  return { ...registry, copies, copyImage };
}

describe("committed CI image source map", () => {
  it("pins exactly the six required-CI sources by sha256 with GHCR mirrors", () => {
    const sources = loadImageSources();
    expect(sources.map((entry) => `${entry.source}:${entry.tag}`)).toEqual([
      "docker.io/library/node:24-bookworm-slim",
      "docker.io/docker/dockerfile:1",
      "docker.io/moby/buildkit:buildx-stable-1",
      "docker.io/pgvector/pgvector:pg16",
      "docker.io/rhysd/actionlint:1.7.12",
      "docker.io/alpine/helm:3.15.4",
    ]);
    for (const entry of sources) {
      expect(entry.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(entry.mirror).toBe(`ghcr.io/chase-sets/ci-mirror-${entry.id}`);
      expect(entry.platforms).toContain("linux/amd64");
      expect(sourceReference(entry)).toBe(`${entry.source}@${entry.digest}`);
      expect(mirrorReference(entry)).toBe(`${entry.mirror}:${entry.tag}@${entry.digest}`);
    }
  });

  const base = () => JSON.parse(readRepoFile("scripts/ci-image-sources.json"));
  const withNode = (patch) => {
    const map = base();
    Object.assign(map.sources[0], patch);
    return map;
  };

  it.each([
    ["missing digest", { digest: undefined }],
    ["null digest", { digest: null }],
    ["tag instead of digest", { digest: "24-bookworm-slim" }],
    ["uppercase digest", { digest: `sha256:${"A".repeat(64)}` }],
    ["short digest", { digest: `sha256:${"a".repeat(63)}` }],
    ["non-sha256 algorithm", { digest: `sha512:${"a".repeat(128)}` }],
  ])("refuses a %s", (_label, patch) => {
    expect(() => validateImageSources(withNode(patch))).toThrow(/node: digest must be a lowercase sha256 digest/);
  });

  it("refuses a mirror outside the fixed GHCR namespace, a non-Hub source, unsorted platforms and duplicates", () => {
    expect(() => validateImageSources(withNode({ mirror: "ghcr.io/someone/node" }))).toThrow(/mirror must be/);
    expect(() => validateImageSources(withNode({ source: "quay.io/library/node" }))).toThrow(/fixed docker\.io/);
    expect(() => validateImageSources(withNode({ platforms: ["linux/arm64/v8", "linux/amd64"] }))).toThrow(/sorted/);
    expect(() => validateImageSources(withNode({ platforms: [] }))).toThrow(/non-empty/);
    const duplicated = base();
    duplicated.sources.push({ ...duplicated.sources[0] });
    expect(() => validateImageSources(duplicated)).toThrow(/duplicated/);
  });
});

describe("pinned identity verification", () => {
  const raw = syntheticIndex(["linux/amd64", "linux/arm64"]);
  const entry = syntheticEntry(raw);

  it("accepts the pinned bytes and ignores attestation manifests as platforms", () => {
    const identity = verifyPinnedIdentity(entry, raw, "mirror");
    expect(identity.digest).toBe(entry.digest);
    expect(identity.platforms).toEqual(["linux/amd64", "linux/arm64"]);
    expect(identity.children).toHaveLength(4);
  });

  it("refuses bytes a moved tag now serves", () => {
    const moved = syntheticIndex(["linux/amd64", "linux/arm64"], { salt: "moved" });
    expect(() => verifyPinnedIdentity(entry, moved, "source")).toThrow(
      /source manifest is sha256:[a-f0-9]{64}, not the pinned .*refusing moved or substituted bytes/,
    );
  });

  it("refuses a mirror whose digest mismatches the source pin", () => {
    const substituted = syntheticIndex(["linux/amd64", "linux/arm64"], { attestations: false });
    expect(() => verifyPinnedIdentity(entry, substituted, "mirror")).toThrow(/mirror manifest is .* not the pinned/);
  });

  it("refuses a manifest that lost a pinned platform", () => {
    const amd64Only = syntheticIndex(["linux/amd64"]);
    expect(() => verifyPinnedIdentity(syntheticEntry(amd64Only), amd64Only, "mirror")).toThrow(
      /platforms differ from the pin \(missing: linux\/arm64; unexpected: none\)/,
    );
  });

  it("refuses a single-platform manifest in place of the pinned index", () => {
    const single = Buffer.from(
      JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" }),
    );
    expect(() => verifyPinnedIdentity(syntheticEntry(single), single, "mirror")).toThrow(/multi-platform index/);
  });
});

describe("publishMirrors", () => {
  const sourceRaw = syntheticIndex(["linux/amd64", "linux/arm64"]);
  const entry = syntheticEntry(sourceRaw);

  it.each([
    [
      "an untrusted branch ref",
      { GITHUB_REF: "refs/heads/codex/feature" },
      /untrusted ref 'refs\/heads\/codex\/feature'/,
    ],
    [
      "a pull request event",
      { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" },
      /event 'pull_request'/,
    ],
    ["a missing default branch", { CI_IMAGE_MIRROR_DEFAULT_BRANCH: "" }, /untrusted ref/],
  ])("refuses %s before touching any registry", async (_label, patch, message) => {
    const registry = publishableRegistry(entry, sourceRaw);
    await expect(publishMirrors({ sources: [entry], env: { ...trustedEnv, ...patch }, ...registry })).rejects.toThrow(
      message,
    );
    expect(registry.calls).toEqual([]);
    expect(registry.copies).toEqual([]);
  });

  it.each(["GHCR_PUBLISH_TOKEN", "GHCR_PUBLISH_USER"])("refuses when %s is withheld", async (name) => {
    const registry = publishableRegistry(entry, sourceRaw);
    await expect(publishMirrors({ sources: [entry], env: { ...trustedEnv, [name]: "" }, ...registry })).rejects.toThrow(
      /GHCR_PUBLISH_USER and GHCR_PUBLISH_TOKEN are required/,
    );
    expect(registry.calls).toEqual([]);
  });

  it("copies the pinned digest, never the moved tag, and records the movement", async () => {
    const movedTagRaw = syntheticIndex(["linux/amd64", "linux/arm64"], { salt: "moved" });
    const registry = publishableRegistry(entry, sourceRaw, { tagRaw: movedTagRaw });
    const receipt = await publishMirrors({ sources: [entry], env: trustedEnv, ...registry, now: () => "t" });

    expect(registry.copies).toEqual([
      {
        from: `docker.io/synthetic/image@${entry.digest}`,
        to: "ghcr.io/chase-sets/ci-mirror-synthetic:1",
        credentials: { user: "github-actions", token: "synthetic-job-token" },
      },
    ]);
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0]).toMatchObject({
      sourceDigest: entry.digest,
      mirrorDigest: entry.digest,
      sourceTagDigest: digestOf(movedTagRaw),
      sourceTagMoved: true,
      copied: true,
    });
    expect(receipt.rows[0].children.map((child) => child.platform)).toEqual([
      "linux/amd64",
      "unknown/unknown",
      "linux/arm64",
      "unknown/unknown",
    ]);
    expect(
      registry.calls.filter(([, , auth]) => auth === "anonymous").every(([, ref]) => ref.startsWith("docker.io/")),
    ).toBe(true);
  });

  it("verifies a first copy with a token minted after the package exists", async () => {
    const registry = publishableRegistry(entry, sourceRaw, { staleTokens: true });
    const receipt = await publishMirrors({ sources: [entry], env: trustedEnv, ...registry });
    expect(receipt.rows[0]).toMatchObject({ copied: true, mirrorDigest: entry.digest });
  });

  it("refuses a mirror whose bytes do not match the source digest after copy", async () => {
    const registry = publishableRegistry(entry, sourceRaw, {
      mirrorRaw: syntheticIndex(["linux/amd64", "linux/arm64"], { salt: "converted" }),
    });
    await expect(publishMirrors({ sources: [entry], env: trustedEnv, ...registry })).rejects.toThrow(
      /synthetic: mirror manifest is .* not the pinned/,
    );
  });

  it("refuses a mirror missing a child platform manifest", async () => {
    const registry = publishableRegistry(entry, sourceRaw, { children: false });
    await expect(publishMirrors({ sources: [entry], env: trustedEnv, ...registry })).rejects.toThrow(
      /mirror is missing child manifest sha256:[a-f0-9]{64} \(linux\/amd64\)/,
    );
  });

  it("stays red on a rate-limited source instead of falling back to the tag", async () => {
    const registry = publishableRegistry(entry, sourceRaw);
    registry.table.set(sourceReference(entry), { status: 429 });
    await expect(publishMirrors({ sources: [entry], env: trustedEnv, ...registry })).rejects.toThrow(
      /HTTP 429 \(registry rate limit; rerun in a later window, never a tag fallback\)/,
    );
    expect(registry.copies).toEqual([]);
  });

  it("re-verifies but does not re-copy an already mirrored digest", async () => {
    const registry = publishableRegistry(entry, sourceRaw);
    registry.copyImage({ from: sourceReference(entry), to: `${entry.mirror}:${entry.tag}` });
    registry.copies.length = 0;
    const receipt = await publishMirrors({ sources: [entry], env: trustedEnv, ...registry });
    expect(registry.copies).toEqual([]);
    expect(receipt.rows[0]).toMatchObject({ copied: false, mirrorDigest: entry.digest });
  });
});

describe("createRegistryClient transport", () => {
  // Valid index bytes deliberately not in JSON.stringify form, so a parse and
  // re-serialization would change the digest.
  const raw = Buffer.from(
    '{\n  "schemaVersion": 2,\n  "mediaType": "application/vnd.oci.image.index.v1+json",\n  "manifests": []\n}\n',
  );
  const digest = digestOf(raw);
  const basic = Buffer.from("synthetic-user:synthetic-job-token").toString("base64");

  // fetch double: records every request and serves token or manifest routes.
  function fakeFetch(route) {
    const calls = [];
    const bodyReads = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? "GET", headers: { ...options.headers } });
      const answer = route(url);
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        headers: { get: (name) => (name.toLowerCase() === "docker-content-digest" ? (answer.digest ?? null) : null) },
        json: async () => answer.json,
        arrayBuffer: async () => {
          bodyReads.push(url);
          const body = answer.body ?? Buffer.alloc(0);
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        },
      };
    };
    return { fetchImpl, calls, bodyReads };
  }
  const registryRoute = (url) => {
    if (url.startsWith("https://auth.docker.io/token")) return { status: 200, json: { token: "synthetic-hub-token" } };
    if (url.startsWith("https://ghcr.io/token")) {
      return { status: 200, json: { access_token: `synthetic-ghcr-${new URL(url).searchParams.get("scope")}` } };
    }
    return { status: 200, body: raw, digest };
  };
  const acceptedMediaTypes = [
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
  ];

  it("reads a Hub manifest anonymously with a pull-scoped token and returns the raw bytes unconverted", async () => {
    const { fetchImpl, calls } = fakeFetch(registryRoute);
    const response = await createRegistryClient({ fetchImpl }).get(`docker.io/library/node@${digest}`);

    expect(response.status).toBe(200);
    expect(response.digest).toBe(digest);
    expect(Buffer.compare(response.raw, raw)).toBe(0);
    expect(digestOf(response.raw)).toBe(digest);
    expect(calls).toEqual([
      {
        url: "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull",
        method: "GET",
        headers: {},
      },
      {
        url: `https://registry-1.docker.io/v2/library/node/manifests/${digest}`,
        method: "GET",
        headers: { Accept: expect.any(String), Authorization: "Bearer synthetic-hub-token" },
      },
    ]);
    expect(calls[1].headers.Accept.split(", ").sort()).toEqual(acceptedMediaTypes);
  });

  it("authenticates only to GHCR, with Basic credentials and one pull token per repository", async () => {
    const { fetchImpl, calls } = fakeFetch(registryRoute);
    const client = createRegistryClient({ fetchImpl, basicAuth: { "ghcr.io": basic } });
    await client.head("ghcr.io/chase-sets/ci-mirror-node:24");
    await client.get(`ghcr.io/chase-sets/ci-mirror-node@${digest}`);
    await client.head("ghcr.io/chase-sets/ci-mirror-helm:3");
    await client.get(`docker.io/library/node@${digest}`);

    const scope = (repository) => `repository:${repository}:pull`;
    expect(calls.filter((call) => call.url.includes("/token?"))).toEqual([
      {
        url: `https://ghcr.io/token?service=ghcr.io&scope=${scope("chase-sets/ci-mirror-node")}`,
        method: "GET",
        headers: { Authorization: `Basic ${basic}` },
      },
      {
        url: `https://ghcr.io/token?service=ghcr.io&scope=${scope("chase-sets/ci-mirror-helm")}`,
        method: "GET",
        headers: { Authorization: `Basic ${basic}` },
      },
      {
        url: `https://auth.docker.io/token?service=registry.docker.io&scope=${scope("library/node")}`,
        method: "GET",
        headers: {},
      },
    ]);
    const manifestCalls = calls.filter((call) => !call.url.includes("/token?"));
    expect(manifestCalls.map((call) => [call.method, call.url, call.headers.Authorization])).toEqual([
      [
        "HEAD",
        "https://ghcr.io/v2/chase-sets/ci-mirror-node/manifests/24",
        `Bearer synthetic-ghcr-${scope("chase-sets/ci-mirror-node")}`,
      ],
      [
        "GET",
        `https://ghcr.io/v2/chase-sets/ci-mirror-node/manifests/${digest}`,
        `Bearer synthetic-ghcr-${scope("chase-sets/ci-mirror-node")}`,
      ],
      [
        "HEAD",
        "https://ghcr.io/v2/chase-sets/ci-mirror-helm/manifests/3",
        `Bearer synthetic-ghcr-${scope("chase-sets/ci-mirror-helm")}`,
      ],
      ["GET", `https://registry-1.docker.io/v2/library/node/manifests/${digest}`, "Bearer synthetic-hub-token"],
    ]);
    expect(JSON.stringify(calls.filter((call) => !call.url.startsWith("https://ghcr.io/token")))).not.toContain(basic);
  });

  it("answers HEAD with the digest header and never reads a body", async () => {
    const { fetchImpl, bodyReads } = fakeFetch(registryRoute);
    const response = await createRegistryClient({ fetchImpl }).head("docker.io/library/node:24-bookworm-slim");
    expect(response).toEqual({ status: 200, digest, raw: null });
    expect(bodyReads).toEqual([]);
  });

  it("returns error statuses without bytes and refuses failed tokens and unknown registries", async () => {
    const missing = fakeFetch((url) => (url.includes("/token?") ? registryRoute(url) : { status: 404 }));
    const missingClient = createRegistryClient({ fetchImpl: missing.fetchImpl });
    const notFound = await missingClient.get(`docker.io/library/node@${digest}`);
    expect(notFound).toEqual({ status: 404, digest: null, raw: null });
    expect(missing.bodyReads).toEqual([]);

    const refused = fakeFetch(() => ({ status: 401 }));
    const refusedClient = createRegistryClient({ fetchImpl: refused.fetchImpl, basicAuth: { "ghcr.io": basic } });
    await expect(refusedClient.get(`ghcr.io/chase-sets/ci-mirror-node@${digest}`)).rejects.toThrow(
      "Registry token request for ghcr.io/chase-sets/ci-mirror-node failed with HTTP 401.",
    );
    const unknownRegistry = createRegistryClient({ fetchImpl: refused.fetchImpl }).get("quay.io/synthetic/image:1");
    await expect(unknownRegistry).rejects.toThrow("Unsupported registry 'quay.io'.");
  });
});

describe("skopeoCopy adapter", () => {
  const credentials = { user: "synthetic-user", token: "synthetic-job-token" };
  const from = `docker.io/synthetic/image@sha256:${"a".repeat(64)}`;
  const to = "ghcr.io/chase-sets/ci-mirror-synthetic:1";

  // Command boundary double: the real adapter runs; only process spawning is replaced.
  function commandDouble({ loginStatus = 0, copyStatus = 0, onCopy } = {}) {
    const calls = [];
    const runCommand = (command, args, options = {}) => {
      const authfile = args[args.indexOf(args[0] === "login" ? "--authfile" : "--dest-authfile") + 1];
      calls.push({ command, args, input: options.input, authDirExisted: existsSync(path.dirname(authfile)) });
      if (args[0] === "login") {
        if (loginStatus === 0) writeFileSync(authfile, "{}");
        return { status: loginStatus, stdout: "", stderr: loginStatus ? "synthetic: unauthorized" : "" };
      }
      if (copyStatus === 0) onCopy?.(args);
      return { status: copyStatus, stdout: "", stderr: copyStatus ? "synthetic: manifest unknown" : "" };
    };
    return { calls, runCommand, authDir: () => path.dirname(calls[0].args[2]) };
  }

  it("logs in with the token on stdin only and copies every child with digests preserved", () => {
    const double = commandDouble();
    skopeoCopy({ from, to, credentials, runCommand: double.runCommand });

    const authfile = double.calls[0].args[2];
    expect(double.calls).toEqual([
      {
        command: "skopeo",
        args: ["login", "--authfile", authfile, "--username", "synthetic-user", "--password-stdin", "ghcr.io"],
        input: "synthetic-job-token",
        authDirExisted: true,
      },
      {
        command: "skopeo",
        args: [
          "copy",
          "--all",
          "--preserve-digests",
          "--src-no-creds",
          "--dest-authfile",
          authfile,
          `docker://${from}`,
          `docker://${to}`,
        ],
        input: undefined,
        authDirExisted: true,
      },
    ]);
    expect(JSON.stringify(double.calls.map((call) => call.args))).not.toContain(credentials.token);
    expect(existsSync(double.authDir())).toBe(false);
  });

  it.each([
    ["login", { loginStatus: 1 }, /^skopeo login ghcr\.io failed: synthetic: unauthorized$/, 1],
    ["copy", { copyStatus: 1 }, /^skopeo copy .* -> .* failed: synthetic: manifest unknown$/, 2],
  ])("removes the auth file and stays red when %s fails", (_step, options, message, commands) => {
    const double = commandDouble(options);
    expect(() => skopeoCopy({ from, to, credentials, runCommand: double.runCommand })).toThrow(message);
    expect(double.calls).toHaveLength(commands);
    expect(existsSync(double.authDir())).toBe(false);
  });

  it("is driven by publishMirrors with the pinned source digest, never the moved tag", async () => {
    const sourceRaw = syntheticIndex(["linux/amd64", "linux/arm64"]);
    const entry = syntheticEntry(sourceRaw);
    const registry = publishableRegistry(entry, sourceRaw, {
      tagRaw: syntheticIndex(["linux/amd64", "linux/arm64"], { salt: "moved" }),
    });
    const double = commandDouble({
      onCopy: (args) => registry.copyImage({ from: args.at(-2).slice(9), to: args.at(-1).slice(9) }),
    });
    const receipt = await publishMirrors({
      sources: [entry],
      env: trustedEnv,
      createClient: registry.createClient,
      copyImage: (request) => skopeoCopy({ ...request, runCommand: double.runCommand }),
    });

    expect(double.calls.map((call) => call.args.slice(-2))).toEqual([
      ["--password-stdin", "ghcr.io"],
      [`docker://docker.io/synthetic/image@${entry.digest}`, "docker://ghcr.io/chase-sets/ci-mirror-synthetic:1"],
    ]);
    expect(double.calls[0].input).toBe("synthetic-job-token");
    expect(receipt.rows[0]).toMatchObject({ copied: true, sourceTagMoved: true, mirrorDigest: entry.digest });
  });
});

describe("probeAnonymousMirrors", () => {
  const raw = syntheticIndex(["linux/amd64", "linux/arm64"]);
  const entry = syntheticEntry(raw);
  const reference = mirrorReference(entry);

  function fakeDocker({
    daemon = { status: 0, stdout: "28.0.4\n" },
    hub = { status: 1, stderr: sinkRefusal },
    warm = false,
    pullFails = false,
    repoDigests,
  } = {}) {
    const calls = [];
    const timeouts = new Map();
    const docker = (args, { timeoutMs } = {}) => {
      calls.push(args.join(" "));
      timeouts.set(args.join(" "), timeoutMs);
      if (args[0] === "version") return { stdout: "", stderr: "", ...daemon };
      if (args[0] === "pull" && args[1].startsWith("docker.io/")) return { stdout: "", stderr: "", ...hub };
      if (args[0] === "image" && args.length === 3) return { status: warm ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "pull")
        return {
          status: pullFails ? 1 : 0,
          stdout: "",
          stderr: pullFails ? "denied: requested access to the resource is denied" : "",
        };
      return { status: 0, stdout: JSON.stringify(repoDigests ?? [`${entry.mirror}@${entry.digest}`]), stderr: "" };
    };
    return { docker, calls, timeouts };
  }

  it("pulls every pinned mirror anonymously from a cold daemon with Hub unreachable", () => {
    const { docker, calls, timeouts } = fakeDocker();
    const receipt = probeAnonymousMirrors({
      sources: [entry],
      env: {},
      docker,
      resolveHost: sinkResolver,
      now: () => "t",
    });
    expect(receipt.rows).toEqual([
      { id: "synthetic", reference, pulledAt: "t", repoDigests: [`${entry.mirror}@${entry.digest}`] },
    ]);
    expect(receipt.hubBlockEvidence).toBe("dial tcp 0.0.0.0:443: connect: connection refused");
    expect(timeouts.get("pull docker.io/library/hello-world:latest")).toBe(90_000);
    expect(calls).toEqual([
      "version --format {{.Server.Version}}",
      "pull docker.io/library/hello-world:latest",
      `image inspect ${entry.mirror}@${entry.digest}`,
      `pull ${reference}`,
      `image inspect --format {{json .RepoDigests}} ${entry.mirror}@${entry.digest}`,
    ]);
  });

  it.each([
    [
      "registry credentials are present",
      { env: { GITHUB_TOKEN: "x" } },
      /without registry credentials; found GITHUB_TOKEN/,
    ],
    ["Docker Hub is reachable", { docker: { hub: { status: 0 } } }, /Docker Hub is reachable/],
    [
      "Docker Hub answers with HTTP 429",
      { docker: { hub: { status: 1, stderr: "Error response from daemon: toomanyrequests: rate limit" } } },
      /Docker Hub answered the .* canary pull/,
    ],
    [
      "the Docker daemon is unavailable",
      { docker: { daemon: { status: 1, stderr: "Cannot connect to the Docker daemon" } } },
      /Docker daemon is unavailable/,
    ],
    ["the canary pull times out", { docker: { hub: { status: 124 } } }, /timed out \(exit 124\) without a diagnosis/],
    ["the canary fails without a diagnosis", { docker: { hub: { status: 1 } } }, /failed without dialing a block sink/],
    [
      "a Hub name escapes the host block",
      { resolveHost: () => ({ status: 0, addresses: ["192.0.2.10"] }) },
      /docker\.io resolves to \["192\.0\.2\.10"\]/,
    ],
    ["the image is already cached", { docker: { warm: true } }, /already present locally; the probe must start cold/],
    [
      "the mirror is private, missing or deleted",
      { docker: { pullFails: true } },
      /anonymous pull of .* failed \(private, missing or deleted mirror\): denied/,
    ],
    [
      "the pulled digest differs",
      { docker: { repoDigests: [`${entry.mirror}@sha256:${"0".repeat(64)}`] } },
      /pulled image records/,
    ],
  ])("fails visibly when %s", (_label, { env = {}, docker = {}, resolveHost = sinkResolver }, message) => {
    const { docker: fake } = fakeDocker(docker);
    expect(() => probeAnonymousMirrors({ sources: [entry], env, docker: fake, resolveHost })).toThrow(message);
  });
});

describe("Docker Hub block proof", () => {
  it("writes only the listed Docker Hub names, each to both sinks", () => {
    expect(dockerHubHosts).toEqual([
      "docker.io",
      "index.docker.io",
      "registry-1.docker.io",
      "registry.hub.docker.com",
      "auth.docker.io",
      "production.cloudflare.docker.com",
      "hub.docker.com",
    ]);
    expect(dockerHubHostsLines()).toEqual(dockerHubHosts.flatMap((host) => [`0.0.0.0 ${host}`, `:: ${host}`]));
  });

  it.each([
    ["an IPv4 sink refusal", sinkRefusal],
    [
      "an IPv6 sink refusal",
      'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp [::]:443: connect: connection refused',
    ],
    [
      "a containerd-store sink refusal",
      'failed to resolve reference "docker.io/library/hello-world:latest": failed to do request: Head "https://registry-1.docker.io/v2/library/hello-world/manifests/latest": dial tcp 0.0.0.0:443: connect: connection refused',
    ],
  ])("accepts %s as the discriminating block result", (_label, output) => {
    expect(classifyDockerHubCanaryPull({ status: 1, output }).evidence).toMatch(
      /^dial tcp (?:0\.0\.0\.0|\[::\]):443: connect: connection refused$/,
    );
  });

  it.each([
    ["a successful pull", 0, "latest: Pulling from library/hello-world", /Docker Hub is reachable/],
    [
      "a reachable Hub rate limit (HTTP 429)",
      1,
      "Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit",
      /Docker Hub answered/,
    ],
    [
      "a reachable Hub auth failure",
      1,
      'Error response from daemon: Head "https://registry-1.docker.io/v2/library/hello-world/manifests/latest": unauthorized: authentication required',
      /Docker Hub answered/,
    ],
    [
      "a Hub HTTP 503",
      1,
      "Error response from daemon: received unexpected HTTP status: 503 Service Unavailable",
      /Docker Hub answered/,
    ],
    [
      "a sink refusal beside a registry answer",
      1,
      `${sinkRefusal}\ntoomanyrequests: rate limit`,
      /Docker Hub answered/,
    ],
    [
      "an unavailable daemon",
      1,
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      /Docker daemon is unavailable/,
    ],
    ["a missing docker CLI", 127, "", /docker CLI is unavailable/],
    ["a timeout", 124, "", /timed out \(exit 124\) without a diagnosis/],
    ["a killed timeout", 137, "", /timed out \(exit 137\) without a diagnosis/],
    ["an undiagnosed failure", 1, "", /failed without dialing a block sink \(exit 1: no output\)/],
    [
      "a DNS failure the block did not cause",
      1,
      "dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: no such host",
      /failed without dialing a block sink/,
    ],
    [
      "a refusal at a routable address",
      1,
      "dial tcp 192.0.2.10:443: connect: connection refused",
      /failed without dialing a block sink/,
    ],
  ])("fails closed on %s", (_label, status, output, message) => {
    expect(() => classifyDockerHubCanaryPull({ status, output })).toThrow(message);
  });

  const daemonUp = () => ({ status: 0, stdout: "28.0.4\n", stderr: "" });
  function leakyResolver(host) {
    return host === "auth.docker.io" ? { status: 0, addresses: ["0.0.0.0", "192.0.2.10"] } : sinkResolver();
  }

  it("checks the daemon within a bound and every Hub name against the sinks", () => {
    const resolved = [];
    const timeouts = [];
    const result = dockerHubBlockPreflight({
      docker: (_args, { timeoutMs }) => {
        timeouts.push(timeoutMs);
        return daemonUp();
      },
      resolveHost: (host) => {
        resolved.push(host);
        return sinkResolver();
      },
    });
    expect(result).toEqual({ daemonVersion: "28.0.4" });
    expect(timeouts).toEqual([30_000]);
    expect(resolved).toEqual(dockerHubHosts);
  });

  it.each([
    ["a missing docker CLI", { docker: () => ({ status: 127, stdout: "", stderr: "" }) }, /docker CLI is unavailable/],
    [
      "an unreachable daemon",
      { docker: () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }) },
      /Docker daemon is unavailable \(exit 1: Cannot connect/,
    ],
    [
      "a daemon that does not answer in time",
      { docker: () => ({ status: 124, stdout: "", stderr: "" }) },
      /Docker daemon is unavailable \(exit 124/,
    ],
    [
      "a Hub name resolving to a routable address",
      { resolveHost: leakyResolver },
      /auth\.docker\.io resolves to \["0\.0\.0\.0","192\.0\.2\.10"\] \(exit 0\), not only 0\.0\.0\.0 and ::/,
    ],
    [
      "an unresolved Hub name",
      { resolveHost: () => ({ status: 2, addresses: [] }) },
      /docker\.io resolves to \[\] \(exit 2\)/,
    ],
    ["a missing getent", { resolveHost: () => ({ status: 127, addresses: [] }) }, /getent is unavailable/],
  ])("refuses %s", (_label, doubles, message) => {
    expect(() => dockerHubBlockPreflight({ docker: daemonUp, resolveHost: sinkResolver, ...doubles })).toThrow(message);
  });

  // The action's classification step, executed through the real CLI entry point.
  const runCli = (args, input = "") => spawnSync(process.execPath, [modulePath, ...args], { input, encoding: "utf8" });

  it("certifies the action's canary only on a sink refusal", () => {
    const accepted = runCli(["hub-block-canary", "--status", "1"], `${sinkRefusal}\n`);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("Docker Hub block verified: dial tcp 0.0.0.0:443: connect: connection refused");

    for (const [status, output, message] of [
      ["0", "latest: Pulling from library/hello-world", "Docker Hub is reachable"],
      ["1", "toomanyrequests: rate limit", "Docker Hub answered"],
      ["1", "Cannot connect to the Docker daemon", "Docker daemon is unavailable"],
      ["124", "", "timed out (exit 124)"],
      ["1", "", "failed without dialing a block sink"],
    ]) {
      const refused = runCli(["hub-block-canary", "--status", status], output);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("::error title=CI image mirrors::");
      expect(refused.stderr).toContain(message);
    }
    const malformed = [
      ["hub-block-canary"],
      ["hub-block-canary", "--status", ""],
      ["hub-block-canary", "--status", "x"],
    ];
    for (const args of malformed) {
      expect(runCli(args, sinkRefusal)).toMatchObject({ status: 1, stderr: expect.stringContaining("Usage:") });
    }
  });

  it("prints the hosts lines the action appends", () => {
    const result = runCli(["docker-hub-hosts"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(dockerHubHostsLines());
  });

  it("wires the action through the preflight and a bounded canary pull into the classifier", () => {
    const action = YAML.parse(readRepoFile(".github/actions/block-docker-hub/action.yml"));
    expect(action.runs.steps.map((step) => step.name)).toEqual(["Block Docker Hub hosts"]);
    const script = action.runs.steps[0].run;
    const order = [
      "set -euo pipefail",
      'module="${GITHUB_ACTION_PATH}/../../../scripts/ci-image-sources.mjs"',
      'node "$module" docker-hub-hosts | sudo tee -a /etc/hosts >/dev/null',
      'node "$module" hub-block-preflight',
      'canary="docker.io/library/hello-world:latest"',
      'output="$(timeout --kill-after=10s 90s docker pull "$canary" 2>&1)" || status=$?',
      `printf '%s\\n' "$output" | node "$module" hub-block-canary --status "$status"`,
      'echo "Docker Hub is unreachable for this job;',
    ].map((fragment) => script.indexOf(fragment));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(script).not.toMatch(/if\s+(?:timeout\s+\S+\s+)?docker pull/);
  });
});

describe("publisher boundary", () => {
  const workflowDir = path.join(repoRoot, ".github/workflows");
  const realWorkflows = () =>
    readdirSync(workflowDir)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => ({ path: `.github/workflows/${name}`, text: readFileSync(path.join(workflowDir, name), "utf8") }));
  const parse = (workflows) => workflows.map(({ path: file, text }) => ({ path: file, document: YAML.parse(text) }));
  const plantInto = (file, mutate) =>
    parse(
      realWorkflows().map((workflow) =>
        workflow.path === file ? { ...workflow, text: mutate(workflow.text) } : workflow,
      ),
    );

  it("holds for every committed workflow", () => {
    expect(publisherBoundaryViolations(parse(realWorkflows()))).toEqual([]);
  });

  it("refuses the publisher when its job-level packages: write is absent", () => {
    const violations = publisherBoundaryViolations(
      plantInto(publisherWorkflowPath, (text) => text.replace("      packages: write\n", "")),
    );
    expect(violations).toContain(`${publisherWorkflowPath}: job 'publish' must declare packages: write at job level.`);
  });

  it("refuses packages: write on the probe, Compose, E2E or an arbitrarily named workflow", () => {
    expect(
      publisherBoundaryViolations(
        plantInto(publisherWorkflowPath, (text) =>
          text.replace(
            "    permissions:\n      contents: read\n    steps:",
            "    permissions:\n      contents: read\n      packages: write\n    steps:",
          ),
        ),
      ),
    ).toContain(
      `${publisherWorkflowPath}: job 'anonymous-probe' must not hold packages: write; only the CI image mirror publisher may.`,
    );
    expect(
      publisherBoundaryViolations(
        plantInto(".github/workflows/platform-compose-boot-smoke.yml", (text) =>
          text.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  packages: write\n"),
        ),
      ),
    ).toContain(
      ".github/workflows/platform-compose-boot-smoke.yml: job 'verify' must not hold packages: write; only the CI image mirror publisher may.",
    );
    const arbitrary = [
      ...parse(realWorkflows()),
      {
        path: ".github/workflows/zz-arbitrary-name.yml",
        document: YAML.parse(
          "on: pull_request\npermissions: write-all\njobs:\n  any:\n    runs-on: ubuntu-latest\n    steps: []\n",
        ),
      },
    ];
    expect(publisherBoundaryViolations(arbitrary)).toContain(
      ".github/workflows/zz-arbitrary-name.yml: job 'any' must not hold packages: write; only the CI image mirror publisher may.",
    );
  });

  it("refuses untrusted triggers, inputs, secrets and an unthreaded or widened token", () => {
    const cases = [
      [
        (text) => text.replace("on:\n  workflow_dispatch:\n", "on:\n  workflow_dispatch:\n  pull_request:\n"),
        /trigger only on workflow_dispatch/,
      ],
      [
        (text) =>
          text.replace(
            "on:\n  workflow_dispatch:\n",
            "on:\n  workflow_dispatch:\n    inputs:\n      source:\n        type: string\n",
          ),
        /must not accept inputs/,
      ],
      [(text) => text.replace("${{ github.token }}", "${{ secrets.GHCR_PAT }}"), /must not read repository secrets/],
      [
        (text) => text.replace("          GHCR_PUBLISH_TOKEN: ${{ github.token }}\n", ""),
        /exactly one publish step must thread GHCR_PUBLISH_TOKEN/,
      ],
      [
        (text) =>
          text.replace(
            "      - name: Pull every pinned mirror anonymously\n",
            "      - name: Pull every pinned mirror anonymously\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n",
          ),
        /exactly one publish step must thread GHCR_PUBLISH_TOKEN/,
      ],
      [
        (text) => text.replace("permissions: {}\n", "permissions:\n  contents: read\n"),
        /top-level permissions must be \{\}/,
      ],
    ];
    for (const [mutate, message] of cases) {
      expect(publisherBoundaryViolations(plantInto(publisherWorkflowPath, mutate)).join("\n")).toMatch(message);
    }
  });

  // Test-only evaluator for the GitHub expression subset the publisher uses:
  // string literals, context paths, ==, !=, &&, ||, !, parentheses and format().
  // Like GitHub, string comparison ignores case.
  function evaluateExpression(source, context) {
    const tokens = source.match(/'(?:[^']|'')*'|==|!=|&&|\|\||[!(),]|[A-Za-z_][\w.-]*/g) ?? [];
    let index = 0;
    const take = (expected) => {
      const token = tokens[index++];
      if (expected && token !== expected) throw new Error(`expected ${expected} in ${source}`);
      return token;
    };
    function equal(left, right) {
      if (typeof left === "string" && typeof right === "string") return left.toLowerCase() === right.toLowerCase();
      return left === right;
    }
    function primary() {
      const token = take();
      if (token === "(") {
        const value = or();
        take(")");
        return value;
      }
      if (token === "!") return !primary();
      if (token?.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
      if (token === "format" && tokens[index] === "(") {
        take("(");
        const args = [or()];
        while (tokens[index] === ",") {
          take(",");
          args.push(or());
        }
        take(")");
        return String(args[0]).replace(/\{(\d+)\}/g, (_match, position) => String(args[Number(position) + 1]));
      }
      if (/^[A-Za-z_]/.test(token ?? "")) return token.split(".").reduce((value, key) => value?.[key], context);
      throw new Error(`unsupported token ${token} in ${source}`);
    }
    function comparison() {
      let left = primary();
      while (tokens[index] === "==" || tokens[index] === "!=") {
        const negate = take() === "!=";
        left = equal(left, primary()) !== negate;
      }
      return left;
    }
    function and() {
      let left = comparison();
      while (tokens[index] === "&&") {
        take("&&");
        left = comparison() && left;
      }
      return left;
    }
    function or() {
      let left = and();
      while (tokens[index] === "||") {
        take("||");
        left = and() || left;
      }
      return left;
    }
    const value = or();
    if (index !== tokens.length) throw new Error(`unparsed ${tokens.slice(index).join(" ")} in ${source}`);
    return value;
  }

  // Simulates a workflow_dispatch of the publisher from `ref`: whether the
  // token-bearing job starts, which content it checks out, and whether any step
  // runs before that checkout.
  function simulateDispatch(document, ref) {
    const context = {
      github: { event_name: "workflow_dispatch", ref, event: { repository: { default_branch: "main" } } },
    };
    const job = document.jobs.publish;
    const condition = job.if === undefined || evaluateExpression(String(job.if).replace(/^\$\{\{|\}\}$/g, ""), context);
    if (!condition) return { publishRuns: false };
    const checkoutIndex = job.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    function interpolate(text) {
      return text.replace(/\$\{\{(.+?)\}\}/g, (_match, expression) => String(evaluateExpression(expression, context)));
    }
    const requestedRef = job.steps[checkoutIndex]?.with?.ref;
    const checkoutRef = requestedRef === undefined ? ref : interpolate(requestedRef);
    const tokenThreaded = job.steps.some((step) => JSON.stringify(step.env ?? {}).includes("github.token"));
    const runsBeforeCheckout = job.steps.slice(0, Math.max(checkoutIndex, 0)).some((step) => step.run || step.uses);
    return {
      publishRuns: true,
      checkoutRef,
      tokenThreaded,
      untrustedCodeWithToken: tokenThreaded && (checkoutRef !== "refs/heads/main" || runsBeforeCheckout),
    };
  }
  const publisherDocument = (mutate) => {
    const text = readRepoFile(publisherWorkflowPath);
    const mutated = mutate(text);
    if (mutated === text) throw new Error("planted publisher mutation did not apply");
    return YAML.parse(mutated);
  };

  it("pins the job-level admission and trusted checkout literally", () => {
    const document = YAML.parse(readRepoFile(publisherWorkflowPath));
    expect(document.jobs.publish.if).toBe(publisherAdmission);
    for (const job of Object.values(document.jobs)) {
      expect(job.steps[0].with).toEqual({ ref: trustedCheckoutRef, "persist-credentials": false });
    }
  });

  it("starts the token-bearing job on trusted default-branch content for a default-branch dispatch", () => {
    expect(simulateDispatch(YAML.parse(readRepoFile(publisherWorkflowPath)), "refs/heads/main")).toEqual({
      publishRuns: true,
      checkoutRef: "refs/heads/main",
      tokenThreaded: true,
      untrustedCodeWithToken: false,
    });
  });

  it.each([
    ["a feature branch", "refs/heads/codex/synthetic-untrusted"],
    ["a tag", "refs/tags/v1.0.0"],
    ["a tag named like the default branch", "refs/tags/main"],
    ["a branch prefixed by the default branch", "refs/heads/main-synthetic"],
  ])("skips the token-bearing job before checkout for a dispatch from %s", (_label, ref) => {
    expect(simulateDispatch(YAML.parse(readRepoFile(publisherWorkflowPath)), ref)).toEqual({ publishRuns: false });
  });

  it("still checks out trusted content when GitHub's case-insensitive admission passes a case variant", () => {
    const result = simulateDispatch(YAML.parse(readRepoFile(publisherWorkflowPath)), "refs/heads/MAIN");
    expect(result).toMatchObject({ publishRuns: true, checkoutRef: "refs/heads/main", untrustedCodeWithToken: false });
    const caseVariant = { ...trustedEnv, GITHUB_REF: "refs/heads/MAIN" };
    expect(() => assertTrustedPublisherContext(caseVariant)).toThrow(/untrusted ref 'refs\/heads\/MAIN'/);
  });

  const withoutAdmission = (text) => text.replace(`    if: ${publisherAdmission}\n`, "");
  const withoutPublishCheckoutRef = (text) => text.replace(`          ref: ${trustedCheckoutRef}\n`, "");
  const feature = "refs/heads/codex/synthetic-untrusted";

  // Each mutation must fail the static boundary; where it changes what a
  // feature-branch dispatch reaches, the simulation shows that too.
  it.each([
    [
      "the job-level admission is removed",
      withoutAdmission,
      /job 'publish' must be admitted at job level/,
      { publishRuns: true, checkoutRef: "refs/heads/main", untrustedCodeWithToken: false },
    ],
    [
      "the admission checks only the event",
      (text) => text.replace(`    if: ${publisherAdmission}\n`, "    if: github.event_name == 'workflow_dispatch'\n"),
      /job 'publish' must be admitted at job level/,
      { publishRuns: true, checkoutRef: "refs/heads/main", untrustedCodeWithToken: false },
    ],
    [
      "the admission and the trusted checkout are both removed",
      (text) => withoutPublishCheckoutRef(withoutAdmission(text)),
      /job 'publish' must be admitted at job level[\s\S]*job 'publish' must first check out ref/,
      { publishRuns: true, checkoutRef: feature, untrustedCodeWithToken: true },
    ],
    [
      "the publish checkout follows the dispatched ref",
      withoutPublishCheckoutRef,
      /job 'publish' must first check out ref/,
      { publishRuns: false },
    ],
    [
      "a step runs before the publish checkout",
      (text) =>
        text.replace(
          "    steps:\n      - uses: actions/checkout@",
          "    steps:\n      - run: node ./scripts/ci-image-sources.mjs publish --receipt x\n      - uses: actions/checkout@",
        ),
      /job 'publish' must first check out ref/,
      { publishRuns: false },
    ],
    [
      "the probe checkout follows the dispatched ref",
      (text) => {
        const line = `          ref: ${trustedCheckoutRef}\n`;
        const at = text.lastIndexOf(line);
        return text.slice(0, at) + text.slice(at + line.length);
      },
      /job 'anonymous-probe' must first check out ref/,
      { publishRuns: false },
    ],
    [
      "the probe no longer waits for the admitted publish job",
      (text) => text.replace("    needs: publish\n", ""),
      /job 'anonymous-probe' must need 'publish'/,
      { publishRuns: false },
    ],
  ])("fails the boundary when %s", (_label, mutate, message, featureDispatch) => {
    const document = publisherDocument(mutate);
    const others = parse(realWorkflows()).filter((workflow) => workflow.path !== publisherWorkflowPath);
    const violations = publisherBoundaryViolations([{ path: publisherWorkflowPath, document }, ...others]);
    expect(violations.join("\n")).toMatch(message);
    expect(simulateDispatch(document, feature)).toMatchObject(featureDispatch);
  });

  it("refuses a workflow that inherits repository-default token permissions", () => {
    const violations = publisherBoundaryViolations(
      plantInto(".github/workflows/platform-pr.yml", (text) => text.replace(/^permissions:\n(?:  .*\n)+/m, "")),
    );
    expect(violations).toContain(
      ".github/workflows/platform-pr.yml: declare top-level permissions; repository-default token permissions are unbounded.",
    );
  });

  it("keeps the packages: write module free of installed dependencies", () => {
    const imports = [...readRepoFile("scripts/ci-image-sources.mjs").matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
  });
});
