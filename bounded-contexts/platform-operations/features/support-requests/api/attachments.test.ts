// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PrivateObjectStore } from "@chase-sets/object-storage";
import {
  canonicalizeSupportEvidenceImage,
  createSupportEvidenceCanonicalizationQueue,
} from "./evidence-canonicalization";
import { readSupportEvidenceAttachment, storeSupportEvidenceAttachments } from "./attachments";
import { SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES } from "../domain/attachment-policy";
import {
  attachmentOperationStreamId,
  decideAttachmentOperation,
  replayAttachmentOperation,
  type AttachmentOperationCommand,
  type AttachmentOperationEvent,
} from "../domain/attachment-operation";

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_owner" as never, forAccountId: "acc_owner" as never },
};
const operationId = "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV";
function fixture() {
  const { eventStore, allEvents } = createInMemoryEventStore();
  const objects = new Map<string, Uint8Array>();
  const storage = {
    putPrivate: vi.fn<PrivateObjectStore["putPrivate"]>(async ({ key, body }) => {
      expect(allEvents[0].eventType).toBe("support.attachment-operation.staged");
      expect(allEvents.at(-1)?.eventType).toBe("support.attachment-operation.put-admitted");
      objects.set(key, body);
      return { status: "completed", key };
    }),
    verifyPrivate: vi.fn<PrivateObjectStore["verifyPrivate"]>(async (key, expected) => {
      const body = objects.get(key);
      if (!body) return { status: "absent" };
      return createHash("sha256").update(body).digest("hex") === expected.sha256
        ? { status: "match" }
        : { status: "conflict", difference: "sha256" };
    }),
    readPrivate: vi.fn<PrivateObjectStore["readPrivate"]>(),
  };
  return {
    allEvents,
    storage,
    input: {
      supportRequestId: "sup_case",
      operationId,
      context,
      eventStore,
      storage,
      canonicalizer: createSupportEvidenceCanonicalizationQueue({ canonicalize: canonicalizeSupportEvidenceImage }),
      uploads: [
        {
          body: readFileSync("features/support-requests/api/__fixtures__/evidence/photo-orientation-6-p3-xmp.jpg"),
          contentType: "image/jpeg",
          filename: "private-name.jpg",
        },
      ],
    },
  };
}

const operationCodec = createPassthroughDomainEventCodec<AttachmentOperationEvent>();
async function transition(f: ReturnType<typeof fixture>, command: AttachmentOperationCommand) {
  const streamId = attachmentOperationStreamId({
    supportRequestId: f.input.supportRequestId,
    operationId: f.input.operationId,
  });
  const history = await f.input.eventStore.readStream({ streamId });
  const events = decideAttachmentOperation(replayAttachmentOperation(history.map(operationCodec.decode)), command);
  await f.input.eventStore.appendToStream({
    streamId,
    expectedVersion: history.length,
    context: f.input.context,
    events: events.map(operationCodec.encode),
  });
}

const claim = (references: readonly string[]): AttachmentOperationCommand => ({
  type: "ClaimSupportAttachmentReference",
  data: { evidenceId: "sev_synthetic_replay", attachments: references, submittedAt: "2026-10-14T00:00:00.000Z" },
});

