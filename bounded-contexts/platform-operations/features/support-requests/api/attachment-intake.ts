import { parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";
import {
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES,
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT,
} from "../domain/attachment-policy";

export const SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES =
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES * SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT + 64 * 1024;
export const SUPPORT_ATTACHMENT_INTAKE_DEADLINE_MS = 30_000;
export const SUPPORT_ATTACHMENT_OPERATION_HEADER = "x-support-attachment-operation-id";

export class SupportAttachmentIntakeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 408 | 411 | 413,
  ) {
    super(code);
  }
}

export function validateSupportAttachmentOperationId(value: string): string {
  try {
    return parseStrictTypedUlid(value, "sao");
  } catch {
    throw new SupportAttachmentIntakeError("invalid-operation-id", 400);
  }
}

const MULTIPART_BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

// Inspection and native decoding receive the same validated ASCII boundary.
function boundedContentType(contentType: string) {
  if (contentType.split(";")[0]!.trim().toLowerCase() !== "multipart/form-data") return { contentType, boundary: null };
  const boundary = /;\s*boundary=(?:"([^"]*)"|([^;\s]*))\s*$/i.exec(contentType);
  const value = boundary?.[1] ?? boundary?.[2] ?? "";
  if (!MULTIPART_BOUNDARY.test(value)) throw new SupportAttachmentIntakeError("invalid-multipart", 400);
  return { contentType: `multipart/form-data; boundary="${value}"`, boundary: value };
}

// This inspects only multipart framing. The native parser still owns FormData decoding.
function filePartGuard(value: string | null) {
  if (value === null) return () => {};
  const delimiter = `\r\n--${value}`;
  let pending = "\r\n";
  let phase: "boundary" | "headers" | "body" | "done" = "boundary";
  let files = 0;
  const decoder = new TextDecoder("latin1");
  return (chunk: Uint8Array) => {
    pending += decoder.decode(chunk);
    while (phase !== "done") {
      if (phase === "headers") {
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) {
          if (pending.length > 64 * 1024) throw new SupportAttachmentIntakeError("invalid-multipart", 400);
          return;
        }
        if (end > 64 * 1024) throw new SupportAttachmentIntakeError("invalid-multipart", 400);
        const headers = pending.slice(0, end);
        const dispositions = [...headers.matchAll(/^content-disposition\s*:([^\r\n]*)/gim)];
        const isFile = dispositions.some((disposition) =>
          [...disposition[1]!.matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"[^"]*"|[^;]*)/g)].some((parameter) =>
            /^filename\*?$/i.test(parameter[1]!),
          ),
        );
        if (isFile) {
          if (++files > SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT)
            throw new SupportAttachmentIntakeError("too-many-files", 413);
        }
        pending = pending.slice(end + 4);
        phase = "body";
      } else {
        const start = pending.indexOf(delimiter);
        if (start < 0) {
          pending = pending.slice(-delimiter.length);
          return;
        }
        const suffix = pending.slice(start + delimiter.length, start + delimiter.length + 2);
        if (suffix.length < 2) {
          pending = pending.slice(start);
          return;
        }
        if (suffix === "--") {
          phase = "done";
        } else if (suffix === "\r\n") {
          pending = pending.slice(start + delimiter.length + 2);
          phase = "headers";
        } else {
          pending = pending.slice(start + delimiter.length);
        }
      }
    }
  };
}

export async function readSupportAttachmentFormData(request: Request): Promise<FormData> {
  const length = request.headers.get("content-length");
  if (length === null) throw new SupportAttachmentIntakeError("content-length-required", 411);
  if (!/^\d+$/.test(length)) throw new SupportAttachmentIntakeError("invalid-content-length", 400);
  if (Number(length) > SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES)
    throw new SupportAttachmentIntakeError("intake-too-large", 413);
  const bounded = boundedContentType(request.headers.get("content-type") ?? "");
  const inspect = filePartGuard(bounded.boundary);
  const reader = request.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SupportAttachmentIntakeError("intake-deadline", 408)),
      SUPPORT_ATTACHMENT_INTAKE_DEADLINE_MS,
    );
  });
  try {
    // A single declared-length buffer bounds memory even for one-byte stream chunks.
    const body = new Uint8Array(Number(length));
    let size = 0;
    if (reader) {
      while (true) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES) throw new SupportAttachmentIntakeError("intake-too-large", 413);
        if (size > body.byteLength) throw new SupportAttachmentIntakeError("invalid-content-length", 400);
        inspect(part.value);
        body.set(part.value, size - part.value.byteLength);
      }
    }
    if (size !== body.byteLength) throw new SupportAttachmentIntakeError("invalid-content-length", 400);
    const parsed = new Response(body, { headers: { "content-type": bounded.contentType } });
    const formData = parsed.formData().catch(() => {
      throw new SupportAttachmentIntakeError("invalid-multipart", 400);
    });
    return await Promise.race([formData, deadline]);
  } catch (error) {
    // Cancellation is best effort: an unresponsive producer must not hold the rejection open.
    void reader?.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
