// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetailPage } from "../features/sessions/ui/session-detail-page";
import { AUTH_SESSION_STATUSES } from "../features/sessions/ui/list-filters";

const authRoot = path.resolve(import.meta.dirname, "..");
const rawValuePattern =
  /account_type|role_key|auth_methods|authentication_method|policy_key|recorded_at|withdrawn_at|updated_at|expires_at|last_used_at|[.]status/;

const expectedHitsByFile = {
  "features/agent-grants/ui/agent-grant-detail-page.tsx": 3,
  "features/agent-grants/ui/agent-grant-list-page.tsx": 1,
  "features/invitation-acceptance/ui/invitation-acceptance-page.tsx": 2,
  "features/registration/ui/register-page.tsx": 6,
  "features/sessions/ui/session-detail-page.tsx": 4,
  "features/sessions/ui/session-list-page.tsx": 10,
  "features/sign-in/ui/sign-in-page.tsx": 8,
  "support/route-support/magic-link-landing.tsx": 1,
} as const;

const machineOnlyFiles = new Set([
  "features/invitation-acceptance/ui/invitation-acceptance-page.tsx",
  "features/registration/ui/register-page.tsx",
  "features/sign-in/ui/sign-in-page.tsx",
  "support/route-support/magic-link-landing.tsx",
]);
const machineOnlyLine =
  /(?:===|!==|defaultValue=|\.filter\(|filters\.status|key:\s*"|HiddenInput|\.length|\.map\(|error\.status)/;
const visibleLabelLine = /(?:Label\(|formatDate(?:Time)?\(|header:\s*t\(|label[=:]\s*\{?t\(|status\.filter\.)/;

type Disposition = "VISIBLE_LABEL" | "MACHINE_ONLY" | "OPERATOR_REFERENCE";
type CensusHit = Readonly<{ file: string; line: number; source: string }>;

function productionSources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      return ["tests", "node_modules"].includes(entry) ? [] : productionSources(fullPath);
    }
    return entry.endsWith(".tsx") && !entry.endsWith(".test.tsx") ? [fullPath] : [];
  });
}

function census(): CensusHit[] {
  return productionSources(authRoot).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((source, index) =>
        rawValuePattern.test(source)
          ? [
              {
                file: path.relative(authRoot, file).replaceAll("\\", "/"),
                line: index + 1,
                source: source.trim(),
              },
            ]
          : [],
      ),
  );
}

function classify(hit: CensusHit): Disposition {
  if (!(hit.file in expectedHitsByFile)) {
    throw new Error(`Unclassified Auth raw-value hit: ${hit.file}:${hit.line}`);
  }
  if (machineOnlyFiles.has(hit.file)) {
    return "MACHINE_ONLY";
  }
  if (visibleLabelLine.test(hit.source)) {
    return "VISIBLE_LABEL";
  }
  if (machineOnlyLine.test(hit.source)) {
    return "MACHINE_ONLY";
  }
  throw new Error(`Unclassified Auth raw-value hit: ${hit.file}:${hit.line}`);
}

const sessionFixture = Object.freeze({
  session_id: "session_operator_reference",
  user_id: "usr_operator_reference",
  user_display_name: "Alex Clerk",
  user_primary_email: "alex@example.com",
  account_id: "acc_active",
  account_display_name: "Card Vault",
  account_name: "Card Vault LLC",
  available_account_ids: Object.freeze(["acc_active", "acc_operator_reference"]),
  authentication_method: "magic-link",
  status: "active",
  expires_at: "2026-07-15T12:00:00.000Z",
  updated_at: "2026-07-14T12:00:00.000Z",
});

function sessionPage() {
  return <SessionDetailPage data={sessionFixture} />;
}

async function hydrateAcrossDefaultLocales() {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let defaultLocale = "fr-FR";
  const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function DateTimeFormat(locales, options) {
    return new OriginalDateTimeFormat(locales ?? defaultLocale, options);
  } as typeof Intl.DateTimeFormat);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const container = document.createElement("div");
  document.body.append(container);

  try {
    container.innerHTML = renderToString(sessionPage());
    const serverText = container.textContent;
    defaultLocale = "de-DE";
    const root = hydrateRoot(container, sessionPage());
    await act(async () => undefined);
    expect(container.textContent).toBe(serverText);
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/hydration|did not match/i);
    root.unmount();
  } finally {
    container.remove();
    consoleError.mockRestore();
    spy.mockRestore();
  }
}

afterEach(cleanup);

describe("Auth human-readable values", () => {
  it("reconciles every current Identity/Auth visible-machine-value caller", () => {
    const hits = census();
    const counts = Object.fromEntries(
      Object.keys(expectedHitsByFile).map((file) => [file, hits.filter((hit) => hit.file === file).length]),
    );
    const partition = hits.map((hit) => ({ ...hit, disposition: classify(hit) }));

    expect(hits).toHaveLength(35);
    expect(counts).toEqual(expectedHitsByFile);
    expect(partition).toHaveLength(hits.length);
    expect(
      partition.every((hit) => ["VISIBLE_LABEL", "MACHINE_ONLY", "OPERATOR_REFERENCE"].includes(hit.disposition)),
    ).toBe(true);
    expect(() =>
      classify({ file: "features/sessions/ui/session-list-page.tsx", line: 999, source: "row.status" }),
    ).toThrow(/Unclassified Auth raw-value hit/);
  });

  it("keeps raw Identity/Auth values in filters forms and routes while localizing visible text", () => {
    const sessionListSource = readFileSync(path.join(authRoot, "features/sessions/ui/session-list-page.tsx"), "utf8");
    expect(sessionListSource).toContain("value: status");
    expect(sessionListSource).toContain("defaultValue={filters.status}");
    expect(render(sessionPage()).container.textContent).toContain("Magic link");
  });

  it("retains labeled operator references without exposing them on customer surfaces", () => {
    const text = render(sessionPage()).container.textContent ?? "";
    expect(text).toContain("Session ID");
    expect(text).toContain("session_operator_reference");
    expect(text).toContain("acc_operator_reference");

    const agentGrantListSource = readFileSync(
      path.join(authRoot, "features/agent-grants/ui/agent-grant-list-page.tsx"),
      "utf8",
    );
    expect(agentGrantListSource).not.toMatch(/user_id|account_id|session_id/);
  });

  it("preserves raw filter order and exposes localized status text accessibly", () => {
    expect(AUTH_SESSION_STATUSES).toEqual(["active", "revoked", "expired"]);
    const view = render(sessionPage());
    expect(view.getByText("Active")).toBeTruthy();
    expect(view.getByText("Magic link")).toBeTruthy();
  });

  it("hydrates Identity/Auth machine-value fixtures without date text mismatch", async () => {
    await hydrateAcrossDefaultLocales();
  });

  it("keeps human-readable Identity/Auth presentation stable on repeated render and hydration", async () => {
    const first = renderToString(sessionPage());
    const second = renderToString(sessionPage());
    expect(second).toBe(first);
    expect(sessionFixture.available_account_ids).toEqual(["acc_active", "acc_operator_reference"]);
    await hydrateAcrossDefaultLocales();
  });
});
