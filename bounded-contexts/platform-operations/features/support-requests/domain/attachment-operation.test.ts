import { describe, expect, it } from "vitest";
import {
  attachmentOperationStreamId,
  canonicalJson,
  createAttachmentManifest,
  deriveSupportEvidenceAttachmentId,
  decideAttachmentOperation,
  replayAttachmentOperation,
  type AttachmentOperationEvent,
} from "./attachment-operation";
import { parseSupportEvidenceAttachmentReference } from "./attachment-reference";

const owner = {
  tenantId: "tnt_identity",
  accountId: "acc_owner",
  supportRequestId: "sup_case",
  operationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};
const fingerprint = {
  profile: "support-evidence-raster/v1",
  sharp: "test",
  libvips: "test",
  platform: "test",
  arch: "test",
  libc: "test",
};
const images = [
  { canonicalSha256: "a".repeat(64), contentType: "image/jpeg" as const, byteSize: 3 },
  { canonicalSha256: "b".repeat(64), contentType: "image/png" as const, byteSize: 4 },
];
const manifest = () =>
  createAttachmentManifest({ owner, profile: fingerprint.profile, encoderFingerprint: fingerprint, images });
const stage = (): AttachmentOperationEvent => ({ type: "support.attachment-operation.staged", data: manifest() });
const admitted = (index = 0, attempt = 1): AttachmentOperationEvent => ({
  type: "support.attachment-operation.put-admitted",
  data: { index, attempt },
});
const settled = (index = 0, attempt = 1): AttachmentOperationEvent => ({
  type: "support.attachment-operation.put-settled",
  data: { index, attempt, outcome: "completed" },
});
const stored = (index = 0): AttachmentOperationEvent => ({
  type: "support.attachment-operation.stored",
  data: { index },
});
const cleanup: AttachmentOperationEvent = {
  type: "support.attachment-operation.cleanup-required",
  data: { reason: "verification-conflict" },
};

