// @ts-check
// The nav's cart count (marketplace's layout and its `resolveCartCount`): read once per full page
// load from /account/cart/count, then kept as a page says the cart changed. Without it the cart
// entry has no count, and a visitor's is not shown, as marketplace hides it while it reads 0.

const COUNT = "/account/cart/count";
const CHANGED = "chase-sets:cart-count-changed";

/** @type {Promise<void> | null} */
let reading = null;
let count = 0;

/** Draws `count` on every cart badge, and shows a visitor's cart entry once it is not 0. */
function draw() {
  for (const badge of Array.from(document.querySelectorAll("[data-badge='checkout.cart-count']"))) {
    if (!(badge instanceof HTMLElement)) continue;
    const max = Number(badge.dataset.max ?? Number.NaN);
    badge.textContent = Number.isFinite(max) && count > max ? `${max}+` : String(count);
    badge.hidden = count === 0;
    const entry = badge.closest("[data-hide-empty]");
    if (entry instanceof HTMLElement) entry.hidden = count === 0;
  }
}

/** Reads the count again; one read at a time. */
function read() {
  reading ??= fetch(COUNT, { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (body && typeof body.count === "number" && Number.isFinite(body.count)) {
        count = Math.max(0, body.count);
        draw();
      }
    })
    .catch(() => undefined)
    .finally(() => {
      reading = null;
    });
  return reading;
}

/**
 * A count a page sends (marketplace's event): `count` replaces it, `countDelta` moves it, and an
 * event with neither has it read again.
 * @param {Event} event
 */
function changed(event) {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  const next = Number(detail?.count ?? Number.NaN);
  const delta = Number(detail?.countDelta ?? Number.NaN);
  if (Number.isFinite(next)) count = Math.max(0, next);
  else if (Number.isFinite(delta)) count = Math.max(0, count + delta);
  else return void read();
  draw();
}

let started = false;

/**
 * A badge joined the page: on the first, the count is read and the page's changes listened for.
 * The layout's badges join once per full load, since a client navigation keeps the layout.
 * @param {HTMLElement} _badge
 */
export function fill(_badge) {
  if (started) return;
  started = true;
  window.addEventListener(CHANGED, changed);
  void read();
}

/**
 * A page that knows the cart's count now (the cart page, after a read or a write).
 * @param {number} total
 */
export function known(total) {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { count: total } }));
}

/** A page whose write changed the cart by an amount it does not know (an item page's add). */
export function stale() {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: {} }));
}
