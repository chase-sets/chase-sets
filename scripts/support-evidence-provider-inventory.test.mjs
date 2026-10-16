import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFilesystemPrivateObjectStore,
  createS3PrivateObjectStore,
} from "../infrastructure/object-storage/private-object-store.ts";
import * as tool from "./support-evidence-provider-inventory.mjs";
import { createPlatformOperationsServices } from "../bounded-contexts/platform-operations/support/runtime-support/services.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const H = "a".repeat(64);
const options = {
  environment: "test",
  implementationSha: "b".repeat(40),
  imageDigest: `sha256:${H}`,
  horizon: "501",
  boundaryReceiptId: "c".repeat(64),
  snapshotReceiptId: "d".repeat(64),
  requestCap: 1000,
  requestCostUpperBoundUsd: 0.001,
};
const key = (index, length = 26) => `support-evidence/sup_case/sea_${String(index).padStart(length, "0")}/${H}.png`;
const marker = "PRIVATE_CASE_KEY_FILENAME_PROVIDER_EXCEPTION_CREDENTIAL_MARKER";
const roots = [];
beforeEach(() => {
  for (const name of Object.keys(process.env).filter((name) =>
    /^(AWS_|SPACES_|S3_|OBJECT_STORAGE_|PG|DATABASE_URL$|TEST_DATABASE_URL$|SUPPORT_EVIDENCE_)/.test(name),
  ))
    vi.stubEnv(name, "");
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function fixture(count = 1) {
  const objects = new Map(Array.from({ length: count }, (_, index) => [key(index), Buffer.from(`legacy-${index}`)]));
  let authority = { status: "complete", horizon: "501", count: 0, digest: H, references: [], operationKeys: [] };
  const storage = {
    listPrivate: vi.fn(async ({ prefix, continuationToken, maxKeys }) => {
      const all = [...objects].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b, "en"));
      const start = Number(continuationToken ?? 0);
      const entries = all.slice(start, start + maxKeys).map(([name, body]) => ({ key: name, byteSize: body.length }));
      return {
        status: "page",
        entries,
        nextContinuationToken: start + entries.length < all.length ? String(start + entries.length) : null,
      };
    }),
    deleteKeys: vi.fn(async (keys) =>
      keys.map((name) => ({ key: name, status: objects.delete(name) ? "deleted" : "absent" })),
    ),
  };
  const legacy = {
    reconstruct: vi.fn(async () => structuredClone(authority)),
    claim: vi.fn(async () => true),
    recordOutcomes: vi.fn(async () => {}),
  };
  return {
    storage,
    legacy,
    options: { ...options },
    objects,
    setAuthority: (next) => {
      authority = { ...authority, ...next };
    },
  };
}

async function prepared(count = 1) {
  const deps = fixture(count);
  const { manifest } = await tool.dryRun(deps);
  return { ...deps, manifest, approvedDigest: tool.manifestDigest(manifest), persistOutcomes: vi.fn(async () => {}) };
}

async function mutant(from, to) {
  const source = await readFile(new URL("./support-evidence-provider-inventory.mjs", import.meta.url), "utf8");
  const pattern = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"));
  expect(pattern.test(source), `missing mutant anchor: ${from}`).toBe(true);
  return import(`data:text/javascript;base64,${Buffer.from(source.replace(pattern, to)).toString("base64")}`);
}