describe("Support Attachment Operation", () => {
  it("rejects array-coerced canonical hashes rather than replaying poisoned manifest authority", () => {
    expect(() =>
      createAttachmentManifest({
        owner,
        profile: fingerprint.profile,
        encoderFingerprint: fingerprint,
        images: [{ ...images[0], canonicalSha256: [images[0].canonicalSha256] as never }],
      }),
    ).toThrow();
    expect(() =>
      deriveSupportEvidenceAttachmentId({ ...owner, index: 0, canonicalSha256: [images[0].canonicalSha256] as never }),
    ).toThrow();
  });
  it("malformed settlement cannot become a no-op because the attempt is missing", () => {
    expect(() =>
      decideAttachmentOperation(replayAttachmentOperation([stage()]), {
        type: "SettleSupportAttachmentPut",
        data: { index: 0, attempt: 1, outcome: undefined },
      } as never),
    ).toThrow();
  });
  it("derives full base32 SHA-256 tuple ids, with stable, disjoint case/operation/index/owner vectors", () => {
    const id = deriveSupportEvidenceAttachmentId({ ...owner, index: 0, canonicalSha256: "a".repeat(64) });
    expect(id).toMatch(/^sea_[a-z2-7]{52}$/);
    expect(id).toBe("sea_5l4i2aaiowepin26edebas6unzcgpphud455feyu24ov5jmocbma");
    expect(id).toBe(deriveSupportEvidenceAttachmentId({ ...owner, index: 0, canonicalSha256: "a".repeat(64) }));
    for (const change of [
      { supportRequestId: "sup_other" },
      { operationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAW" },
      { index: 1 },
      { accountId: "acc_other" },
      { tenantId: "tnt_other" },
      { canonicalSha256: "b".repeat(64) },
    ])
      expect(
        deriveSupportEvidenceAttachmentId({ ...owner, index: 0, canonicalSha256: "a".repeat(64), ...change }),
      ).not.toBe(id);
    expect(
      parseSupportEvidenceAttachmentReference(`support-attachment:v1:${id}:${"a".repeat(64)}:jpg`)?.attachmentId,
    ).toBe(id);
    expect(attachmentOperationStreamId(owner)).toBe(`support.attachment-operation-sup_case-${owner.operationId}`);
  });

  it("canonical JSON sorts object keys, preserves manifest order, and pins all authority fields", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    expect(manifest().manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest().items.map((i) => i.index)).toEqual([0, 1]);
    expect(manifest().items[0].attachmentId).not.toBe(manifest().items[1].attachmentId);
  });

  it("transitions absent -> staged -> partially-stored -> stored, suppressing exact retry and terminal duplicates", () => {
    const events = decideAttachmentOperation(replayAttachmentOperation([]), {
      type: "StageSupportAttachmentOperation",
      data: manifest(),
    });
    expect(events).toEqual([stage()]);
    const staged = replayAttachmentOperation(events);
    expect(staged.status).toBe("staged");
    expect(decideAttachmentOperation(staged, { type: "StageSupportAttachmentOperation", data: manifest() })).toEqual(
      [],
    );
    expect(
      decideAttachmentOperation(staged, { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 1 } }),
    ).toEqual([admitted()]);
    const partial = replayAttachmentOperation([stage(), admitted(), settled(), stored()]);
    expect(partial.status).toBe("partially-stored");
    expect(decideAttachmentOperation(partial, { type: "RecordSupportAttachmentStored", data: { index: 0 } })).toEqual(
      [],
    );
    expect(replayAttachmentOperation([stage(), stored(), stored(1)]).status).toBe("stored");
    expect(() =>
      decideAttachmentOperation(partial, { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 2 } }),
    ).toThrow();
  });

  it.each(["owner", "order", "bytes", "profile", "fingerprint"])(
    "changed %s retry conflicts before an append",
    (field) => {
      const changed =
        field === "owner"
          ? createAttachmentManifest({
              owner: { ...owner, accountId: "acc_other" },
              profile: fingerprint.profile,
              encoderFingerprint: fingerprint,
              images,
            })
          : field === "order"
            ? createAttachmentManifest({
                owner,
                profile: fingerprint.profile,
                encoderFingerprint: fingerprint,
                images: [...images].reverse(),
              })
            : field === "bytes"
              ? createAttachmentManifest({
                  owner,
                  profile: fingerprint.profile,
                  encoderFingerprint: fingerprint,
                  images: [images[0], { ...images[1], canonicalSha256: "c".repeat(64) }],
                })
              : field === "profile"
                ? { ...manifest(), profile: "other" }
                : createAttachmentManifest({
                    owner,
                    profile: fingerprint.profile,
                    encoderFingerprint: { ...fingerprint, sharp: "other" },
                    images,
                  });
      expect(() =>
        decideAttachmentOperation(replayAttachmentOperation([stage()]), {
          type: "StageSupportAttachmentOperation",
          data: changed,
        }),
      ).toThrow();
    },
  );

  it("ambiguous admissions remain unresolved, can converge by pre-read, and count only actual settlements", () => {
    const state = replayAttachmentOperation([stage(), admitted(), admitted(0, 2), settled(0, 2), stored()]);
    expect(state.attempts[0]).toEqual([
      { attempt: 1, outcome: null },
      { attempt: 2, outcome: "completed" },
    ]);
    expect(
      decideAttachmentOperation(state, {
        type: "SettleSupportAttachmentPut",
        data: { index: 0, attempt: 2, outcome: "completed" },
      }),
    ).toEqual([]);
    expect(() =>
      decideAttachmentOperation(state, {
        type: "SettleSupportAttachmentPut",
        data: { index: 0, attempt: 2, outcome: "failed" },
      }),
    ).toThrow();
  });

  it.each([[], [stage()], [stage(), stored()], [stage(), stored(), stored(1)]].map((history) => ({ history })))(
    "cleanup is terminal from every prior state %#",
    ({ history }) => {
      const events = decideAttachmentOperation(replayAttachmentOperation(history), {
        type: "RequireSupportAttachmentCleanup",
        data: cleanup.data,
      });
      const state = replayAttachmentOperation([...history, ...events]);
      expect(state.status).toBe("cleanup-required");
      expect(decideAttachmentOperation(state, { type: "RequireSupportAttachmentCleanup", data: cleanup.data })).toEqual(
        [],
      );
      expect(() =>
        decideAttachmentOperation(state, { type: "AdmitSupportAttachmentPut", data: { index: 1, attempt: 1 } }),
      ).toThrow();
      expect(() =>
        decideAttachmentOperation(state, { type: "RecordSupportAttachmentStored", data: { index: 1 } }),
      ).toThrow();
    },
  );

  it.each(
    [
      [stored()],
      [admitted()],
      [settled()],
      [stage(), stage()],
      [stage(), settled()],
      [stage(), admitted(), admitted()],
      [stage(), admitted(0, 2)],
      [stage(), admitted(-1)],
      [stage(), admitted(2)],
      [stage(), stored(), stored()],
      [
        stage(),
        admitted(),
        { type: "support.attachment-operation.put-settled", data: { index: 0, attempt: 1, outcome: "failed" } },
        admitted(1),
      ],
      [
        stage(),
        admitted(),
        { type: "support.attachment-operation.put-settled", data: { index: 0, attempt: 1, outcome: "failed" } },
        stored(1),
      ],
      [stage(), stored(), admitted()],
      [stage(), admitted(), settled(), settled()],
      [
        stage(),
        admitted(),
        { type: "support.attachment-operation.put-settled", data: { index: 0, attempt: 1, outcome: ["completed"] } },
      ],
      [stage(), { type: "support.attachment-operation.cleanup-required", data: { reason: ["verification-conflict"] } }],
      [stage(), cleanup, admitted()],
      [stage(), cleanup, stored()],
      [stage(), cleanup, stage()],
      [{ type: "support.attachment-operation.reference-claimed", data: {} }],
      [{ type: "support.attachment-operation.cleanup-claimed", data: {} }],
      [{ type: "unknown", data: {} }],
      [{ ...stage(), data: { ...manifest(), manifestFingerprint: "0".repeat(64) } }],
      [{ ...stage(), data: { ...manifest(), extra: true } }],
      [{ ...stage(), data: { ...manifest(), items: [{ ...manifest().items[0], index: 1 }] } }],
      [{ ...stage(), data: { ...manifest(), items: [{ ...manifest().items[0], attachmentId: "sea_random" }] } }],
    ].map((history) => ({ history })),
  )("rejects poisoned history %# instead of normalizing it into authority", ({ history }) => {
    expect(() => replayAttachmentOperation(history as AttachmentOperationEvent[])).toThrow();
  });
});
