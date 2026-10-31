// @ts-check
// The home page's behavior, what public-web's React adds to the page: the hero's role picks the
// buyer's or seller's hero and the first priority, and both forms keep the same choices; the
// promo bar turns; the sticky calls to action follow the hero's form; the forms carry the
// referrer; a policy page's Print shows and prints; and the waitlist's analytics events go to window listeners, dataLayer and, through
// the bridge public-web's root installs (allowlisted fields, sendBeacon), the API. Everything
// here is extra: the page reads and both forms post without it.

const EVENTS = new Set([
  "landing_page_view",
  "cta_clicked",
  "waitlist_form_started",
  "waitlist_form_submitted",
  "waitlist_signup_succeeded",
  "waitlist_signup_failed",
  "waitlist_signup_attributed",
  "waitlist_role_selected",
  "waitlist_interest_selected",
  "waitlist_marketing_consent_checked",
  "waitlist_cohort_field_saved",
  "referral_link_copied",
  "referral_share_clicked",
  "section_viewed",
  "disclosure_opened",
  "policy_link_clicked",
]);
const ENDPOINT = "/api/public-presence/analytics/waitlist";

/** @param {unknown} value @param {number} most @param {RegExp} shape */
function bounded(value, most, shape) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= most && shape.test(text) ? text : null;
}

/** public-web's analytics bridge (root.tsx): the allowlisted fields of each event, to the API. */
function bridge() {
  const w = /** @type {any} */ (window);
  if (w.__chaseSetsWaitlistBridge) return;
  w.__chaseSetsWaitlistBridge = true;
  window.addEventListener("chase-sets:waitlist-analytics", (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail.event !== "string" || !EVENTS.has(detail.event)) return;
    const name = (/** @type {unknown} */ v) => bounded(v, 80, /^[a-zA-Z0-9_.-]+$/);
    const utm = (/** @type {unknown} */ v) => bounded(v, 120, /^[a-zA-Z0-9][a-zA-Z0-9 _%+.-]*$/);
    const path = bounded(detail.page_path, 160, /^[/a-zA-Z0-9_.~%=&?-]+$/);
    const body = JSON.stringify({
      event: detail.event,
      section: name(detail.section),
      target: name(detail.target),
      field: name(detail.field),
      role: name(detail.role),
      interest: name(detail.interest),
      variant: name(detail.variant),
      status: name(detail.status),
      page_path: path && path.startsWith("/") ? path : null,
      utm_source: utm(detail.utm_source),
      utm_medium: utm(detail.utm_medium),
      utm_campaign: utm(detail.utm_campaign),
      checked: typeof detail.checked === "boolean" ? detail.checked : null,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
  });
}

/** `trackWaitlistEvent`. @param {string} name @param {Record<string, unknown>} properties */
function track(name, properties) {
  const detail = { event: name, ...properties };
  window.dispatchEvent(new CustomEvent("chase-sets:waitlist-analytics", { detail }));
  /** @type {any} */ (window).dataLayer?.push(detail);
}

/** The interest each hero role stands for (`resolveHeroIntent`). @param {string} role */
const heroInterest = (role) => (role === "buy" ? "set-completion" : "low-sales-fees");
/** `landingExperimentVariantForIntent`. @param {string} role */
const variantOf = (role) => (role === "buy" ? "seller_first_v2" : "seller_first_v1");

/** @param {HTMLElement} root */
function state(root) {
  return {
    role: root.dataset.role ?? "both",
    interest: root.dataset.interest ?? "low-sales-fees",
    variant: root.dataset.variant ?? "seller_first_v1",
  };
}

/** @param {HTMLElement} root */
function source(root) {
  const params = new URLSearchParams(location.search);
  return {
    page_path: root.dataset.pagePath ?? location.pathname + location.search,
    utm_source: params.get("utm_source"),
    utm_medium: params.get("utm_medium"),
    utm_campaign: params.get("utm_campaign"),
  };
}

/** The choices both forms show, and the hero for the role. @param {HTMLElement} root @param {string} role @param {string} interest */
function choose(root, role, interest) {
  const variant = variantOf(role);
  root.dataset.role = role;
  root.dataset.interest = interest;
  root.dataset.variant = variant;
  for (const copy of Array.from(root.querySelectorAll("[data-variant-copy]"))) {
    /** @type {HTMLElement} */ (copy).hidden = copy.getAttribute("data-variant-copy") !== variant;
  }
  for (const radio of Array.from(root.querySelectorAll('input[type="radio"][name="role"]'))) {
    const input = /** @type {HTMLInputElement} */ (radio);
    input.checked = input.value === role;
  }
  for (const select of Array.from(root.querySelectorAll('select[name="role"]')))
    /** @type {HTMLSelectElement} */ (select).value = role;
  for (const select of Array.from(root.querySelectorAll('select[name="interests"]')))
    /** @type {HTMLSelectElement} */ (select).value = interest;
}

/** The section a form's field is in (hero or final_cta). @param {Element} field */
const sectionOf = (field) => field.closest("form")?.getAttribute("data-section") ?? "hero";

const started = new WeakSet();

/** `trackFormStart`: the first field a visitor uses in each form. @param {HTMLElement} root @param {Element} field @param {string} name */
function begin(root, field, name) {
  const form = field.closest("form");
  if (!form || started.has(form)) return;
  started.add(form);
  const { role, interest, variant } = state(root);
  track("waitlist_form_started", { section: sectionOf(field), field: name, role, interest, variant });
}

/** The field's name as public-web's events name it. @param {string} name */
const fieldName = (name) => (name === "marketing_consent" ? "marketingConsent" : name);

/**
 * The page joined: the role the server drew, the referrer in both forms, the bridge, the page
 * view (and a refusal), the sections seen and the sticky bars.
 * @param {HTMLElement} root
 */
export function start(root) {
  bridge();
  const checked = /** @type {HTMLInputElement | null} */ (
    root.querySelector('input[type="radio"][name="role"]:checked')
  );
  const interest = /** @type {HTMLSelectElement | null} */ (root.querySelector('select[name="interests"]'));
  root.dataset.role = checked?.value ?? "both";
  root.dataset.interest = interest?.value ?? heroInterest(root.dataset.role);
  for (const field of Array.from(root.querySelectorAll('input[name="referrer"]'))) {
    const input = /** @type {HTMLInputElement} */ (field);
    if (!input.value) input.value = document.referrer;
  }
  const { role, variant } = state(root);
  track("landing_page_view", { ...source(root), variant });
  if (root.hasAttribute("data-failed")) {
    track("waitlist_signup_failed", {
      page_path: source(root).page_path,
      role,
      interest: state(root).interest,
      variant,
    });
  }
  if (!("IntersectionObserver" in window)) return;
  const seen = new Set();
  const sections = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const name = entry.target.getAttribute("data-section");
        if (!name || seen.has(name) || !entry.isIntersecting) continue;
        seen.add(name);
        track("section_viewed", { section: name, variant: state(root).variant });
        sections.unobserve(entry.target);
      }
    },
    { threshold: 0.45 },
  );
  for (const section of Array.from(root.querySelectorAll("section[data-section]"))) sections.observe(section);
  sticky(root);
}