describe("legacy inventory, no live authority", () => {
  it("bounds cost at USD 15; kills cost-bound bypass", async () => {
    const env = {
      SUPPORT_EVIDENCE_INVENTORY_ENVIRONMENT: "test",
      SUPPORT_EVIDENCE_INVENTORY_IMPLEMENTATION_SHA: options.implementationSha,
      SUPPORT_EVIDENCE_INVENTORY_IMAGE_DIGEST: options.imageDigest,
      SUPPORT_EVIDENCE_INVENTORY_REQUEST_CAP: "1000",
      SUPPORT_EVIDENCE_INVENTORY_REQUEST_COST_UPPER_BOUND_USD: "0.016",
    };
    expect(() => tool.inventoryOptions(env)).toThrow("refused");
    const bypass = await mutant("options.requestCap * options.requestCostUpperBoundUsd > 15", "false");
    expect(bypass.inventoryOptions(env).requestCap).toBe(1000);
  });

  it("threads only explicit database credentials and verified TLS, never inherited libpq defaults", () => {
    const env = {
      SUPPORT_EVIDENCE_INVENTORY_DATABASE_URL:
        "postgresql://fake-user:fake-password@synthetic.invalid:5433/fake_database",
      PGUSER: marker,
      PGPASSWORD: marker,
      PGSSLMODE: "disable",
    };
    expect(tool.inventoryDatabaseOptions(env)).toEqual({
      host: "synthetic.invalid",
      port: 5433,
      user: "fake-user",
      password: "fake-password",
      database: "fake_database",
      ssl: { rejectUnauthorized: true },
      application_name: "support-evidence-inventory",
      max: 1,
    });
    for (const url of [
      "postgresql://synthetic.invalid/fake_database",
      "postgresql://fake-user@synthetic.invalid/fake_database",
      `${env.SUPPORT_EVIDENCE_INVENTORY_DATABASE_URL}?sslmode=disable`,
    ])
      expect(() => tool.inventoryDatabaseOptions({ ...env, SUPPORT_EVIDENCE_INVENTORY_DATABASE_URL: url })).toThrow(
        "refused",
      );
  });

  it("classifies four classes and preserves legacy byte digests", async () => {
    const deps = fixture(3);
    deps.objects.set(key(3, 52), Buffer.from(marker));
    deps.objects.set(`support-evidence/non-conforming/${marker}`, Buffer.from(marker));
    deps.setAuthority({ references: [key(0)], operationKeys: [key(3, 52)] });
    const before = [...deps.objects].map(([name, bytes]) => [name, hash(bytes)]);
    const { manifest, receipt } = await tool.dryRun(deps);
    expect(new Set(manifest.objects.map((object) => object.classification))).toEqual(
      new Set(["legacy-referenced", "operation-owned", "candidate-orphan", "non-conforming"]),
    );
    expect(receipt.result).toBe("approval-required");
    expect(tool.validManifest(manifest)).toBe(true);
    expect(tool.validReceipt(receipt)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(marker);
    expect(JSON.stringify(receipt)).not.toContain("sup_case");
    expect([...deps.objects].map(([name, bytes]) => [name, hash(bytes)])).toEqual(before);
    expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
  });

  it.each(["boundaryReceiptId", "snapshotReceiptId"])(
    "retains without %s; kills missing-authority bypass",
    async (field) => {
      const deps = fixture();
      deps.options[field] = null;
      expect((await tool.dryRun(deps)).receipt.result).toBe("retention");
      const bypass = await mutant(`options.${field} !== null`, "true");
      expect((await bypass.dryRun(deps)).receipt.result).toBe("approval-required");
    },
  );

  it("retains unknown history; kills unknown-history bypass", async () => {
    const deps = fixture();
    deps.setAuthority({ status: "unknown" });
    expect((await tool.dryRun(deps)).receipt.result).toBe("retention");
    const bypass = await mutant('authority.status === "complete" && current.status === "complete"', "true");
    expect((await bypass.dryRun(deps)).receipt.result).toBe("approval-required");
  });

  it("retains on new references; kills reference-drift bypass", async () => {
    const deps = fixture();
    deps.legacy.reconstruct.mockResolvedValueOnce({
      status: "complete",
      horizon: "501",
      digest: H,
      references: [],
      operationKeys: [],
    });
    deps.setAuthority({ digest: "e".repeat(64), references: [key(0)] });
    expect((await tool.dryRun(deps)).receipt.result).toBe("retention");
    deps.legacy.reconstruct.mockResolvedValueOnce({
      status: "complete",
      horizon: "501",
      digest: H,
      references: [],
      operationKeys: [],
    });
    const bypass = await mutant("authority.digest === current.digest", "true");
    expect((await bypass.dryRun(deps)).receipt.result).toBe("approval-required");
  });

  it("retains a new legacy key; kills listing-drift bypass", async () => {
    const deps = fixture();
    const original = deps.storage.listPrivate.getMockImplementation();
    deps.storage.listPrivate.mockImplementationOnce(async (input) => {
      const page = await original(input);
      deps.objects.set(key(99), Buffer.from("new"));
      return page;
    });
    expect((await tool.dryRun(deps)).receipt.result).toBe("retention");
    const bypass = await mutant("canonical(first.entries) === canonical(second.entries)", "true");
    const other = fixture();
    const list = other.storage.listPrivate.getMockImplementation();
    other.storage.listPrivate.mockImplementationOnce(async (input) => {
      const page = await list(input);
      other.objects.set(key(99), Buffer.from("new"));
      return page;
    });
    expect((await bypass.dryRun(other)).receipt.result).toBe("approval-required");
  });

  it.each(["missing-page", "repeated-token", "cap-hit"])("retains %s; kills incomplete-list bypass", async (kind) => {
    const deps = fixture();
    if (kind === "missing-page")
      deps.storage.listPrivate.mockResolvedValue({ status: "list-incomplete", reason: "page-failed" });
    if (kind === "repeated-token")
      deps.storage.listPrivate.mockResolvedValue({ status: "page", entries: [], nextContinuationToken: "repeat" });
    if (kind === "cap-hit") {
      deps.options.requestCap = 2;
      deps.storage.listPrivate.mockResolvedValue({ status: "page", entries: [], nextContinuationToken: "next" });
    }
    expect((await tool.dryRun(deps)).receipt.result).toBe("retention");
    const bypass = await mutant("first.complete && second.complete", "true");
    expect((await bypass.dryRun(deps)).receipt.result).toBe("approval-required");
    expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
  });

  it("validates closed schemas deeply, including planted receipt fields", async () => {
    const { manifest, receipt } = await tool.dryRun(fixture());
    for (const value of [
      { ...manifest, secret: marker },
      { ...manifest, objects: [null] },
      { ...manifest, horizon: 501 },
      { ...manifest, objects: [{ ...manifest.objects[0], secret: marker }] },
      { ...manifest, objects: [{ ...manifest.objects[0], byteSize: -1 }] },
    ])
      expect(tool.validManifest(value)).toBe(false);
    for (const value of [
      { ...receipt, secret: marker },
      { ...receipt, pages: marker },
      { ...receipt, environment: marker },
      { ...receipt, boundaryReceiptId: marker },
    ])
      expect(tool.validReceipt(value)).toBe(false);
    const bypass = await mutant("Object.keys(value).length === fields.length &&", "true &&");
    expect(bypass.validReceipt({ ...receipt, secret: marker })).toBe(true);
  });

  it.each([undefined, "e".repeat(64)])("refuses approval %s; kills approval bypass", async (approvedDigest) => {
    const deps = await prepared();
    deps.approvedDigest = approvedDigest;
    expect((await tool.deleteApproved(deps)).receipt.result).toBe("retention");
    expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
    const bypass = await mutant("if (approvedDigest !== digest)", "if (false)");
    expect((await bypass.deleteApproved(deps)).receipt.result).toBe("deleted");
  });

  it.each([
    "environment",
    "horizon",
    "implementationSha",
    "imageDigest",
    "boundaryReceiptId",
    "snapshotReceiptId",
    "requestCap",
    "requestCostUpperBoundUsd",
  ])("refuses changed %s; kills binding bypass", async (field) => {
    const deps = await prepared();
    deps.options[field] =
      field === "environment"
        ? "staging"
        : field === "horizon"
          ? "502"
          : field === "implementationSha"
            ? "e".repeat(40)
            : field === "imageDigest"
              ? `sha256:${"e".repeat(64)}`
              : field === "requestCap"
                ? 900
                : field === "requestCostUpperBoundUsd"
                  ? 0.002
                  : "e".repeat(64);
    expect((await tool.deleteApproved(deps)).receipt.result).toBe("retention");
    expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
    const bypass = await mutant("options[field] !== manifest[field]", "false");
    expect((await bypass.deleteApproved(deps)).receipt.result).toBe("deleted");
  });

  it("refuses manifest drift under old approval; kills digest bypass", async () => {
    const deps = await prepared();
    deps.manifest.snapshotReceiptId = "e".repeat(64);
    deps.options.snapshotReceiptId = deps.manifest.snapshotReceiptId;
    expect((await tool.deleteApproved(deps)).receipt.result).toBe("retention");
    expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
    const bypass = await mutant("if (approvedDigest !== digest)", "if (false)");
    expect((await bypass.deleteApproved(deps)).receipt.result).toBe("deleted");
  });

  it("stops manifest drift between batches and retains the approved identity in its receipt; kills mid-batch-digest bypass", async () => {
    const deps = await prepared(101);
    deps.persistOutcomes.mockImplementation(async () => {
      deps.manifest.snapshotReceiptId = "e".repeat(64);
    });
    const result = await tool.deleteApproved(deps);
    expect(result.receipt.result).toBe("retention");
    expect(result.receipt.manifestDigest).toBe(deps.approvedDigest);
    expect(deps.storage.deleteKeys).toHaveBeenCalledTimes(1);
    const other = await prepared(101);
    other.persistOutcomes.mockImplementation(async () => {
      other.manifest.snapshotReceiptId = "e".repeat(64);
    });
    const bypass = await mutant("if (manifestDigest(manifest) !== digest)", "if (false)");
    expect((await bypass.deleteApproved(other)).receipt.result).toBe("deleted");
  });

  it("reclassifies before delete; kills forged-class bypass", async () => {
    const deps = await prepared();
    deps.setAuthority({ references: [key(0)] });
    // Deliberately same digest: this control tests reclassification independently of digest comparison.
    expect((await tool.deleteApproved(deps)).receipt.result).toBe("retention");
    const bypass = await mutant(".classification !== object.classification", ".classification && false");
    expect((await bypass.deleteApproved(deps)).receipt.result).toBe("deleted");
  });

  it("stops between batches on a new reference, preserving per-key outcomes", async () => {
    const deps = await prepared(101);
    deps.persistOutcomes.mockImplementation(async () => {
      deps.setAuthority({ digest: "e".repeat(64), references: [key(100)] });
    });
    const result = await tool.deleteApproved(deps);
    expect(result.receipt.result).toBe("retention");
    expect(result.outcomes).toHaveLength(100);
    expect(deps.storage.deleteKeys).toHaveBeenCalledTimes(1);
    expect(deps.storage.deleteKeys.mock.calls[0][0]).toHaveLength(100);
    expect(deps.objects.has(key(100))).toBe(true);
    expect(deps.legacy.recordOutcomes).toHaveBeenCalledTimes(1);
    const bypass = await mutant(
      'if (current.status !== "complete" || current.digest !== manifest.referenceDigest)',
      "if (false)",
    );
    const other = await prepared(101);
    other.persistOutcomes.mockImplementation(async () => {
      other.setAuthority({ digest: "e".repeat(64) });
    });
    expect((await bypass.deleteApproved(other)).receipt.result).toBe("deleted");
  });

  it("stops on guarded claim refusal; kills claim bypass", async () => {
    const deps = await prepared();
    deps.legacy.claim.mockResolvedValue(false);
    expect((await tool.deleteApproved(deps)).receipt.result).toBe("retention");
    expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
    const bypass = await mutant("await legacy.claim({", "true || await legacy.claim({");
    expect((await bypass.deleteApproved(deps)).receipt.result).toBe("deleted");
  });

  it("persists partial failure without success or further delete; kills partial-failure bypass", async () => {
    const deps = await prepared(101);
    deps.storage.deleteKeys.mockImplementation(async (keys) =>
      keys.map((name, index) => {
        deps.objects.delete(name);
        return { key: name, status: index ? "deleted" : "failed", code: marker };
      }),
    );
    const result = await tool.deleteApproved(deps);
    expect(result.receipt.result).toBe("retention");
    expect(result.receipt.failed).toBe(1);
    expect(deps.persistOutcomes).toHaveBeenCalledTimes(1);
    expect(deps.storage.deleteKeys).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.receipt)).not.toContain(marker);
    const bypass = await mutant('if (batch.some((outcome) => outcome.status === "failed"))', "if (false)");
    const other = await prepared();
    other.storage.deleteKeys.mockResolvedValue([{ key: key(0), status: "failed" }]);
    expect((await bypass.deleteApproved(other)).receipt.result).toBe("deleted");
  });

  it.each(["journal", "event"])("stops after %s persistence failure; kills durable-outcomes bypass", async (kind) => {
    const deps = await prepared(101);
    (kind === "journal" ? deps.persistOutcomes : deps.legacy.recordOutcomes).mockRejectedValue(new Error(marker));
    expect((await tool.deleteApproved(deps)).receipt.result).toBe("retention");
    expect(deps.storage.deleteKeys).toHaveBeenCalledTimes(1);
    const other = await prepared(101);
    (kind === "journal" ? other.persistOutcomes : other.legacy.recordOutcomes).mockRejectedValue(new Error(marker));
    const bypass = await mutant("catch { return retained(); }", "catch {}");
    expect((await bypass.deleteApproved(other)).receipt.result).toBe("deleted");
  });

  it("redacts provider exceptions and refuses malformed per-key outcomes; kills per-key-failure bypass", async () => {
    const dry = fixture();
    dry.storage.listPrivate.mockRejectedValue(new Error(marker));
    const result = await tool.dryRun(dry);
    expect(result.receipt.result).toBe("retention");
    expect(JSON.stringify(result.receipt)).not.toContain(marker);
    for (const outcomes of [
      [],
      [
        { key: key(0), status: "deleted" },
        { key: key(0), status: "deleted" },
      ],
      [
        { key: key(0), status: "deleted" },
        { key: marker, status: "failed" },
      ],
      [{ key: marker, status: "deleted" }],
    ]) {
      const deps = await prepared();
      deps.storage.deleteKeys.mockResolvedValue(outcomes);
      expect((await tool.deleteApproved(deps)).receipt).toMatchObject({ result: "retention", failed: 1 });
      const bypass = await mutant('if (batch.some((outcome) => outcome.status === "failed"))', "if (false)");
      expect((await bypass.deleteApproved(deps)).receipt.result).toBe("deleted");
    }
  });

  it("deletes only candidates, never rewriting legacy bytes", async () => {
    const deps = fixture(3);
    deps.setAuthority({ references: [key(0)], operationKeys: [key(1)] });
    const before = [hash(deps.objects.get(key(0))), hash(deps.objects.get(key(1)))];
    const { manifest } = await tool.dryRun(deps);
    const result = await tool.deleteApproved({
      ...deps,
      manifest,
      approvedDigest: tool.manifestDigest(manifest),
      persistOutcomes: async () => {},
    });
    expect(result.receipt.result).toBe("deleted");
    expect(result.receipt.deleted).toBe(1);
    expect([hash(deps.objects.get(key(0))), hash(deps.objects.get(key(1)))]).toEqual(before);
  });
});

