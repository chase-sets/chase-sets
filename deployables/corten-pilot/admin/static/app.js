// @ts-check
import { ready } from "corten";

// The browser benchmark waits for this mark: the first page's scripts are imported.
ready.then(() => {
  /** @type {any} */ (window).__hydratedAt = performance.now();
});

/**
 * Marks the nav's entry for this page again after a client navigation, which keeps the header as
 * it was (`req.nav` takes only a typed route and has no "deepest entry
 * wins" rule). A link with `data-nav-path` is current when that path is this page or holds it; in
 * a nav marked `data-nav-rule="deepest"` only the deepest of those is, the rule the server applied.
 * Remove when Corten's `req.nav_of` replaces it (the README's Corten table).
 */
function markNav() {
  const here = location.pathname;
  /** @param {string} path */
  const holds = (path) => here === path || here.startsWith(`${path.replace(/\/+$/, "")}/`);
  /** @param {HTMLAnchorElement} link */
  const depth = (link) => (link.dataset.navPath ?? "").split("/").filter(Boolean).length;
  /** @type {Map<Element, HTMLAnchorElement[]>} */
  const navs = new Map();
  for (const link of Array.from(document.querySelectorAll("a[data-nav-path]"))) {
    if (!(link instanceof HTMLAnchorElement)) continue;
    const nav = link.closest("nav") ?? document.body;
    navs.set(nav, [...(navs.get(nav) ?? []), link]);
  }
  for (const [nav, links] of navs) {
    let held = links.filter((link) => holds(link.dataset.navPath ?? ""));
    if (nav.getAttribute("data-nav-rule") === "deepest" && held.length) {
      const deepest = Math.max(...held.map(depth));
      held = [held.filter((link) => depth(link) === deepest).at(-1) ?? held[0]];
    }
    for (const link of links) {
      if (held.includes(link)) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }
}

/** @type {any} */ (window).navigation?.addEventListener("navigatesuccess", markNav);