/** `StickyWaitlistCtas`: both bars while the hero's form is out of view, the top one not over the full form. @param {HTMLElement} root */
function sticky(root) {
  const hero = document.getElementById("waitlist-form");
  const final = document.getElementById("waitlist-form-final");
  const mobile = /** @type {HTMLElement | null} */ (root.querySelector('[data-sticky="mobile"]'));
  const desktop = /** @type {HTMLElement | null} */ (root.querySelector('[data-sticky="desktop"]'));
  if (!hero || !mobile || !desktop) return;
  let heroOut = false;
  let finalIn = false;
  const show = () => {
    mobile.hidden = !heroOut;
    desktop.hidden = !heroOut || finalIn;
    document.documentElement.toggleAttribute("data-sticky-bar", heroOut);
  };
  new IntersectionObserver(
    ([entry]) => {
      heroOut = !entry?.isIntersecting;
      show();
    },
    { threshold: 0.08 },
  ).observe(hero);
  if (final) {
    new IntersectionObserver(([entry]) => {
      finalIn = Boolean(entry?.isIntersecting);
      show();
    }).observe(final);
  }
}

/**
 * A choice changed: the role (the hero's segments or the full form's select), the first priority
 * or the consent, kept in step across both forms.
 * @param {Event} event
 * @param {HTMLElement} root
 */
