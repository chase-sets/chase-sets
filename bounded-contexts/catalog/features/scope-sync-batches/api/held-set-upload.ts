import { HeldSetExportError, heldSetExportContract } from "../domain/held-set-export";

export async function readHeldSetExportUpload(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HeldSetExportError("invalid-upload", "Held-set export must be a multipart CSV upload.");
  }
  const formData = await readBoundedMultipartFormData(request, heldSetExportContract.multipartMaxBytes);
  if (
    [...formData.keys()].some((key) => key !== heldSetExportContract.fileField) ||
    formData.getAll(heldSetExportContract.fileField).length !== 1
  ) {
    throw new HeldSetExportError("invalid-upload", "Held-set upload accepts exactly one file field.");
  }
  const file = formData.get(heldSetExportContract.fileField);
  if (!(file instanceof File)) {
    throw new HeldSetExportError("invalid-upload", "Held-set export CSV is required.");
  }
  if (file.size > heldSetExportContract.maxBytes) {
    throw new HeldSetExportError("upload-too-large", "Held-set export exceeds 16777216 bytes.");
  }
  return new Uint8Array(await file.arrayBuffer());
}

export async function readBoundedMultipartFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HeldSetExportError("invalid-upload", "Multipart form data is required.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new HeldSetExportError("upload-too-large", "Held-set upload exceeds the multipart request limit.");
  }
  const body = await readBoundedBody(request.body, maxBytes);
  try {
    return await new Response(new Blob([Uint8Array.from(body).buffer]), {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new HeldSetExportError("invalid-upload", "Held-set upload is not valid multipart form data.");
  }
}

async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) throw new HeldSetExportError("invalid-upload", "Held-set upload body is required.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new HeldSetExportError("upload-too-large", "Held-set upload exceeds the multipart request limit.");
    }
    chunks.push(chunk);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
