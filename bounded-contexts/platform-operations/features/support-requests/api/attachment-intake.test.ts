// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readSupportAttachmentFormData } from "./attachment-intake";
import { multipartRequest, openingPhotoForm } from "./attachment-intake.test-support";

describe("Support attachment intake", () => {
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
