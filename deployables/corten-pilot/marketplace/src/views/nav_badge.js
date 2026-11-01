// @ts-check
// The nav's cart count after a cart page's write. The server draws the count with each full load
// (the page's `Chrome`), but the cart page's writes are `data-patch` forms whose redirect the
// runtime follows as a navigation, which keeps the header the full load drew (the pilot README's
// open workarounds track it). The cart page tells the badge the count its own read found.

/**
 * Draws `total` on every cart badge, and shows a visitor's cart entry once it is not 0.
 * @param {number} total
 */
export function known(total) {
  const count = Math.max(0, Number.isFinite(total) ? total : 0);
  for (const badge of Array.from(document.querySelectorAll("[data-badge='checkout.cart-count']"))) {
    if (!(badge instanceof HTMLElement)) continue;
    const max = Number(badge.dataset.max ?? Number.NaN);
    badge.textContent = Number.isFinite(max) && count > max ? `${max}+` : String(count);
    badge.hidden = count === 0;
    const entry = badge.closest("[data-hide-empty]");
    if (entry instanceof HTMLElement) entry.hidden = count === 0;
  }
}