export function change(event, root) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
  const section = sectionOf(field);
  if (field.name === "role") {
    begin(root, field, "role");
    const role = field.value;
    // A hero segment stands for a role and its priority; the full form's select keeps the priority.
    const interest = field instanceof HTMLInputElement ? heroInterest(role) : state(root).interest;
    choose(root, role, interest);
    track("waitlist_role_selected", { section, role, interest, variant: variantOf(role) });
  } else if (field.name === "interests") {
    begin(root, field, "interests");
    const { role, variant } = state(root);
    choose(root, role, field.value);
    track("waitlist_interest_selected", { section, role, interest: field.value, variant });
  } else if (field.name === "marketing_consent" && field instanceof HTMLInputElement) {
    begin(root, field, "marketingConsent");
    const { role, interest, variant } = state(root);
    track("waitlist_marketing_consent_checked", { section, checked: field.checked, role, interest, variant });
  }
}

/** A field took focus: the form's start. @param {Event} event @param {HTMLElement} root */
export function focused(event, root) {
  const field = event.target;
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
    if (field.type !== "hidden" && field.form) begin(root, field, fieldName(field.name));
  }
}

/** A call to action: its section and target. @param {MouseEvent} event @param {HTMLElement} root */
export function click(event, root) {
  const link = event.target instanceof Element ? event.target.closest("a[data-cta]") : null;
  if (!link || !root.contains(link)) return;
  track("cta_clicked", {
    section: link.getAttribute("data-cta"),
    target: link.getAttribute("data-target"),
    variant: state(root).variant,
  });
}

/** The nav's call to action, outside the page. @param {HTMLAnchorElement} link */
export function cta(link) {
  const root = /** @type {HTMLElement | null} */ (document.querySelector("main [data-variant]"));
  track("cta_clicked", {
    section: link.getAttribute("data-cta"),
    target: link.getAttribute("data-target"),
    variant: root ? state(root).variant : "seller_first_v1",
  });
}

/** A form is sent: what it says. The hero sends the priority the visitor's choices stand for. @param {Event} event @param {HTMLElement} root */
export function submitted(event, root) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const { role, interest, variant } = state(root);
  const data = new FormData(form);
  track("waitlist_form_submitted", {
    section: form.getAttribute("data-section"),
    role: String(data.get("role") ?? role),
    interest: String(data.get("interests") ?? interest),
    ...source(root),
    variant,
  });
}

/** The hero's form adds the first priority the visitor chose in the full form. @param {FormDataEvent} event @param {HTMLFormElement} form */
export function fill(event, form) {
  const root = form.closest("[data-variant]");
  if (!(root instanceof HTMLElement) || event.formData.has("interests")) return;
  event.formData.append("interests", state(root).interest);
}

const opened = new Set();

/** `disclosure_opened`, once for each. @param {HTMLDetailsElement} details */
export function disclosed(details) {
  const target = details.getAttribute("data-target");
  if (!details.open || !target || opened.has(target)) return;
  opened.add(target);
  const root = details.closest("[data-variant]");
  const variant = root instanceof HTMLElement ? state(root).variant : "seller_first_v1";
  track("disclosure_opened", { section: details.getAttribute("data-section"), target, variant });
}

/** One message at a time. @param {HTMLElement} bar @param {number} index */
function showPromo(bar, index) {
  const messages = Array.from(bar.querySelectorAll("[data-promo]"));
  const at = ((index % messages.length) + messages.length) % messages.length;
  messages.forEach((message, i) => {
    /** @type {HTMLElement} */ (message).hidden = i !== at;
  });
  bar.dataset.active = String(at);
  bar.dataset.tone = messages[at]?.getAttribute("data-tone") ?? "info";
  const count = bar.querySelector("[aria-live]");
  if (count) count.textContent = `${at + 1}/${messages.length}`;
}

