import { HeldSetExportError, heldSetExportContract } from "../domain/held-set-export";

export async function readHeldSetExportUpload(request: Request): Promise<Uint8Array> {
  return (await readHeldSetMultipart(request, [])).bytes;
}

export async function readHeldSetExportAdminUpload(
  request: Request,
): Promise<Readonly<{ file: File; intent: "resolve-held-sets" }>> {
  const parsed = await readHeldSetMultipart(request, ["intent"]);
  if (parsed.fields.intent !== "resolve-held-sets") invalidUpload("Held-set upload intent is invalid.");
  return {
    file: new File([parsed.bytes], parsed.fileName, { type: parsed.fileContentType ?? "text/csv" }),
    intent: "resolve-held-sets",
  };
}

type ParsedMultipart = Readonly<{
  bytes: Uint8Array;
  fields: Readonly<Record<string, string>>;
  fileName: string;
  fileContentType: string | null;
}>;

type Part = Readonly<{
  name: string;
  fileName: string | null;
  contentType: string | null;
}>;

const encoder = new TextEncoder();
const headerSeparator = encoder.encode("\r\n\r\n");
const lineBreak = encoder.encode("\r\n");
const finalMarker = encoder.encode("--");
const maxHeaderBytes = 8_192;
const maxTextFieldBytes = 256;

