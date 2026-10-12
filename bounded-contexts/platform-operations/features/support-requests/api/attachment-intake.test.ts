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

  for (const { label, contentType, boundary, name, code, status } of [
    {
      label: "P1 space before the parameter separator",
      contentType: "multipart/form-data ; boundary=SYNB",
      boundary: "SYNB",
      name: '"attachments"',
      code: "too-many-files",
      status: 413,
    },
    {
      label: "P2 quoted decoy boundary parameter",
      contentType: 'multipart/form-data; x="; boundary=DECOY"; boundary=SYNB',
      boundary: "SYNB",
      name: '"attachments"',
      code: "too-many-files",
      status: 413,
    },
    {
      label: "P3 backslash before the closing name quote",
      contentType: "multipart/form-data; boundary=SYNB",
      boundary: "SYNB",
      name: '"a\\"',
      code: "too-many-files",
      status: 413,
    },
    {
      label: "P4 non-ASCII boundary",
      contentType: "multipart/form-data; boundary=SYN\u00e9B",
      boundary: "SYN\u00e9B",
      name: '"attachments"',
      code: "invalid-multipart",
      status: 400,
    },
    {
      label: "P5 tab before the parameter separator",
      contentType: "multipart/form-data\t; boundary=SYNB",
      boundary: "SYNB",
      name: '"attachments"',
      code: "too-many-files",
      status: 413,
    },
    {
      label: "P6/C1 comma-joined Content-Type list ending in multipart",
      contentType: "text/plain, multipart/form-data; boundary=SYNB",
      boundary: "SYNB",
      name: '"attachments"',
      code: "invalid-multipart",
      status: 400,
    },
    {
      label: "P6/C2 urlencoded essence followed by multipart",
      contentType: "application/x-www-form-urlencoded, multipart/form-data; boundary=SYNB",
      boundary: "SYNB",
      name: '"attachments"',
      code: "invalid-multipart",
      status: 400,
    },
    {
      label: "P6/C3 appended Content-Type values ending in multipart",
      contentType: ["text/plain", "multipart/form-data; boundary=SYNB"],
      boundary: "SYNB",
      name: '"attachments"',
      code: "invalid-multipart",
      status: 400,
    },
    {
      label: "P6/C4 wildcard essence followed by multipart",
      contentType: "*/*, multipart/form-data; boundary=SYNB",
      boundary: "SYNB",
      name: '"attachments"',
      code: "invalid-multipart",
      status: 400,
    },
    {
      label: "P6/C9 garbage essence followed by multipart",
      contentType: "x, multipart/form-data; boundary=SYNB",
      boundary: "SYNB",
      name: '"attachments"',
      code: "invalid-multipart",
      status: 400,
    },
  ]) {
    it(`rejects synthetic parser differential ${label} before native materialization`, async () => {
      const bytes = new TextEncoder().encode(
        Array.from(
          { length: 6 },
          (_, index) =>
            `--${boundary}\r\nContent-Disposition: form-data; name=${name}; filename="synthetic-${index}.jpg"\r\nContent-Type: image/jpeg\r\n\r\nSYNTHETIC${index}\r\n`,
        ).join("") + `--${boundary}--\r\n`,
      );
      const headers = new Headers({ "content-length": String(bytes.byteLength) });
      for (const value of Array.isArray(contentType) ? contentType : [contentType])
        headers.append("content-type", value);
      const request = new Request("http://synthetic.invalid/", {
        method: "POST",
        headers,
        body: bytes,
      });
      const parse = vi.spyOn(Response.prototype, "formData");
      try {
        await expect(readSupportAttachmentFormData(request)).rejects.toMatchObject({ code, status });
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    });
  }

  it("maps post-bound native parse failure to invalid-multipart", async () => {
    const bytes = new TextEncoder().encode("--SYNB\r\nmalformed synthetic part");
    const request = new Request("http://synthetic.invalid/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=SYNB", "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      await expect(readSupportAttachmentFormData(request)).rejects.toMatchObject({
        code: "invalid-multipart",
        status: 400,
      });
      expect(parse).toHaveBeenCalledOnce();
      expect(request.bodyUsed).toBe(true);
    } finally {
      parse.mockRestore();
    }
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