/** The promo bar's turns: every seven seconds unless paused or the visitor prefers less motion. @param {HTMLElement} bar @param {AbortSignal} signal */
export function promos(bar, signal) {
  const controls = /** @type {HTMLElement | null} */ (bar.querySelector("[data-promo-step]")?.parentElement ?? null);
  if (!controls) return;
  controls.hidden = false;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pause = /** @type {HTMLElement | null} */ (bar.querySelector("[data-promo-pause]"));
  if (still) {
    if (pause) pause.hidden = true;
    return;
  }
  const timer = setInterval(() => {
    if (bar.dataset.paused !== "true") showPromo(bar, Number(bar.dataset.active ?? 0) + 1);
  }, 7000);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

/** Previous, next, pause and resume. @param {MouseEvent} event @param {HTMLElement} bar */
export function promo(event, bar) {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (!button) return;
  const step = button.getAttribute("data-promo-step");
  if (step) {
    showPromo(bar, Number(bar.dataset.active ?? 0) + Number(step));
    return;
  }
  if (button.hasAttribute("data-promo-pause")) {
    const paused = bar.dataset.paused !== "true";
    bar.dataset.paused = String(paused);
    button.setAttribute("aria-pressed", String(paused));
    button.setAttribute(
      "aria-label",
      (paused ? button.getAttribute("data-resume") : button.getAttribute("data-pause")) ?? "",
    );
  }
}

/** A control only this script can work (a policy page's Print, the welcome page's Copy): shown when it runs. @param {HTMLElement} control */
export function reveal(control) {
  control.hidden = false;
}

/** @param {Event} event */
export function print(event) {
  event.preventDefault();
  window.print();
}

/**
 * The welcome page joined: the bridge, the signup's success and, for a referred signup, its
 * attribution (public-web's page sends both each time it mounts).
 * @param {HTMLElement} root
 */
export function welcome(root) {
  bridge();
  const variant = root.dataset.variant ?? "seller_first_v1";
  track("waitlist_signup_succeeded", { section: "welcome", variant });
  if (root.dataset.attributed === "1") track("waitlist_signup_attributed", { section: "welcome", variant });
}

/** The referral link's field: selected when focused. @param {HTMLInputElement} input */
export function selected(input) {
  input.select();
}

/**
 * The referral link was copied: corten-ui's CopyButton reports each write the browser made
 * (`Copied`), and the copy is counted.
 * @param {Event} _event
 */
export function counted(_event) {
  track("referral_link_copied", { section: "welcome" });
}

/** A share link: its event, and for Discord the message copied to paste there. @param {HTMLAnchorElement} link */
export function shared(link) {
  const variant = link.closest("[data-variant]")?.getAttribute("data-variant") ?? "seller_first_v1";
  track("referral_share_clicked", { section: "welcome", target: link.dataset.share, variant });
  const message = link.dataset.value;
  if (message) navigator.clipboard?.writeText(message).catch(() => undefined);
}

/**
 * A wave-placement field changed: save that field alone, with the button that names it, and say
 * Saving... until the answer replaces the status.
 * @param {Event} event
 */
export function wave(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement) || !field.form) return;
  const name = field.name === "games" ? "games" : field.name;
  const button = field.form.querySelector(`button[data-wave-field="${name}"]`);
  if (!(button instanceof HTMLButtonElement)) return;
  const status = field.form.querySelector("[data-saving]");
  if (status instanceof HTMLElement) {
    status.textContent = status.dataset.saving ?? "";
    status.classList.remove("welcome-page__failed");
  }
  field.form.requestSubmit(button);
}

/** A compare page: the analytics bridge. @param {HTMLElement} _root */
export function compare(_root) {
  bridge();
}

/** A compare page's call to action: its section and target. @param {MouseEvent} event @param {HTMLElement} root */
export function compared(event, root) {
  const link = event.target instanceof Element ? event.target.closest("a[data-cta]") : null;
  if (!link || !root.contains(link)) return;
  track("cta_clicked", { section: link.getAttribute("data-cta"), target: link.getAttribute("data-target") });
}

/** @type {WeakMap<HTMLFormElement, number>} */
const pending = new WeakMap();

/**
 * The calculator's fields changed: send the form a moment after the visitor stops typing, so the
 * section is drawn again with the new numbers (a newer send replaces one on its way).
 * @param {Event} event
 */
export function calculate(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement) || !field.form) return;
  const form = field.form;
  clearTimeout(pending.get(form));
  pending.set(
    form,
    window.setTimeout(() => form.requestSubmit(), 150),
  );
}

/**
 * Copy share link: the button's `data-value`, and Link copied beside it for two seconds. Its own,
 * not CopyButton, for the same reason as `copy`.
 * @param {HTMLButtonElement} button
 */
export async function share(button) {
  track("cta_clicked", { section: "fee_calculator", target: "copy_share_link" });
  try {
    await navigator.clipboard.writeText(button.dataset.value ?? "");
  } catch {
    return;
  }
  const status = button.parentElement?.querySelector("[data-copied]");
  if (!(status instanceof HTMLElement)) return;
  status.textContent = status.dataset.copied ?? "";
  setTimeout(() => {
    status.textContent = "";
  }, 2000);
}

/** What only a page without a script needs (the calculator's Calculate): hidden. @param {HTMLElement} element */
export function conceal(element) {
  element.hidden = true;
}
