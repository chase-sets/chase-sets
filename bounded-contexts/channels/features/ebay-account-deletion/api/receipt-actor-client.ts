import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import type { ReceiptLookupCredential } from "@chase-sets/auth-context";
import {
  decodeEbayReceiptMatches,
  ebayReceiptLookupLimits,
  EbayReceiptResponseTooLarge,
  type EbayReceiptMatch,
} from "../domain/responses";

export class EbayReceiptClientError extends Error {
  constructor(public readonly status: number) {
    super("receipt-lookup-refused");
  }
}

export async function lookupEbayReceiptsAsService(
  options: Readonly<{
    credential: ReceiptLookupCredential;
    userId: string;
    fetch?: typeof fetch;
  }>,
): Promise<readonly EbayReceiptMatch[]> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const body = JSON.stringify({ userId: options.userId });
    if (new TextEncoder().encode(body).byteLength > 8192) throw new EbayReceiptClientError(413);
    const response = await (options.fetch ?? fetch)(
      `${linkIntentOrigins["admin-web"].staging}/api/channels/staff/ebay-account-deletion/lookup`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.credential.token}`,
          origin: linkIntentOrigins["admin-web"].staging,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (response.status !== 200) throw new EbayReceiptClientError(response.status);
    if (!response.body) throw new EbayReceiptClientError(400);
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ebayReceiptLookupLimits.maxSerializedUtf8ResponseBytes) throw new EbayReceiptClientError(413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return decodeEbayReceiptMatches(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      throw new EbayReceiptClientError(error instanceof EbayReceiptResponseTooLarge ? 413 : 400);
    }
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new EbayReceiptClientError(408));
        }, ebayReceiptLookupLimits.completeBodyDeadlineMs);
      }),
    ]);
  } catch (error) {
    throw error instanceof EbayReceiptClientError
      ? error
      : new EbayReceiptClientError(controller.signal.aborted ? 408 : 503);
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
