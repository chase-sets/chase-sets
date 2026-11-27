// @ts-check
// The shell's header search, after marketplace-web's (`HeaderSearch` in `MarketplaceShell`), in two
// parts. Without this script the header still has its search: a GET form to /search with the words
// as `q`, and the row stays open.
//
// 1. `shell`: below 48rem the search row folds away as the reader scrolls down and comes back as
//    they scroll up, as the design system's `searchRowReducer` decides it, published as
//    `data-search-row-state` on <body>, which the stylesheet reads. /search keeps it open, and so
//    does focus anywhere in the header, so a keyboard reader always sees where they are.
// 2. `combobox`: the box lists "Search for" and Discovery's suggestions as the words change (the
//    pilot's /search/suggest, 250 ms after the last key), or the recent searches while it is empty,
//    kept in this browser as marketplace-web keeps them.

/** The scroll position under which the row is always open (`COLLAPSE_FLOOR`). */
const FLOOR = 96;
/** The scroll travel in one direction that opens or folds the row (`DIRECTION_DELTA`). */
const DELTA = 24;
/** The width from which the header has no folding row (`MD_MIN_WIDTH_PX`). */
const MD = 768;
/** The attribute the stylesheet reads. */
const STATE = "data-search-row-state";

/** @typedef {"inert" | "expanded" | "collapsed"} Phase */
/** @typedef {{ phase: Phase, travel: number, last: number, route: string }} RowState */

/** @param {number} travel */
const clamp = (travel) => Math.max(-DELTA, Math.min(DELTA, travel));

/**
 * One event's next state (`searchRowReducer`): a mount, a route change or an md crossing starts
 * folded and decides again; a focus change clears the travel; a scroll adds to it, starting again
 * when the direction turns. Then, first match wins: no row at md and up, open on /search, open
 * with focus in the header, open near the top, open after scrolling up far enough, folded after
 * scrolling down far enough, else as it was.
 * @param {RowState} state
 * @param {"mount" | "scroll" | "focus" | "viewport" | "route"} type
 * @param {{ belowMd: boolean, scrollY: number, focused: boolean, route: string }} now
 * @returns {RowState}
 */
function next(state, type, now) {
  let phase = state.phase === "inert" ? "collapsed" : state.phase;
  let travel = state.travel;
  let route = state.route;
  if (type === "mount" || type === "route" || type === "viewport") {
    phase = "collapsed";
    travel = 0;
    route = now.route;
  } else if (type === "focus") {
    travel = 0;
  } else {
    const step = state.last - now.scrollY;
    if (step !== 0)
      travel = state.travel === 0 || state.travel > 0 === step > 0 ? clamp(state.travel + step) : clamp(step);
  }
  const last = now.scrollY;
  if (!now.belowMd) return { phase: "inert", travel: 0, last, route };
  if (route === "/search" || now.focused || now.scrollY < FLOOR) return { phase: "expanded", travel, last, route };
  if (travel >= DELTA) return { phase: "expanded", travel: 0, last, route };
  if (travel <= -DELTA) return { phase: "collapsed", travel: 0, last, route };
  return { phase: /** @type {Phase} */ (phase), travel, last, route };
}

/**
 * The header's folding row, for as long as the header is on the page (`signal`). A navigation
 * keeps the header, so a new page is noticed as <main>'s content changing to another address.
 * @param {HTMLElement} header
 * @param {AbortSignal} signal
 */
export function shell(header, signal) {
  const body = document.body;
  /** @type {RowState} */
  let state = { phase: "inert", travel: 0, last: 0, route: location.pathname };
  let belowMd = innerWidth < MD;
  /** @param {"mount" | "scroll" | "focus" | "viewport" | "route"} type */
  const dispatch = (type) => {
    const active = document.activeElement;
    state = next(state, type, {
      belowMd: innerWidth < MD,
      scrollY: scrollY,
      focused: !!active && header.contains(active),
      route: location.pathname,
    });
    // Only a change is written: an observer counts every write as a change.
    if (state.phase === "inert") body.removeAttribute(STATE);
    else if (body.getAttribute(STATE) !== state.phase) body.setAttribute(STATE, state.phase);
  };
  const routed = () => {
    if (location.pathname !== state.route) dispatch("route");
  };
  const options = { passive: true, signal };
  addEventListener("scroll", () => dispatch("scroll"), options);
  addEventListener(
    "resize",
    () => {
      // The md crossing, not every resize: a phone's address bar showing or hiding is not one.
      if (belowMd === innerWidth < MD) return;
      belowMd = !belowMd;
      dispatch("viewport");
    },
    options,
  );
  document.addEventListener("focusin", () => dispatch("focus"), { signal });
  document.addEventListener("focusout", () => dispatch("focus"), { signal });
  addEventListener("popstate", routed, { signal });
  const main = document.querySelector("main");
  if (main) {
    const observer = new MutationObserver(routed);
    observer.observe(main, { childList: true });
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  }
  signal.addEventListener("abort", () => body.removeAttribute(STATE), { once: true });
  dispatch("mount");
}