async function readHeldSetMultipart(request: Request, textFieldNames: readonly string[]): Promise<ParsedMultipart> {
  const contentType = request.headers.get("content-type") ?? "";
  const boundary = multipartBoundary(contentType);
  const body = request.body;
  if (!boundary || !body) invalidUpload("Held-set export must be a multipart CSV upload.");

  const wireLimit = heldSetExportContract.maxBytes + heldSetExportContract.multipartFramingMaxBytes;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > wireLimit)) {
    await body.cancel().catch(() => undefined);
    uploadTooLarge("Held-set upload exceeds the multipart request limit.");
  }

  const reader = body.getReader();
  const openingBoundary = encoder.encode(`--${boundary}`);
  const partBoundary = encoder.encode(`\r\n--${boundary}`);
  const fileChunks: Uint8Array[] = [];
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  let buffer = new Uint8Array();
  let ended = false;
  let wireBytes = 0;
  let framingBytes = 0;
  let fileBytes = 0;
  let fileName = "";
  let fileContentType: string | null = null;

  const countFraming = (count: number) => {
    framingBytes += count;
    if (framingBytes > heldSetExportContract.multipartFramingMaxBytes) {
      uploadTooLarge("Held-set upload exceeds the multipart framing limit.");
    }
  };
  const readMore = async (): Promise<boolean> => {
    if (ended) return false;
    const next = await reader.read();
    if (next.done) {
      ended = true;
      return false;
    }
    wireBytes += next.value.byteLength;
    if (wireBytes > wireLimit) uploadTooLarge("Held-set upload exceeds the multipart request limit.");
    buffer = concat(buffer, next.value);
    return true;
  };
  const requireBytes = async (count: number, tooLargeAfter: number | null = null) => {
    while (buffer.byteLength < count) {
      if (tooLargeAfter !== null && buffer.byteLength > tooLargeAfter) {
        uploadTooLarge("Held-set upload exceeds the multipart framing limit.");
      }
      if (!(await readMore())) invalidUpload("Held-set upload is not valid multipart form data.");
    }
  };
  const consume = (count: number, framing = true) => {
    if (framing) countFraming(count);
    buffer = buffer.slice(count);
  };
  const appendFile = (bytes: Uint8Array) => {
    if (fileBytes + bytes.byteLength > heldSetExportContract.maxBytes) {
      uploadTooLarge("Held-set export exceeds 16777216 bytes.");
    }
    if (bytes.byteLength > 0) fileChunks.push(bytes.slice());
    fileBytes += bytes.byteLength;
  };

  try {
    await requireBytes(openingBoundary.byteLength + lineBreak.byteLength, maxHeaderBytes);
    if (!startsWith(buffer, openingBoundary) || !matchesAt(buffer, openingBoundary.byteLength, lineBreak)) {
      invalidUpload("Held-set upload is not valid multipart form data.");
    }
    consume(openingBoundary.byteLength + lineBreak.byteLength);

    let closed = false;
    while (!closed) {
      let headerEnd = indexOf(buffer, headerSeparator);
      while (headerEnd < 0) {
        if (buffer.byteLength > maxHeaderBytes) uploadTooLarge("Held-set upload exceeds the multipart framing limit.");
        if (!(await readMore())) invalidUpload("Held-set upload is not valid multipart form data.");
        headerEnd = indexOf(buffer, headerSeparator);
      }
      if (headerEnd > maxHeaderBytes) uploadTooLarge("Held-set upload exceeds the multipart framing limit.");
      const part = parsePartHeaders(buffer.slice(0, headerEnd), textFieldNames);
      if (seen.has(part.name)) invalidUpload("Held-set upload accepts each field exactly once.");
      seen.add(part.name);
      consume(headerEnd + headerSeparator.byteLength);

      const partChunks: Uint8Array[] = [];
      let partBytes = 0;
      const appendPart = (bytes: Uint8Array) => {
        if (part.name === heldSetExportContract.fileField) {
          appendFile(bytes);
          return;
        }
        partBytes += bytes.byteLength;
        if (partBytes > maxTextFieldBytes) invalidUpload("Held-set upload field is too large.");
        if (bytes.byteLength > 0) partChunks.push(bytes.slice());
        countFraming(bytes.byteLength);
      };

      while (true) {
        const boundaryMatch = findBoundary(buffer, partBoundary);
        if (boundaryMatch.kind === "valid") {
          appendPart(buffer.slice(0, boundaryMatch.index));
          buffer = buffer.slice(boundaryMatch.index + partBoundary.byteLength);
          countFraming(partBoundary.byteLength);
          break;
        }
        if (boundaryMatch.kind === "incomplete") {
          appendPart(buffer.slice(0, boundaryMatch.index));
          buffer = buffer.slice(boundaryMatch.index);
        } else {
          const retainedBytes = Math.min(buffer.byteLength, partBoundary.byteLength + 1);
          appendPart(buffer.slice(0, buffer.byteLength - retainedBytes));
          buffer = buffer.slice(buffer.byteLength - retainedBytes);
        }
        if (!(await readMore())) invalidUpload("Held-set upload is not valid multipart form data.");
      }

      if (part.name === heldSetExportContract.fileField) {
        fileName = part.fileName ?? "";
        fileContentType = part.contentType;
      } else {
        try {
          fields[part.name] = new TextDecoder("utf-8", { fatal: true }).decode(join(partChunks, partBytes));
        } catch {
          invalidUpload("Held-set upload fields must be UTF-8.");
        }
      }

      await requireBytes(2, maxHeaderBytes);
      if (startsWith(buffer, finalMarker)) {
        consume(finalMarker.byteLength);
        closed = true;
      } else if (startsWith(buffer, lineBreak)) {
        consume(lineBreak.byteLength);
      } else {
        invalidUpload("Held-set upload is not valid multipart form data.");
      }
    }

    while (!ended) await readMore();
    if (buffer.byteLength === lineBreak.byteLength && startsWith(buffer, lineBreak)) consume(lineBreak.byteLength);
    if (buffer.byteLength !== 0) invalidUpload("Held-set upload is not valid multipart form data.");
    if (!seen.has(heldSetExportContract.fileField) || !fileName) {
      invalidUpload("Held-set export CSV is required.");
    }
    if (textFieldNames.some((name) => !seen.has(name)) || seen.size !== textFieldNames.length + 1) {
      invalidUpload("Held-set upload accepts exactly its declared fields.");
    }

    return { bytes: join(fileChunks, fileBytes), fields, fileName, fileContentType };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function multipartBoundary(contentType: string): string | null {
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return null;
  const match = /(?:^|;)\s*boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))(?:\s*;|\s*$)/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2] ?? null;
  return boundary && !/[\r\n]/u.test(boundary) ? boundary : null;
}

