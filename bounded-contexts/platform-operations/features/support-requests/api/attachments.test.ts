import { describe, expect, it, vi } from "vitest";
import {
  SupportEvidenceAttachmentError,
  readSupportEvidenceAttachment,
  storeSupportEvidenceAttachments,
} from "./attachments";

function jpegBody() {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
}

describe("support evidence attachments", () => {
  it("stores case-scoped images privately without exposing storage metadata", async () => {
    const putObject = vi.fn(async (input: { key: string }) => ({
      key: input.key,
      publicUrl: "https://must-not-be-used.example.test/private-object",
    }));

    const attachments = await storeSupportEvidenceAttachments({
      supportRequestId: "sup_case",
      uploads: [{ body: jpegBody(), contentType: "image/jpeg", filename: "damaged-card.jpg" }],
      storage: { putObject, getObject: vi.fn(), deleteObjects: vi.fn() },
    });

    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(/^support-evidence\/sup_case\/sea_/),
        visibility: "private",
        cacheControl: "private, no-store",
      }),
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ contentType: "image/jpeg", byteSize: jpegBody().byteLength });
    expect(attachments[0]?.reference).toMatch(/^support-attachment:v1:sea_[^:]+:[a-f0-9]{64}:jpg$/);
    expect(JSON.stringify(attachments)).not.toContain("damaged-card.jpg");
    expect(JSON.stringify(attachments)).not.toContain("support-evidence/");
    expect(JSON.stringify(attachments)).not.toContain("must-not-be-used");
  });

  it("validates every image before writing and rejects unsafe content", async () => {
    const putObject = vi.fn();

    await expect(
      storeSupportEvidenceAttachments({
        supportRequestId: "sup_case",
        uploads: [
          { body: jpegBody(), contentType: "image/jpeg", filename: "valid.jpg" },
          { body: new Uint8Array([1, 2, 3]), contentType: "image/png", filename: "spoofed.png" },
        ],
        storage: { putObject, getObject: vi.fn(), deleteObjects: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: "invalid-content" } satisfies Partial<SupportEvidenceAttachmentError>);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("rolls back the batch when object storage fails part way through", async () => {
    const deleteObjects = vi.fn(async () => undefined);
    const putObject = vi
      .fn()
      .mockImplementationOnce(async (input: { key: string }) => ({ key: input.key, publicUrl: "private" }))
      .mockRejectedValueOnce(new Error("storage offline"));

    await expect(
      storeSupportEvidenceAttachments({
        supportRequestId: "sup_case",
        uploads: [
          { body: jpegBody(), contentType: "image/jpeg", filename: "one.jpg" },
          { body: jpegBody(), contentType: "image/jpeg", filename: "two.jpg" },
        ],
        storage: { putObject, getObject: vi.fn(), deleteObjects },
      }),
    ).rejects.toMatchObject({ code: "storage-unavailable" } satisfies Partial<SupportEvidenceAttachmentError>);
    expect(deleteObjects).toHaveBeenCalledWith([expect.stringMatching(/^support-evidence\/sup_case\//)]);
  });

  it("reads only the case-scoped object encoded by an opaque reference", async () => {
    const body = jpegBody();
    let storedKey = "";
    const storage = {
      putObject: vi.fn(async (input: { key: string }) => {
        storedKey = input.key;
        return { key: input.key, publicUrl: "private" };
      }),
      getObject: vi.fn(async (key: string) => (key === storedKey ? { body, contentType: "image/jpeg" } : null)),
      deleteObjects: vi.fn(),
    };
    const [attachment] = await storeSupportEvidenceAttachments({
      supportRequestId: "sup_case",
      uploads: [{ body, contentType: "image/jpeg", filename: "card.jpg" }],
      storage,
    });

    await expect(
      readSupportEvidenceAttachment({
        supportRequestId: "sup_case",
        reference: attachment!.reference,
        storage,
      }),
    ).resolves.toEqual({ body, contentType: "image/jpeg" });
    await expect(
      readSupportEvidenceAttachment({
        supportRequestId: "sup_other",
        reference: attachment!.reference,
        storage,
      }),
    ).resolves.toBeNull();
  });
});
