import { describe, expect, it, vi } from "vitest";
import {
  RETURN_INTAKE_EVIDENCE_MAX_BYTES,
  ReturnIntakeEvidenceError,
  storeReturnIntakeEvidence,
  verifyStoredReturnIntakeEvidence,
} from "./evidence";

function jpegBody() {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
}

describe("return intake evidence", () => {
  it("stores validated evidence privately with retention and a digest", async () => {
    const putObject = vi.fn(async (input: { key: string }) => ({ key: input.key, publicUrl: "must-not-be-used" }));
    const attachment = await storeReturnIntakeEvidence({
      facilityId: "fac_east",
      uploadedAt: "2026-07-14T12:00:00.000Z",
      upload: { body: jpegBody(), contentType: "image/jpeg", filename: "package.jpg" },
      storage: { putObject, getObject: vi.fn(), deleteObjects: vi.fn() },
    });

    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "private", cacheControl: "private, no-store" }),
    );
    expect(attachment.storageKey).toContain("return-intake/fac_east/");
    expect(attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attachment.securityScanStatus).toBe("clean");
    expect(Date.parse(attachment.retentionUntil)).toBeGreaterThan(Date.parse(attachment.uploadedAt));
    expect(JSON.stringify(attachment)).not.toContain("package.jpg");
  });

  it.each([
    [
      "unsupported content type",
      { body: jpegBody(), contentType: "application/pdf", filename: "x.pdf" },
      "invalid-content-type",
    ],
    [
      "mismatched signature",
      { body: new Uint8Array([1, 2, 3]), contentType: "image/png", filename: "x.png" },
      "invalid-content",
    ],
    [
      "oversized body",
      { body: new Uint8Array(RETURN_INTAKE_EVIDENCE_MAX_BYTES + 1), contentType: "image/jpeg", filename: "x.jpg" },
      "too-large",
    ],
  ])("rejects %s", async (_label, upload, code) => {
    await expect(
      storeReturnIntakeEvidence({
        facilityId: "fac_east",
        uploadedAt: "2026-07-14T12:00:00.000Z",
        upload,
        storage: { putObject: vi.fn(), getObject: vi.fn(), deleteObjects: vi.fn() },
      }),
    ).rejects.toMatchObject({
      code: code as ReturnIntakeEvidenceError["code"],
    } satisfies Partial<ReturnIntakeEvidenceError>);
  });

  it("fails closed when the security scan rejects the file", async () => {
    await expect(
      storeReturnIntakeEvidence({
        facilityId: "fac_east",
        uploadedAt: "2026-07-14T12:00:00.000Z",
        upload: { body: jpegBody(), contentType: "image/jpeg", filename: "x.jpg" },
        storage: { putObject: vi.fn(), getObject: vi.fn(), deleteObjects: vi.fn() },
        securityScanner: { scan: vi.fn(async () => "rejected" as const) },
      }),
    ).rejects.toMatchObject({ code: "security-rejected" });
  });

  it("verifies the facility path, attachment identity, digest, type, and byte size before intake", async () => {
    const body = jpegBody();
    const storage = {
      putObject: vi.fn(async (input: { key: string }) => ({ key: input.key, publicUrl: "private" })),
      getObject: vi.fn(async () => ({ body, contentType: "image/jpeg" })),
      deleteObjects: vi.fn(),
    };
    const attachment = await storeReturnIntakeEvidence({
      facilityId: "fac_east",
      uploadedAt: "2026-07-14T12:00:00.000Z",
      upload: { body, contentType: "image/jpeg", filename: "package.jpg" },
      storage,
    });

    await expect(
      verifyStoredReturnIntakeEvidence({ facilityId: "fac_east", attachments: [attachment], storage }),
    ).resolves.toBeUndefined();
    await expect(
      verifyStoredReturnIntakeEvidence({ facilityId: "fac_west", attachments: [attachment], storage }),
    ).rejects.toMatchObject({ code: "invalid-content" });
  });

  it("validates upload timestamps before writing an object", async () => {
    const putObject = vi.fn();
    await expect(
      storeReturnIntakeEvidence({
        facilityId: "fac_east",
        uploadedAt: "not-a-timestamp",
        upload: { body: jpegBody(), contentType: "image/jpeg", filename: "package.jpg" },
        storage: { putObject, getObject: vi.fn(), deleteObjects: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: "invalid-content" });
    expect(putObject).not.toHaveBeenCalled();
  });
});
