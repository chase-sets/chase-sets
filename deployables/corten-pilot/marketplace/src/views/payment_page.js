// @ts-check
// The payment page's watch over the payment's status (see payment.rs): the status part is a patch
// that asks to be read again while the status is unchanged and redraws the page's content once it
// changed. Only a patch starts Corten's ReadAgain, so the page's watch makes the first read
// (todd-skelton/corten#276).
import { patch } from "corten";

/**
 * When the page's watch joins it: read the status part.
 * @param {string} href
 */
export function watch(href) {
  void read(href);
}

/**
 * Read the status part at `href` and apply it.
 * @param {string} href
 */
async function read(href) {
  const res = await fetch(href, { headers: { corten: "action" } }).catch(() => null);
  if (!res?.headers.has("corten-patch")) return;
  await patch(await res.text());
}
