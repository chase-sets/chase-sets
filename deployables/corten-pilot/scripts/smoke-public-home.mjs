// Uses public-web's home page (chasesets.com's /) in a browser, against the real platform API,
// beside public-web's own.
// - Signed out: the title, description, canonical and social tags, the h1 shown, the sections in
//   public-web's order, every word public-web shows in main (the live fee terms, the promo bar's
//   message and the waitlist counter among them).
// - What caches may keep: a browser a minute, a shared cache four minutes while the terms are
//   live, either stale a minute; private with a cookie.
// - Join from the hero with no script: a synthetic email is signed up and the answer is 303 to
//   public-web's /welcome with the receipt, the role and the variant. A refused email is the page
//   again (422) with the API's words in the form it came from. (Writes one waitlist signup.)
// - A legacy fee-calculator share link moves for good to public-web's compare page, with
//   #fee-calculator.
// - With a script: Buy swaps the hero's copy and the final form follows.
// - At 1280 and 390 px nothing scrolls sideways and there are no console errors (the analytics
//   bridge's POST to /api is a 404 here: the pilot serves no /api, production's ingress does).
// Usage: node scripts/smoke-public-home.mjs [pilot-url] [public-web-url]
import { chromium } from "@playwright/test";

const [base = "http://localhost:7797", reference = "http://localhost:7754"] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const analytics = (text) => text.includes("/api/public-presence/analytics/waitlist");
// A failed request is reported by its response, with its path; the console's line has none.
const failedLoad = (text) => text.startsWith("Failed to load resource");
const browser = await chromium.launch();