/** Where marketplace-web keeps the recent searches (`MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY`). */
const RECENT = "chase-sets:marketplace:recent-searches";
/** How many recent searches are kept. */
const RECENT_MOST = 5;
/** The most of its words the box sends (`DISCOVERY_SEARCH_SUGGESTION_QUERY_MAX_CODE_POINTS`). */
const WORDS_MOST = 80;
/** How long after the last key the suggestions are asked for (`SEARCH_SUGGESTION_DEBOUNCE_MS`). */
const WAIT = 250;

/** @param {string} words */
const bounded = (words) => Array.from(words).slice(0, WORDS_MOST).join("");

/** @returns {string[]} */
function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string" && item.trim() !== "").slice(0, RECENT_MOST)
      : [];
  } catch {
    return [];
  }
}

/** @param {string[]} recent */
function writeRecent(recent) {
  try {
    if (recent.length) localStorage.setItem(RECENT, JSON.stringify(recent));
    else localStorage.removeItem(RECENT);
  } catch {
    // A browser that keeps nothing (private mode, storage off) keeps no recent searches.
  }
}

/**
 * The recent searches with `words` first, once, whatever its case.
 * @param {string[]} recent @param {string} words
 */
const withRecent = (recent, words) =>
  [words, ...recent.filter((item) => item.toLocaleLowerCase() !== words.toLocaleLowerCase())].slice(0, RECENT_MOST);

/** @typedef {{ title: string, description: string, href: string }} Suggested */
/**
 * @typedef {{ kind: "search", label: string, words: string }
 *   | { kind: "recent", label: string, description: string, words: string }
 *   | { kind: "clear", label: string }
 *   | { kind: "item", label: string, description: string, href: string }} Choice
 */

/** @param {unknown} body @returns {Suggested[]} */
function suggestedIn(body) {
  const items = body && typeof body === "object" && "items" in body ? body.items : null;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item) =>
      item && typeof item.title === "string" && typeof item.description === "string" && typeof item.href === "string",
  );
}

/**
 * The header's search box, a combobox (`Combobox` with `openOnInputClick`): a click or Down opens
 * its list, typing shows "Search for" and the suggestions, Up and Down move through them, Enter
 * takes the one marked or sends the words, and Escape closes the list. A suggestion goes to its
 * item's page; "Search for" and a recent search send the form, as Enter in the box does. The form
 * is a GET of /search with only `q`, which Corten navigates to.
 * @param {HTMLFormElement} form
 * @param {AbortSignal} signal
 * @param {string} source the suggestions' address
 * @param {string} searchFor "Search for '{query}'"
 * @param {string} recentLabel a recent search's line
 * @param {string} clearLabel "Clear recent searches"
 * @param {string} noMatches the list's words when nothing matches
 * @param {string} noRecent the list's words when there is no recent search
 */
