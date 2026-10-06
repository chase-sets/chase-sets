import { expect, type Page } from "@playwright/test";
import baseline from "./rendered-copy-baseline.json" with { type: "json" };

export const renderedCopyClasses = [
  "typed-id",
  "seed-id",
  "object-string",
  "template-placeholder",
  "hedged-plural",
  "iso-instant",
] as const;
export type RenderedCopyClass = (typeof renderedCopyClasses)[number];
export type RenderedCopyViolation = Readonly<{ class: RenderedCopyClass; text: string }>;
export type RenderedCopyBaselineEntry = Readonly<
  {
    page: string;
    class: string;
    maxCount: number;
  } & ({ issue: number } | { selector: string; intentional: string })
>;

export const renderedCopyBaseline: readonly RenderedCopyBaselineEntry[] = baseline;

const patterns: Readonly<Record<RenderedCopyClass, RegExp>> = {
  "typed-id": /\b[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}\b/g,
  "seed-id": /\b[a-z]{2,4}_seed_[a-z0-9_]+\b/g,
  "object-string": /(?<![A-Za-z0-9_])(?:\[object Object\]|NaN|undefined)(?![A-Za-z0-9_])/g,
  "template-placeholder": /\{[A-Za-z_][A-Za-z0-9_]*\}/g,
  "hedged-plural": /\b[A-Za-z]+\(s\)/g,
  "iso-instant": /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g,
};

export function classifyRenderedCopy(text: string): RenderedCopyViolation[] {
  return renderedCopyClasses.flatMap((kind) =>
    [...text.matchAll(patterns[kind])].map((match) => ({ class: kind, text: match[0] })),
  );
}

// innerText preserves rendered whitespace and inline token boundaries. Restore
// the synchronous exclusions before yielding control back to the application.
export async function readRenderedCopy(page: Page, additionalExclusions: readonly string[] = []): Promise<string> {
  return page.evaluate(
    (selectors) => {
      const excluded = [
        ...new Set(selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])),
      ];
      const styles = excluded.map((element) => element.getAttribute("style"));
      try {
        excluded.forEach((element) => element.style.setProperty("display", "none", "important"));
        return document.body.innerText;
      } finally {
        excluded.forEach((element, index) => {
          const style = styles[index];
          // Reset CSSOM before removing an originally absent style attribute.
          element.setAttribute("style", style ?? "");
          if (style === null) element.removeAttribute("style");
        });
      }
    },
    ["code", "pre", "[data-raw-identifier]", ...additionalExclusions],
  );
}

export async function assertRenderedCopy(
  page: Page,
  pageKey: string,
  baseline: readonly RenderedCopyBaselineEntry[],
): Promise<void> {
  const violations = classifyRenderedCopy(await readRenderedCopy(page));
  const entries = baseline.filter((entry) => entry.page === pageKey);
  for (const entry of entries) {
    if (!renderedCopyClasses.some((kind) => kind === entry.class)) {
      throw new Error(`${pageKey} ${entry.class}: unknown baseline class in entry ${JSON.stringify(entry)}`);
    }
  }
  for (const kind of renderedCopyClasses) {
    const matches = violations.filter((violation) => violation.class === kind);
    const allowances = entries.filter((entry) => entry.class === kind);
    if (allowances.length > 1) throw new Error(`${pageKey} ${kind}: duplicate baseline entries`);
    const entry = allowances[0];
    if (!entry) {
      if (matches.length)
        throw new Error(`${pageKey} ${kind}: unbaselined violation ${JSON.stringify(matches[0].text)}`);
      continue;
    }
    if (!Number.isSafeInteger(entry.maxCount) || entry.maxCount <= 0) {
      throw new Error(`${pageKey} ${kind}: invalid maxCount in entry ${JSON.stringify(entry)}`);
    }
    if ("selector" in entry) {
      const outside = classifyRenderedCopy(await readRenderedCopy(page, [entry.selector])).find(
        (violation) => violation.class === kind,
      );
      if (outside) {
        throw new Error(
          `${pageKey} ${kind}: violation ${JSON.stringify(outside.text)} outside intentional selector ${JSON.stringify(entry.selector)}`,
        );
      }
    }
    if (matches.length > entry.maxCount) {
      throw new Error(
        `${pageKey} ${kind}: count ${matches.length} above maxCount ${entry.maxCount}; text ${JSON.stringify(matches[0]?.text)}; entry ${JSON.stringify(entry)}`,
      );
    }
    if (matches.length < entry.maxCount) {
      throw new Error(
        `${pageKey} ${kind}: count ${matches.length} below maxCount ${entry.maxCount}; the fix has landed, so lower or delete entry ${JSON.stringify(entry)}`,
      );
    }
  }
}