function parsePartHeaders(bytes: Uint8Array, textFieldNames: readonly string[]): Part {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidUpload("Held-set upload headers must be UTF-8.");
  }
  const headers = new Map<string, string>();
  for (const line of text.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) invalidUpload("Held-set upload contains malformed part headers.");
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(name) || headers.has(name)) {
      invalidUpload("Held-set upload contains malformed part headers.");
    }
    headers.set(name, line.slice(separator + 1).trim());
  }
  if ([...headers.keys()].some((name) => name !== "content-disposition" && name !== "content-type")) {
    invalidUpload("Held-set upload contains unsupported part headers.");
  }

  const disposition = headers.get("content-disposition");
  if (!disposition) invalidUpload("Held-set upload part disposition is required.");
  const pieces = disposition.split(";").map((piece) => piece.trim());
  if (pieces.shift()?.toLowerCase() !== "form-data") invalidUpload("Held-set upload part disposition is invalid.");
  const parameters = new Map<string, string>();
  for (const piece of pieces) {
    const match = /^([a-z-]+)="([^"]*)"$/iu.exec(piece);
    if (!match || parameters.has(match[1]!.toLowerCase())) {
      invalidUpload("Held-set upload part disposition is invalid.");
    }
    parameters.set(match[1]!.toLowerCase(), match[2]!);
  }
  if ([...parameters.keys()].some((name) => name !== "name" && name !== "filename")) {
    invalidUpload("Held-set upload part disposition is invalid.");
  }
  const name = parameters.get("name") ?? "";
  const fileName = parameters.get("filename") ?? null;
  const isFile = name === heldSetExportContract.fileField;
  if ((!isFile && !textFieldNames.includes(name)) || (isFile && !fileName) || (!isFile && fileName !== null)) {
    invalidUpload("Held-set upload contains unsupported fields.");
  }
  return { name, fileName, contentType: headers.get("content-type") ?? null };
}

function findBoundary(
  bytes: Uint8Array,
  boundary: Uint8Array,
): Readonly<{ kind: "valid" | "incomplete"; index: number }> | Readonly<{ kind: "absent" }> {
  let from = 0;
  while (from <= bytes.byteLength - boundary.byteLength) {
    const candidate = indexOf(bytes, boundary, from);
    if (candidate < 0) return { kind: "absent" };
    const suffix = candidate + boundary.byteLength;
    if (bytes.byteLength < suffix + 2) return { kind: "incomplete", index: candidate };
    if (matchesAt(bytes, suffix, finalMarker) || matchesAt(bytes, suffix, lineBreak)) {
      return { kind: "valid", index: candidate };
    }
    from = candidate + 1;
  }
  return { kind: "absent" };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function join(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function indexOf(bytes: Uint8Array, target: Uint8Array, from = 0): number {
  outer: for (let index = from; index <= bytes.byteLength - target.byteLength; index += 1) {
    for (let targetIndex = 0; targetIndex < target.byteLength; targetIndex += 1) {
      if (bytes[index + targetIndex] !== target[targetIndex]) continue outer;
    }
    return index;
  }
  return -1;
}

function startsWith(bytes: Uint8Array, target: Uint8Array): boolean {
  return matchesAt(bytes, 0, target);
}

function matchesAt(bytes: Uint8Array, offset: number, target: Uint8Array): boolean {
  if (bytes.byteLength < offset + target.byteLength) return false;
  return target.every((value, index) => bytes[offset + index] === value);
}

function invalidUpload(message: string): never {
  throw new HeldSetExportError("invalid-upload", message);
}

function uploadTooLarge(message: string): never {
  throw new HeldSetExportError("upload-too-large", message);
}