export function combobox(form, signal, source, searchFor, recentLabel, clearLabel, noMatches, noRecent) {
  const input = form.querySelector("input[role='combobox']");
  const list = input && document.getElementById(input.getAttribute("aria-controls") ?? "");
  if (!(input instanceof HTMLInputElement) || !(list instanceof HTMLUListElement)) return;
  let recent = readRecent();
  /** @type {Suggested[]} */
  let suggested = [];
  /** @type {Choice[]} */
  let choices = [];
  let active = -1;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {AbortController | undefined} */
  let asking;

  const words = () => bounded(input.value).trim();
  const isOpen = () => !list.hidden;
  /** @param {number} index */
  const optionId = (index) => `${list.id}-${index}`;

  /** @returns {Choice[]} */
  const choose = () => {
    const now = words();
    if (now) {
      return [
        { kind: "search", label: searchFor.replace("{query}", now), words: now },
        ...suggested.map(
          (item) =>
            /** @type {Choice} */ ({ kind: "item", label: item.title, description: item.description, href: item.href }),
        ),
      ];
    }
    if (!recent.length) return [];
    return [
      ...recent.map(
        (item) => /** @type {Choice} */ ({ kind: "recent", label: item, description: recentLabel, words: item }),
      ),
      { kind: "clear", label: clearLabel },
    ];
  };

  const draw = () => {
    choices = choose();
    if (active >= choices.length) active = -1;
    const rows = choices.map((choice, index) => {
      const row = document.createElement("li");
      row.id = optionId(index);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === active));
      const label = document.createElement("span");
      label.dataset.label = "";
      label.textContent = choice.label;
      row.append(label);
      if ("description" in choice) {
        const line = document.createElement("span");
        line.dataset.description = "";
        line.textContent = choice.description;
        row.append(line);
      }
      if (choice.kind === "clear" || choice.kind === "search") row.dataset.action = "";
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.setAttribute("role", "presentation");
      empty.dataset.empty = "";
      empty.textContent = words() ? noMatches : noRecent;
      rows.push(empty);
    }
    list.replaceChildren(...rows);
    if (active >= 0) input.setAttribute("aria-activedescendant", optionId(active));
    else input.removeAttribute("aria-activedescendant");
  };

  const open = () => {
    draw();
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    active = -1;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  /** @param {string} value */
  const send = (value) => {
    const now = bounded(value).trim();
    if (!now) return;
    input.value = now;
    close();
    form.requestSubmit();
  };

  /** @param {Choice} choice */
  const take = (choice) => {
    if (choice.kind === "clear") {
      recent = [];
      writeRecent(recent);
      input.value = "";
      active = -1;
      draw();
    } else if (choice.kind === "item") {
      close();
      // A same-origin navigation Corten draws in place where the browser lets it.
      location.assign(choice.href);
    } else {
      send(choice.words);
    }
  };

  const ask = () => {
    clearTimeout(timer);
    asking?.abort();
    const now = words();
    if (!now) {
      suggested = [];
      return;
    }
    timer = setTimeout(() => {
      const controller = (asking = new AbortController());
      const url = new URL(source, location.href);
      url.searchParams.set("q", now);
      fetch(url, { signal: controller.signal, credentials: "same-origin", headers: { Accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : { items: [] }))
        .then((body) => {
          if (controller.signal.aborted || words() !== now) return;
          suggested = suggestedIn(body);
          if (isOpen()) draw();
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          suggested = [];
          if (isOpen()) draw();
        });
    }, WAIT);
  };

  input.addEventListener(
    "input",
    () => {
      const cut = bounded(input.value);
      if (cut !== input.value) input.value = cut;
      active = -1;
      if (!words()) suggested = [];
      ask();
      open();
    },
    { signal },
  );
  input.addEventListener("click", () => (isOpen() ? undefined : open()), { signal });
  input.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen()) open();
        if (!choices.length) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        active = active < 0 ? (step > 0 ? 0 : choices.length - 1) : (active + step + choices.length) % choices.length;
        draw();
        list.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && isOpen()) {
        const choice = choices[active];
        if (!choice) return;
        event.preventDefault();
        take(choice);
      } else if (event.key === "Escape" && isOpen()) {
        event.preventDefault();
        close();
      }
    },
    { signal },
  );
  // Choosing with a pointer keeps the focus in the box, so the list is not closed under it.
  list.addEventListener("pointerdown", (event) => event.preventDefault(), { signal });
  list.addEventListener(
    "click",
    (event) => {
      const row = event.target instanceof Element ? event.target.closest("[role='option']") : null;
      const index = row ? Array.from(list.querySelectorAll("[role='option']")).indexOf(row) : -1;
      const choice = choices[index];
      if (choice) take(choice);
    },
    { signal },
  );
  form.addEventListener(
    "focusout",
    (event) => {
      if (
        !(
          event.relatedTarget instanceof Node &&
          (form.contains(event.relatedTarget) || list.contains(event.relatedTarget))
        )
      )
        close();
    },
    { signal },
  );
  form.addEventListener(
    "submit",
    (event) => {
      const now = words();
      if (!now) {
        event.preventDefault();
        return;
      }
      input.value = now;
      recent = withRecent(recent, now);
      writeRecent(recent);
      close();
    },
    { signal },
  );
  // Another page closes the list; the box keeps its words, as marketplace's header does.
  addEventListener("popstate", close, { signal });
  const main = document.querySelector("main");
  if (main) {
    const observer = new MutationObserver(close);
    observer.observe(main, { childList: true });
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  }
  signal.addEventListener("abort", () => (clearTimeout(timer), asking?.abort()), { once: true });
}