export type RenderedCopyWitness =
  | Readonly<{ kind: "populated"; selector: string; text: string }>
  | Readonly<{ kind: "sell-list-empty" }>
  | Readonly<{ kind: "reference-lookup-form" }>;

export async function expectRenderedCopyWitness(
  page: Page,
  pageKey: string,
  witness: RenderedCopyWitness,
  options: { timeout?: number; root?: string } = {},
): Promise<void> {
  const check = expect.configure({ timeout: options.timeout });
  const label = `${pageKey}: required ${witness.kind} witness`;
  const root = page.locator(options.root ?? "main").first();
  await check(root, label).toBeVisible();
  await check(
    page.getByRole("heading", {
      name: /^(?:Admin Error|Marketplace error|Application error|Unexpected application error!?|.*not found|.*unavailable|.*access required|Loading.*)$/i,
    }),
    `${pageKey}: error/loading/access state`,
  ).toHaveCount(0);
  await check(
    root.locator('[aria-busy="true"], [role="progressbar"], [role="status"][aria-label*="loading" i]'),
    `${pageKey}: unsettled content`,
  ).toHaveCount(0);
  if (witness.kind === "populated") {
    const component = root.locator(witness.selector);
    await check(component.first(), label).toBeVisible();
    await check(component.getByText(witness.text, { exact: true }).first(), label).toBeVisible();
    return;
  }
  if (witness.kind === "reference-lookup-form") {
    const form = root.locator('form:has(input[name="reference"])');
    await check(form, label).toHaveCount(1);
    await check(form.locator('input[name="reference"]'), label).toBeVisible();
    await check(form.locator('input[name="reference"]'), label).toHaveValue("");
    await check(form.locator('button[type="submit"]'), label).toBeVisible();
    await check(form.locator('button[type="submit"]'), label).toBeEnabled();
    return;
  }
  // Checkout seed.ts:327-371 produces no Sell List lines. Existing component:
  // sell-list-page.tsx:242-249; locales/en/checkout.ts:374-376,822.
  const empty = root.locator("section").filter({
    has: page.getByRole("heading", { name: "Your Sell List is empty", exact: true }),
  });
  await check(empty, label).toHaveCount(1);
  await check(empty.getByRole("heading", { name: "Your Sell List is empty", exact: true }), label).toBeVisible();
  await check(
    empty.getByText("Add selected offers or products from item pages before reviewing seller checkout.", {
      exact: true,
    }),
    label,
  ).toBeVisible();
  const browse = empty.getByRole("link", { name: "Browse products", exact: true });
  await check(browse, label).toBeVisible();
  await check(browse, label).toHaveAttribute("href", "/search");
  await check(
    root.getByText(
      /^(?:Updating Sell List|Refreshing Sell List|Your Sell List is catching up|Sell List line not visible yet|Sell List issue)$/,
    ),
    `${pageKey}: recovery is not seeded empty state`,
  ).toHaveCount(0);
  await check(
    root.locator('aside[aria-label="Sale checkout summary"], table tbody tr, [role="row"], input[name="lineId"]'),
    `${pageKey}: unexpected populated state`,
  ).toHaveCount(0);
}