/** What a page says: its head's tags, the h1 shown, its sections, the words in main and the promos. */
async function read(origin, { javascript = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: javascript });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !failedLoad(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on(
    "response",
    (r) => r.status() >= 400 && !analytics(r.url()) && errors.push(`${r.status()} ${new URL(r.url()).pathname}`),
  );
  const res = await page.goto(origin + "/", { waitUntil: "networkidle" });
  // public-web's shell fetches the promo bar after the page renders; give it a moment to arrive.
  await page
    .waitForFunction(
      () => [...document.querySelectorAll("section[aria-label]")].some((s) => !s.closest("main")),
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  const info = await page.evaluate(() => {
    const meta = (s) =>
      document.head.querySelector(s)?.getAttribute("content") ?? document.head.querySelector(s)?.getAttribute("href");
    const shown = (el) => !el.closest("[hidden]");
    const main = document.querySelector("main");
    return {
      title: document.title,
      description: meta('meta[name="description"]'),
      ogTitle: meta('meta[property="og:title"]'),
      ogImage: meta('meta[property="og:image"]'),
      canonical: meta('link[rel="canonical"]'),
      h1: [...document.querySelectorAll("h1")].filter(shown).map((h) => h.textContent.trim()),
      sections: [...document.querySelectorAll("main section[data-section], main [data-public-presence-section]")].map(
        (s) => s.getAttribute("data-public-presence-section") ?? s.getAttribute("data-section"),
      ),
      text: (main?.innerText ?? "").replace(/\s+/g, " "),
      // The promo bar: the labelled section outside main, the message it shows.
      promo: ([...document.querySelectorAll("section[aria-label]")].find((s) => !s.closest("main"))?.innerText ?? "")
        .replace(/\s+/g, " ")
        .replace(/\d+\/\d+/, "")
        .trim(),
    };
  });
  await context.close();
  return { status: res.status(), headers: res.headers(), info, errors };
}

const ours = await read(base);
const theirs = await read(reference);
check(ours.status === 200, `the page answers 200 (${ours.status})`);
check(ours.info.title === theirs.info.title, `the title: ${ours.info.title}`);
check(ours.info.description === theirs.info.description, "the description");
check(ours.info.ogTitle === theirs.info.ogTitle, `og:title: ${ours.info.ogTitle}`);
check(
  ours.info.canonical?.endsWith("/") ?? false,
  `the canonical (${ours.info.canonical}, public-web ${theirs.info.canonical})`,
);
check(
  JSON.stringify(ours.info.h1) === JSON.stringify(theirs.info.h1),
  `the h1 shown: ${ours.info.h1} (public-web ${theirs.info.h1})`,
);
const order = (list) => [...new Set(list)].join(" / ");
check(
  order(ours.info.sections) === order(theirs.info.sections),
  `the sections: ${order(ours.info.sections)} (public-web ${order(theirs.info.sections)})`,
);
const words = (text) => text.split(" ").filter(Boolean);
const missing = [...new Set(words(theirs.info.text).filter((w) => !ours.info.text.includes(w)))];
check(missing.length === 0, `public-web's words are all there (${missing.slice(0, 30).join(", ") || "all"})`);
// Expected: "you?" and "*". public-web names the hero's role group with aria-label and draws the
// required mark with CSS ::before, which innerText leaves out; the pilot's are a visually hidden
// legend and an aria-hidden "*".
const extra = [...new Set(words(ours.info.text).filter((w) => !theirs.info.text.includes(w)))];
console.log(`note words only the pilot shows: ${extra.slice(0, 30).join(", ") || "none"}`);
// The live terms: public-web's fee figures (percent and dollars) are the pilot's.
const figures = (text) =>
  [...text.matchAll(/\$[\d,]+\.\d\d|\d+(\.\d+)?%/g)]
    .map((m) => m[0])
    .sort()
    .join(" ");
check(figures(ours.info.text) === figures(theirs.info.text), `the figures: ${figures(ours.info.text)}`);
check(
  ours.info.promo === theirs.info.promo,
  `the promo bar's message: ${ours.info.promo || "none"} (public-web ${theirs.info.promo || "none"})`,
);
check(ours.errors.length === 0, `no console errors (${ours.errors.join(" | ")})`);
console.log(`note public-web (dev) console errors: ${theirs.errors.length}`);

// What caches may keep.
const anonymous = await fetch(base + "/");
check(
  /^public, max-age=60(, s-maxage=240)?, stale-while-revalidate=60$/.test(anonymous.headers.get("cache-control") ?? ""),
  `signed out: ${anonymous.headers.get("cache-control")}`,
);
check(
  (anonymous.headers.get("cache-control") ?? "").includes("s-maxage=240"),
  "a shared cache keeps it (the terms were read live)",
);
const withCookie = await fetch(base + "/", { headers: { cookie: "chase_sets_session=smoke" } });
check(
  withCookie.headers.get("cache-control") === "private, no-cache",
  `with a cookie, private: ${withCookie.headers.get("cache-control")}`,
);

// Join with no script: a synthetic signup, then a refusal.
const form = (fields) => new URLSearchParams({ panel: "hero", role: "sell", page_path: "/", ...fields }).toString();
const post = (body) =>
  fetch(base + "/", {
    method: "POST",
    redirect: "manual",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", origin: base },
  });
const email = `corten-pilot-smoke+${Date.now()}@example.com`;
const joined = await post(form({ email, games: "pokemon" }));
const location = joined.headers.get("location") ?? "";
if (joined.status === 429)
  console.log(
    "note the signup was refused as too many (429): the API's one shared bucket, chase-sets/chase-sets#10644",
  );
else {
  check(joined.status === 303, `a signup answers 303 (${joined.status})`);
  check(
    location.startsWith(`${reference}/welcome?signup=`) &&
      /&fresh=1&role=sell&variant=seller_first_v1&game=pokemon$/.test(location),
    `to public-web's welcome: ${location.replace(/signup=[^&]+/, "signup=…")}`,
  );
}
const refused = await post(form({ email: "not-an-email" }));
const refusedText = await refused.text();
check(refused.status === 422, `a refused email is the page again (${refused.status})`);
check(
  /role="alert"/.test(refusedText) && refusedText.includes('value="not-an-email"'),
  "with the API's words and the email sent, in the hero's form",
);

// A legacy share link.
const moved = await fetch(
  `${base}/?price=12.50&utm_source=fee-calculator&utm_medium=share&utm_campaign=what-you-keep`,
  { redirect: "manual" },
);
check(
  moved.status === 301 && (moved.headers.get("location") ?? "").endsWith("#fee-calculator"),
  `a fee-calculator share link moves: ${moved.status} ${moved.headers.get("location")}`,
);

// Without a script, the same words.
const plain = await read(base, { javascript: false });
check(plain.info.text === ours.info.text, "without JavaScript the page says the same");

// The role swaps the hero's copy, and the layout at a desktop's and a phone's width.
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !failedLoad(m.text()) && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
page.on(
  "response",
  (r) => r.status() >= 400 && !analytics(r.url()) && errors.push(`${r.status()} ${new URL(r.url()).pathname}`),
);
for (const width of [1280, 390]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.locator('#waitlist-form label:has-text("Buy")').click();
  const buyer = await page.locator('[data-variant-copy="seller_first_v2"]').isVisible();
  const role = await page.locator('#waitlist-form-final select[name="role"]').inputValue();
  check(
    buyer && role === "buy",
    `${width} px: Buy shows the buyer's hero and the final form follows (${buyer}, ${role})`,
  );
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${width} px: nothing scrolls sideways (${overflow})`);
}
check(errors.length === 0, `no console errors (${errors.join(" | ")})`);
await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
