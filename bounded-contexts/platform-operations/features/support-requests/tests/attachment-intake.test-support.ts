import { File as NodeFile } from "node:buffer";

export async function nativeFormData() {
  // jsdom's FormData is not an Undici BodyInit. Use the same native encoder as HTTP ingress.
  return new Request("http://localhost", {
    method: "POST",
    body: "",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }).formData();
}

export async function multipartRequest(url: string, form: FormData, headers: HeadersInit = {}) {
  const encoded = new Request(url, { method: "POST", body: form });
  const bytes = await encoded.arrayBuffer();
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", encoded.headers.get("content-type")!);
  requestHeaders.set("content-length", String(bytes.byteLength));
  return new Request(url, { method: "POST", body: bytes, headers: requestHeaders });
}

export async function openingPhotoForm(count = 5) {
  const form = await nativeFormData();
  for (const [key, value] of Object.entries({
    orderId: "ord_1",
    flowType: "product-damaged",
    photoRequired: "true",
    attachmentOperationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    supportRequestId: "sup_1",
    affectedLineIds: "line_1",
    uploadUncertain: "false",
  }))
    form.append(key, value);
  for (let index = 0; index < count; index++)
    form.append("attachments", new NodeFile(["photo"], `${index}.jpg`, { type: "image/jpeg" }) as File);
  return form;
}

export function streamedIntakeRequest(url: string, size: number, declaredSize: number, stalled = false) {
  let remaining = size;
  let first = true;
  return new Request(url, {
    method: "POST",
    headers: { "content-length": String(declaredSize), "content-type": "application/x-www-form-urlencoded" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (stalled) return new Promise<void>(() => {});
        if (remaining === 0) return controller.close();
        const chunk = new Uint8Array(Math.min(remaining, 1024 * 1024)).fill(32);
        if (first) {
          chunk.set(new TextEncoder().encode("photoRequired=true&padding="));
          first = false;
        }
        remaining -= chunk.length;
        controller.enqueue(chunk);
      },
    }),
    duplex: "half",
  } as RequestInit);
}
