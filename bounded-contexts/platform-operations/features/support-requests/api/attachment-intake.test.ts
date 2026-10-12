// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readSupportAttachmentFormData } from "./attachment-intake";
import { multipartRequest, openingPhotoForm } from "../tests/attachment-intake.test-support";

describe("Support attachment intake", () => {
  for (const length of ["invalid", "1", "100"]) {
    it(`rejects malformed or mismatched declared length ${length} without parsing`, async () => {
      const request = new Request("http://localhost", {
        method: "POST",
        body: "a=123",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": length },
      });
      const parse = vi.spyOn(Response.prototype, "formData");
      try {
        await expect(readSupportAttachmentFormData(request)).rejects.toMatchObject({
          code: "invalid-content-length",
          status: 400,
        });
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    });
  }

  it("materializes five files and ordinary fields after bounded reading", async () => {
    const request = await multipartRequest("http://localhost", await openingPhotoForm());
    const form = await readSupportAttachmentFormData(request);
    expect(form.getAll("attachments")).toHaveLength(5);
    expect(form.get("attachmentOperationId")).toBe("sao_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  for (const count of [5, 6]) {
    it(`inspects ${count} file parts across single-byte boundary/header chunks`, async () => {
      const encoded = await multipartRequest("http://localhost", await openingPhotoForm(count));
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      let offset = 0;
      const request = new Request(encoded.url, {
        method: "POST",
        headers: encoded.headers,
        duplex: "half",
        body: new ReadableStream({
          pull(c) {
            if (offset < bytes.length) c.enqueue(bytes.slice(offset, ++offset));
            else c.close();
          },
        }),
      } as RequestInit);
      if (count === 5) expect((await readSupportAttachmentFormData(request)).getAll("attachments")).toHaveLength(5);
      else await expect(readSupportAttachmentFormData(request)).rejects.toMatchObject({ code: "too-many-files" });
    });
  }
});
