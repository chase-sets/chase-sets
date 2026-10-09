import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  loadImageSources,
  manifestIdentity,
  mirrorReference,
  probeAnonymousMirrors,
  publishMirrors,
  publisherBoundaryViolations,
  publisherWorkflowPath,
  sourceReference,
  validateImageSources,
  verifyPinnedIdentity,
} from "./ci-image-sources.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");

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
        annotations: { "vnd.docker.reference.digest": child.digest, "vnd.docker.reference.type": "attestation-manifest" },
        platform: { os: "unknown", architecture: "unknown" },
      },
    ];
  });
  return Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests }));
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
function fakeRegistry(table) {
  const calls = [];
  const lookup = (reference) => table.get(reference) ?? { status: 404 };
  const createClient = ({ basicAuth } = {}) => {
    const auth = basicAuth?.["ghcr.io"] ? "ghcr" : "anonymous";
    return {
      head: async (reference) => {
        calls.push(["HEAD", reference, auth]);
        const hit = lookup(reference);
        return { status: hit.status ?? 200, digest: hit.raw ? digestOf(hit.raw) : null, raw: null };
      },
      get: async (reference) => {
        calls.push(["GET", reference, auth]);
        const hit = lookup(reference);
        return { status: hit.status ?? 200, digest: hit.raw ? digestOf(hit.raw) : null, raw: hit.raw ?? null };
      },
    };
  };
  return { createClient, calls, table };
}

// Registry where the publisher's copy materializes the mirror from the source.
function publishableRegistry(entry, sourceRaw, { tagRaw = sourceRaw, mirrorRaw = sourceRaw, children = true } = {}) {
  const registry = fakeRegistry(
    new Map([
      [sourceReference(entry), { raw: sourceRaw }],
      [`${entry.source}:${entry.tag}`, { raw: tagRaw }],
    ]),
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
    const single = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" }));
    expect(() => verifyPinnedIdentity(syntheticEntry(single), single, "mirror")).toThrow(/multi-platform index/);
  });
});