describe("synthetic probe adapters and real CLI transport", () => {
  async function filesystem() {
    const root = await mkdtemp(path.join(tmpdir(), "support-inventory-"));
    roots.push(root);
    const filesystemStore = createFilesystemPrivateObjectStore({ rootDir: root });
    // The filesystem adapter intentionally has no provider type metadata. This fake supplies it
    // independently while retaining the real filesystem byte, pagination and delete paths.
    const types = new Map();
    const storage = {
      ...filesystemStore,
      putPrivate: async (input) => {
        const result = await filesystemStore.putPrivate(input);
        if (result.status === "completed") types.set(input.key, input.contentType);
        return result;
      },
      readPrivate: async (...args) => {
        const read = await filesystemStore.readPrivate(...args);
        return read.status === "found" ? { ...read, providerContentType: types.get(args[0]) ?? null } : read;
      },
    };
    return { root, storage };
  }

  function sdk() {
    const objects = new Map();
    const send = vi.fn(async (command) => {
      const input = command.input;
      switch (command.constructor.name) {
        case "PutObjectCommand":
          expect(input).not.toHaveProperty("ACL");
          expect(input.CacheControl).toBe("private, no-store");
          objects.set(input.Key, { body: Buffer.from(input.Body), type: input.ContentType });
          return {};
        case "GetObjectCommand": {
          const object = objects.get(input.Key);
          if (!object)
            throw Object.assign(new Error(marker), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
          return {
            Body: Readable.from([object.body], { objectMode: false }),
            ContentLength: object.body.length,
            ContentType: object.type,
          };
        }
        case "ListObjectsV2Command": {
          const all = [...objects].filter(([name]) => name.startsWith(input.Prefix)).sort();
          const start = Number(input.ContinuationToken ?? 0);
          const contents = all
            .slice(start, start + input.MaxKeys)
            .map(([name, object]) => ({ Key: name, Size: object.body.length }));
          return {
            Contents: contents,
            KeyCount: contents.length,
            IsTruncated: start + contents.length < all.length,
            NextContinuationToken: start + contents.length < all.length ? String(start + contents.length) : undefined,
          };
        }
        case "DeleteObjectsCommand":
          return {
            Deleted: input.Delete.Objects.map(({ Key }) => {
              objects.delete(Key);
              return { Key };
            }),
          };
        default:
          throw new Error("unexpected fake SDK call");
      }
    });
    return { storage: createS3PrivateObjectStore({ bucket: marker, client: { send } }), send };
  }

  it.each(["filesystem", "sdk"])(
    "performs every probe phase with %s fake and cleared provider/libpq credentials",
    async (kind) => {
      const { storage, send } = kind === "filesystem" ? await filesystem() : sdk();
      const before = Buffer.from("unchanged legacy bytes");
      await storage.putPrivate({ key: key(0), body: before, contentType: "image/png", deadlineMs: 30_000 });
      const put = vi.spyOn(storage, "putPrivate");
      const read = vi.spyOn(storage, "readPrivate");
      const list = vi.spyOn(storage, "listPrivate");
      const del = vi.spyOn(storage, "deleteKeys");
      const anonymousGet = vi.fn(async () => ({ status: 403 }));
      const result = await tool.syntheticProbe({
        storage,
        options,
        runId: "fake-run",
        anonymousGet,
        objectUrl: (name) => `https://synthetic.invalid/${name}`,
      });
      expect(result.receipt.result).toBe("probe-passed");
      expect(result.receipt.pages).toBe(3);
      expect(put).toHaveBeenCalledTimes(6);
      expect(read).toHaveBeenCalledTimes(6);
      expect(list).toHaveBeenCalledTimes(3);
      expect(del).toHaveBeenCalledTimes(1);
      expect(anonymousGet).toHaveBeenCalledTimes(3);
      expect(result.outcomes).toHaveLength(3);
      expect(JSON.stringify(result.receipt)).not.toContain(marker);
      const legacy = await storage.readPrivate(key(0), { maxBytes: 100, deadlineMs: 30_000 });
      expect(hash(legacy.body)).toBe(hash(before));
      if (send) expect(send.mock.calls.length).toBeGreaterThan(10);
    },
  );

  it("refuses non-synthetic prefix before writes; kills prefix bypass", async () => {
    const { storage } = await filesystem();
    const put = vi.spyOn(storage, "putPrivate");
    const deps = {
      storage,
      options,
      runId: "fake-run",
      prefix: "support-evidence/sup_case/",
      anonymousGet: async () => ({ status: 403 }),
      objectUrl: () => "https://synthetic.invalid",
    };
    await expect(tool.syntheticProbe(deps)).rejects.toThrow("refused");
    expect(put).not.toHaveBeenCalled();
    const bypass = await mutant("prefix !== `support-evidence/synthetic-probe-${runId}/`", "false");
    expect((await bypass.syntheticProbe(deps)).receipt.result).toBe("probe-passed");
  });

  it.each(["hash", "type", "size", "anonymous", "delete"])(
    "retains a failed probe %s; kills phase bypass",
    async (phase) => {
      const { storage } = await filesystem();
      let corrupt;
      let readSpy;
      if (["hash", "type", "size"].includes(phase)) {
        const original = storage.readPrivate;
        corrupt = async (...args) => {
          const read = await original(...args);
          return {
            ...read,
            ...(phase === "hash"
              ? { body: Buffer.alloc(read.body.length, 1) }
              : phase === "type"
                ? { providerContentType: "text/plain" }
                : { byteSize: 999 }),
          };
        };
        readSpy = vi.spyOn(storage, "readPrivate").mockImplementationOnce(corrupt);
      }
      if (phase === "delete")
        vi.spyOn(storage, "deleteKeys").mockImplementation(async (keys) =>
          keys.map((name) => ({ key: name, status: "failed", code: "provider-error" })),
        );
      const deps = {
        storage,
        options,
        runId: "fake-run",
        anonymousGet: async () => ({ status: phase === "anonymous" ? 200 : 403 }),
        objectUrl: () => "https://synthetic.invalid",
      };
      const result = await tool.syntheticProbe(deps);
      expect(result.receipt.result).toBe("retention");
      if (readSpy) readSpy.mockImplementationOnce(corrupt);
      const anchors = {
        hash: ['createHash("sha256").update(read.body).digest("hex") !== sha256', "false"],
        type: ["read.providerContentType !== contentType", "false"],
        size: ["read.byteSize !== body.length", "false"],
        anonymous: ["if (![401, 403].includes(response.status))", "if (false)"],
        delete: ['passed &&= outcomes.every((outcome) => outcome.status !== "failed");', "passed &&= true;"],
      };
      const bypass = await mutant(...anchors[phase]);
      expect((await bypass.syntheticProbe(deps)).receipt.result).toBe("probe-passed");
    },
  );

  it("CLI writes private manifest, receipt and outcomes through injected fakes only", async () => {
    const { root, storage } = await filesystem();
    const env = Object.fromEntries(
      Object.entries({
        MODE: "synthetic-probe",
        ENVIRONMENT: "test",
        IMPLEMENTATION_SHA: options.implementationSha,
        IMAGE_DIGEST: options.imageDigest,
        REQUEST_CAP: "100",
        REQUEST_COST_UPPER_BOUND_USD: "0.001",
        RUN_ID: "cli-fake",
        MANIFEST_PATH: path.join(root, "manifest.json"),
        RECEIPT_PATH: path.join(root, "receipt.json"),
      }).map(([name, value]) => [`SUPPORT_EVIDENCE_INVENTORY_${name}`, value]),
    );
    const close = vi.fn();
    const compose = vi.fn(async () => ({
      storage,
      anonymousGet: async () => ({ status: 403 }),
      objectUrl: () => "https://synthetic.invalid",
      close,
    }));
    const result = await tool.runInventoryCli(env, compose);
    expect(result.result).toBe("probe-passed");
    expect(compose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(tool.validReceipt(JSON.parse(await readFile(env.SUPPORT_EVIDENCE_INVENTORY_RECEIPT_PATH, "utf8")))).toBe(
      true,
    );
    expect(JSON.parse(await readFile(env.SUPPORT_EVIDENCE_INVENTORY_MANIFEST_PATH, "utf8"))).toHaveLength(3);
  });

  it("public Platform Operations composition exposes the service without mounting any provider runner", async () => {
    const query = vi.fn();
    const services = createPlatformOperationsServices({ query, connect: vi.fn() });
    expect(typeof services.supportEvidenceLegacy.claim).toBe("function");
    expect((await services.supportEvidenceLegacy.reconstruct({ horizon: "invalid" })).status).toBe("unknown");
    expect(query).not.toHaveBeenCalled();
  });
});