describe("canonical Support evidence attachments", () => {
  it.each(["stored", "reference-claimed", "referenced"] as const)(
    "exact complete upload replay in %s verifies bytes without appends or puts",
    async (status) => {
      const f = fixture();
      f.input.uploads.push({ ...f.input.uploads[0] });
      f.storage.verifyPrivate.mockResolvedValue({ status: "match" });
      const first = await storeSupportEvidenceAttachments(f.input);
      if (status !== "stored") await transition(f, claim(first.map((item) => item.reference)));
      if (status === "referenced")
        await transition(f, {
          type: "ConfirmSupportAttachmentReferenced",
          data: { evidenceId: "sev_synthetic_replay" },
        });
      const before = [...f.allEvents];
      f.storage.verifyPrivate.mockClear();
      expect(await storeSupportEvidenceAttachments(f.input)).toEqual(first);
      expect(f.allEvents).toEqual(before);
      expect(f.storage.putPrivate).not.toHaveBeenCalled();
      expect(f.storage.verifyPrivate).toHaveBeenCalledTimes(2);
    },
  );

  it("exact upload replay remains read-only when a claim wins during verification before final reload", async () => {
    const f = fixture();
    f.storage.verifyPrivate.mockResolvedValue({ status: "match" });
    const first = await storeSupportEvidenceAttachments(f.input);
    f.storage.verifyPrivate.mockImplementationOnce(async () => {
      await transition(f, claim(first.map((item) => item.reference)));
      return { status: "match" };
    });
    const before = f.allEvents.length;
    expect(await storeSupportEvidenceAttachments(f.input)).toEqual(first);
    expect(f.allEvents.slice(before).map((event) => event.eventType)).toEqual([
      "support.attachment-operation.reference-claimed",
    ]);
    expect(f.storage.putPrivate).not.toHaveBeenCalled();
  });

  it.each(["reference-claimed", "referenced"] as const)(
    "%s upload replay rejects changed manifests, owners and failed byte verification without writes",
    async (status) => {
      const f = fixture();
      f.storage.verifyPrivate.mockResolvedValue({ status: "match" });
      const first = await storeSupportEvidenceAttachments(f.input);
      await transition(f, claim(first.map((item) => item.reference)));
      if (status === "referenced")
        await transition(f, {
          type: "ConfirmSupportAttachmentReferenced",
          data: { evidenceId: "sev_synthetic_replay" },
        });
      const before = [...f.allEvents];
      await expect(
        storeSupportEvidenceAttachments({ ...f.input, uploads: [...f.input.uploads, ...f.input.uploads] }),
      ).rejects.toMatchObject({ code: "operation-conflict" });
      await expect(
        storeSupportEvidenceAttachments({
          ...f.input,
          context: { ...context, audit: { ...context.audit, forAccountId: "acc_other" as never } },
        }),
      ).rejects.toMatchObject({ code: "operation-conflict" });
      for (const verification of [
        { status: "absent" },
        { status: "conflict", difference: "sha256" },
        { status: "unavailable", code: "transport-failed" },
      ] as const) {
        f.storage.verifyPrivate.mockResolvedValue(verification);
        await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
      }
      expect(f.allEvents).toEqual(before);
      expect(f.storage.putPrivate).not.toHaveBeenCalled();
    },
  );
  it.each([SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES, SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES + 1])(
    "independently enforces canonical output cap %i before staging",
    async (byteSize) => {
      const f = fixture();
      const result = await canonicalizeSupportEvidenceImage({
        body: f.input.uploads[0].body,
        declaredContentType: "image/jpeg",
      });
      if (result.kind !== "canonical") throw new Error("fixture must canonicalize");
      const body = Buffer.alloc(byteSize);
      f.input.canonicalizer = {
        canonicalize: async () => ({
          kind: "canonical",
          image: { ...result.image, body, byteSize, sha256: createHash("sha256").update(body).digest("hex") },
        }),
      };
      f.storage.verifyPrivate.mockResolvedValue({ status: "match" });
      if (byteSize === SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES)
        expect(await storeSupportEvidenceAttachments(f.input)).toHaveLength(1);
      else {
        await expect(storeSupportEvidenceAttachments(f.input)).rejects.toMatchObject({ code: "storage-unavailable" });
        expect(f.allEvents).toHaveLength(0);
        expect(f.storage.verifyPrivate).not.toHaveBeenCalled();
      }
      expect(f.storage.putPrivate).not.toHaveBeenCalled();
    },
  );

  it("late put responses cannot settle after the deadline; a same-id retry converges without re-put", async () => {
    const f = fixture();
    const put = f.storage.putPrivate.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.storage.putPrivate.mockImplementationOnce(async (input) => {
      const response = await put(input);
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response;
    });
    vi.useFakeTimers();
    try {
      const pending = storeSupportEvidenceAttachments(f.input);
      const rejected = expect(pending).rejects.toMatchObject({ code: "storage-unavailable" });
      await ready;
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      release();
      expect(f.allEvents.map((e) => e.eventType.split(".").at(-1))).toEqual(["staged", "put-admitted"]);
      expect(await storeSupportEvidenceAttachments(f.input)).toHaveLength(1);
      expect(f.storage.putPrivate).toHaveBeenCalledTimes(1);
      expect(f.allEvents.map((e) => e.eventType.split(".").at(-1))).toEqual(["staged", "put-admitted", "stored"]);
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });
  it("stages the full manifest before a tracked put, verifies independently, and retries without writes", async () => {
    const f = fixture();
    const first = await storeSupportEvidenceAttachments(f.input);
    expect(f.allEvents.map((e) => e.eventType)).toEqual([
      "support.attachment-operation.staged",
      "support.attachment-operation.put-admitted",
      "support.attachment-operation.put-settled",
      "support.attachment-operation.stored",
    ]);
    expect(first[0].attachmentId).toMatch(/^sea_[a-z2-7]{52}$/);
    expect(JSON.stringify(first)).not.toMatch(/private-name|support-evidence\//);
    expect(await storeSupportEvidenceAttachments(f.input)).toEqual(first);
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(1);
    expect(f.storage.verifyPrivate).toHaveBeenCalledTimes(3);
    expect(f.allEvents).toHaveLength(4);
  });

  it.each(["undecodable", "empty", "too-large", "type"])(
    "invalid %s image never stages or calls storage",
    async (kind) => {
      const f = fixture();
      f.input.uploads = [
        {
          body:
            kind === "empty"
              ? Buffer.alloc(0)
              : kind === "too-large"
                ? Buffer.alloc(SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES + 1)
                : Buffer.from([0xff, 0xd8, 0xff]),
          contentType: kind === "type" ? "application/pdf" : "image/jpeg",
          filename: "invalid",
        },
      ];
      await expect(storeSupportEvidenceAttachments(f.input)).rejects.toMatchObject({
        code: kind === "too-large" ? "too-large" : kind === "type" ? "invalid-content-type" : "invalid-content",
      });
      expect(f.allEvents).toHaveLength(0);
      expect(f.storage.putPrivate).not.toHaveBeenCalled();
      expect(f.storage.verifyPrivate).not.toHaveBeenCalled();
    },
  );

  it.each(["conflict", "unavailable"] as const)(
    "a %s pre-read never admits a put (pre-read-removed / unavailable-as-match controls)",
    async (status) => {
      const f = fixture();
      f.storage.verifyPrivate.mockResolvedValue(
        status === "conflict" ? { status, difference: "sha256" } : { status, code: "transport-failed" },
      );
      await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
      expect(f.storage.putPrivate).not.toHaveBeenCalled();
      expect(f.allEvents.some((e) => e.eventType.endsWith(".stored"))).toBe(false);
    },
  );

  it("matching existing canonical bytes converge with no put", async () => {
    const f = fixture();
    f.storage.verifyPrivate.mockResolvedValue({ status: "match" });
    expect(await storeSupportEvidenceAttachments(f.input)).toHaveLength(1);
    expect(f.storage.putPrivate).not.toHaveBeenCalled();
    expect(f.allEvents.map((e) => e.eventType)).toEqual([
      "support.attachment-operation.staged",
      "support.attachment-operation.stored",
    ]);
  });

  it.each(["absent", "conflict", "unavailable"] as const)("post-put %s never returns a reference", async (status) => {
    const f = fixture();
    f.storage.verifyPrivate
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce(
        status === "conflict"
          ? { status, difference: "byte-size" }
          : status === "unavailable"
            ? { status, code: "transport-failed" }
            : { status },
      );
    await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
    expect(f.allEvents.some((e) => e.eventType.endsWith(".stored"))).toBe(false);
  });

  it("legacy ids, keys and bytes stay byte-for-byte readable under capped readPrivate", async () => {
    const body = Buffer.from([0xff, 0xd8, 0xff]);
    const hash = createHash("sha256").update(body).digest("hex");
    const reference = `support-attachment:v1:sea_01ARZ3NDEKTSV4RRFFQ69G5FAV:${hash}:jpg`;
    const readPrivate = vi.fn<PrivateObjectStore["readPrivate"]>(async () => ({
      status: "found",
      body,
      byteSize: body.length,
      providerContentType: null,
    }));
    await expect(
      readSupportEvidenceAttachment({ supportRequestId: "sup_case", reference, storage: { readPrivate } as never }),
    ).resolves.toEqual({ body, contentType: "image/jpeg" });
    expect(readPrivate).toHaveBeenCalledWith(`support-evidence/sup_case/sea_01ARZ3NDEKTSV4RRFFQ69G5FAV/${hash}.jpg`, {
      maxBytes: SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES,
      deadlineMs: 30_000,
    });
  });

  it.each(["hash", "provider-type", "cap+1", "absent", "unavailable"])(
    "download denies %s instead of serving unchecked bytes",
    async (kind) => {
      const body = Buffer.alloc(kind === "cap+1" ? SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES + 1 : 3);
      const hash = createHash("sha256")
        .update(kind === "hash" ? Buffer.from([1]) : body)
        .digest("hex");
      const readPrivate = vi.fn<PrivateObjectStore["readPrivate"]>(async () =>
        kind === "absent"
          ? { status: "absent" }
          : kind === "unavailable"
            ? { status: "unavailable", code: "transport-failed" }
            : {
                status: "found",
                body,
                byteSize: body.length,
                providerContentType: kind === "provider-type" ? "image/png" : "image/jpeg",
              },
      );
      const read = readSupportEvidenceAttachment({
        supportRequestId: "sup_case",
        reference: `support-attachment:v1:sea_legacy:${hash}:jpg`,
        storage: { readPrivate } as never,
      });
      if (kind === "unavailable") await expect(read).rejects.toMatchObject({ code: "storage-unavailable" });
      else await expect(read).resolves.toBeNull();
    },
  );

  it("download accepts the exact cap", async () => {
    const body = Buffer.alloc(SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES);
    const hash = createHash("sha256").update(body).digest("hex");
    const storage = {
      readPrivate: vi.fn(async () => ({
        status: "found",
        body,
        byteSize: body.length,
        providerContentType: "image/jpeg",
      })),
    };
    expect(
      (
        await readSupportEvidenceAttachment({
          supportRequestId: "sup_case",
          reference: `support-attachment:v1:sea_legacy:${hash}:jpg`,
          storage: storage as never,
        })
      )?.body,
    ).toBe(body);
  });
});