describe("publishMirrors", () => {
  const sourceRaw = syntheticIndex(["linux/amd64", "linux/arm64"]);
  const entry = syntheticEntry(sourceRaw);

  it.each([
    ["an untrusted branch ref", { GITHUB_REF: "refs/heads/codex/feature" }, /untrusted ref 'refs\/heads\/codex\/feature'/],
    ["a pull request event", { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" }, /event 'pull_request'/],
    ["a missing default branch", { CI_IMAGE_MIRROR_DEFAULT_BRANCH: "" }, /untrusted ref/],
  ])("refuses %s before touching any registry", async (_label, patch, message) => {
    const registry = publishableRegistry(entry, sourceRaw);
    await expect(
      publishMirrors({ sources: [entry], env: { ...trustedEnv, ...patch }, ...registry }),
    ).rejects.toThrow(message);
    expect(registry.calls).toEqual([]);
    expect(registry.copies).toEqual([]);
  });

  it.each(["GHCR_PUBLISH_TOKEN", "GHCR_PUBLISH_USER"])("refuses when %s is withheld", async (name) => {
    const registry = publishableRegistry(entry, sourceRaw);
    await expect(
      publishMirrors({ sources: [entry], env: { ...trustedEnv, [name]: "" }, ...registry }),
    ).rejects.toThrow(/GHCR_PUBLISH_USER and GHCR_PUBLISH_TOKEN are required/);
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
    expect(registry.calls.filter(([, , auth]) => auth === "anonymous").every(([, ref]) => ref.startsWith("docker.io/"))).toBe(true);
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

describe("probeAnonymousMirrors", () => {
  const raw = syntheticIndex(["linux/amd64", "linux/arm64"]);
  const entry = syntheticEntry(raw);
  const reference = mirrorReference(entry);

  function fakeDocker({ hubReachable = false, warm = false, pullFails = false, repoDigests } = {}) {
    const calls = [];
    const docker = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "pull" && args[1].startsWith("docker.io/")) return { status: hubReachable ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "image" && args.length === 3) return { status: warm ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "pull") return { status: pullFails ? 1 : 0, stdout: "", stderr: pullFails ? "denied: requested access to the resource is denied" : "" };
      return { status: 0, stdout: JSON.stringify(repoDigests ?? [`${entry.mirror}@${entry.digest}`]), stderr: "" };
    };
    return { docker, calls };
  }

  it("pulls every pinned mirror anonymously from a cold daemon with Hub unreachable", () => {
    const { docker, calls } = fakeDocker();
    const receipt = probeAnonymousMirrors({ sources: [entry], env: {}, docker, now: () => "t" });
    expect(receipt.rows).toEqual([{ id: "synthetic", reference, pulledAt: "t", repoDigests: [`${entry.mirror}@${entry.digest}`] }]);
    expect(calls).toEqual([
      "pull docker.io/library/hello-world:latest",
      `image inspect ${reference}`,
      `pull ${reference}`,
      `image inspect --format {{json .RepoDigests}} ${reference}`,
    ]);
  });

  it.each([
    ["registry credentials are present", { env: { GITHUB_TOKEN: "x" } }, /without registry credentials; found GITHUB_TOKEN/],
    ["Docker Hub is reachable", { docker: { hubReachable: true } }, /Docker Hub is reachable/],
    ["the image is already cached", { docker: { warm: true } }, /already present locally; the probe must start cold/],
    ["the mirror is private, missing or deleted", { docker: { pullFails: true } }, /anonymous pull of .* failed \(private, missing or deleted mirror\): denied/],
    ["the pulled digest differs", { docker: { repoDigests: [`${entry.mirror}@sha256:${"0".repeat(64)}`] } }, /pulled image records/],
  ])("fails visibly when %s", (_label, { env = {}, docker = {} }, message) => {
    expect(() => probeAnonymousMirrors({ sources: [entry], env, docker: fakeDocker(docker).docker })).toThrow(message);
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
    parse(realWorkflows().map((workflow) => (workflow.path === file ? { ...workflow, text: mutate(workflow.text) } : workflow)));

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
        plantInto(publisherWorkflowPath, (text) => text.replace("    permissions:\n      contents: read\n    steps:", "    permissions:\n      contents: read\n      packages: write\n    steps:")),
      ),
    ).toContain(`${publisherWorkflowPath}: job 'anonymous-probe' must not hold packages: write; only the CI image mirror publisher may.`);
    expect(
      publisherBoundaryViolations(
        plantInto(".github/workflows/platform-compose-boot-smoke.yml", (text) => text.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  packages: write\n")),
      ),
    ).toContain(".github/workflows/platform-compose-boot-smoke.yml: job 'verify' must not hold packages: write; only the CI image mirror publisher may.");
    const arbitrary = [
      ...parse(realWorkflows()),
      {
        path: ".github/workflows/zz-arbitrary-name.yml",
        document: YAML.parse("on: pull_request\npermissions: write-all\njobs:\n  any:\n    runs-on: ubuntu-latest\n    steps: []\n"),
      },
    ];
    expect(publisherBoundaryViolations(arbitrary)).toContain(
      ".github/workflows/zz-arbitrary-name.yml: job 'any' must not hold packages: write; only the CI image mirror publisher may.",
    );
  });

  it("refuses untrusted triggers, inputs, secrets and an unthreaded or widened token", () => {
    const cases = [
      [(text) => text.replace("on:\n  workflow_dispatch:\n", "on:\n  workflow_dispatch:\n  pull_request:\n"), /trigger only on workflow_dispatch/],
      [(text) => text.replace("on:\n  workflow_dispatch:\n", "on:\n  workflow_dispatch:\n    inputs:\n      source:\n        type: string\n"), /must not accept inputs/],
      [(text) => text.replace("${{ github.token }}", "${{ secrets.GHCR_PAT }}"), /must not read repository secrets/],
      [(text) => text.replace("          GHCR_PUBLISH_TOKEN: ${{ github.token }}\n", ""), /exactly one publish step must thread GHCR_PUBLISH_TOKEN/],
      [(text) => text.replace("      - name: Pull every pinned mirror anonymously\n", "      - name: Pull every pinned mirror anonymously\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n"), /exactly one publish step must thread GHCR_PUBLISH_TOKEN/],
      [(text) => text.replace("permissions: {}\n", "permissions:\n  contents: read\n"), /top-level permissions must be \{\}/],
    ];
    for (const [mutate, message] of cases) {
      expect(publisherBoundaryViolations(plantInto(publisherWorkflowPath, mutate)).join("\n")).toMatch(message);
    }
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
