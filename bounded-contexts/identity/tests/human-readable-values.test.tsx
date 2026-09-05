// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsentHistoryPage } from "../features/consents/ui/consent-history-page";
import { grantableRoleSelectItems } from "../features/memberships/ui/role-select-items";

const identityRoot = path.resolve(import.meta.dirname, "..");
const rawValuePattern =
  /account_type|role_key|auth_methods|authentication_method|policy_key|recorded_at|withdrawn_at|updated_at|expires_at|last_used_at|[.]status/;

const expectedHitsByFile = {
  "features/access-hub/ui/access-home-page.tsx": 8,
  "features/access-hub/ui/account-access-hub-page.tsx": 25,
  "features/accounts/ui/account-detail-page.tsx": 6,
  "features/accounts/ui/account-list-page.tsx": 10,
  "features/accounts/ui/account-profile-page.tsx": 8,
  "features/api-keys/ui/account-security-page.tsx": 10,
  "features/api-keys/ui/api-key-detail-page.tsx": 5,
  "features/api-keys/ui/api-key-list-page.tsx": 8,
  "features/consents/ui/consent-history-page.tsx": 10,
  "features/invitations/ui/invitation-detail-page.tsx": 5,
  "features/invitations/ui/invitation-list-page.tsx": 10,
  "features/memberships/ui/account-team-page.tsx": 7,
  "features/memberships/ui/membership-detail-page.tsx": 5,
  "features/memberships/ui/membership-list-page.tsx": 10,
  "features/users/ui/user-detail-page.tsx": 5,
  "features/users/ui/user-list-page.tsx": 10,
  "routes/marketplace/account.tsx": 3,
} as const;

const machineOnlyFiles = new Set(["routes/marketplace/account.tsx"]);
const machineOnlyLine =
  /(?:===|!==|defaultValue=|\.filter\(|filters\.status|key:\s*"|HiddenInput|\.slice\(|\.length|\.map\(|account_type:\s*"|updated_at:\s*"|=\s*\w+\.updated_at$|error\.status)/;
const visibleLabelLine =
  /(?:Label\(|formatDate(?:Time)?\(|header:\s*t\(|label[=:]\s*\{?t\(|status\.filter\.|value:\s*data\.last_used_at)/;

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
  return productionSources(identityRoot).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((source, index) =>
        rawValuePattern.test(source)
          ? [
              {
                file: path.relative(identityRoot, file).replaceAll("\\", "/"),
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
    throw new Error(`Unclassified Identity raw-value hit: ${hit.file}:${hit.line}`);
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
  throw new Error(`Unclassified Identity raw-value hit: ${hit.file}:${hit.line}`);
}

const consentFixture = Object.freeze([
  Object.freeze({
    consent_id: "cns_current",
    subject_type: "user" as const,
    user_id: "usr_customer",
    account_id: "acc_customer",
    policy_key: "terms-of-service",
    policy_version: "v2",
    status: "recorded" as const,
    recorded_at: "2026-07-03T12:00:00.000Z",
    withdrawn_at: null,
    updated_at: "2026-07-03T12:00:00.000Z",
    is_current: true,
  }),
]);

function consentPage() {
  return <ConsentHistoryPage consents={consentFixture} />;
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
    container.innerHTML = renderToString(consentPage());
    const serverText = container.textContent;
    defaultLocale = "de-DE";
    const root = hydrateRoot(container, consentPage());
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

describe("Identity human-readable values", () => {
  it("reconciles every current Identity/Auth visible-machine-value caller", () => {
    const hits = census();
    const counts = Object.fromEntries(
      Object.keys(expectedHitsByFile).map((file) => [file, hits.filter((hit) => hit.file === file).length]),
    );
    const partition = hits.map((hit) => ({ ...hit, disposition: classify(hit) }));

    expect(hits).toHaveLength(145);
    expect(counts).toEqual(expectedHitsByFile);
    expect(partition).toHaveLength(hits.length);
    expect(
      partition.every((hit) => ["VISIBLE_LABEL", "MACHINE_ONLY", "OPERATOR_REFERENCE"].includes(hit.disposition)),
    ).toBe(true);
    expect(() =>
      classify({ file: "features/accounts/ui/account-list-page.tsx", line: 999, source: "row.status" }),
    ).toThrow(/Unclassified Identity raw-value hit/);
  });

  it("keeps raw Identity/Auth values in filters forms and routes while localizing visible text", () => {
    const consentSource = readFileSync(
      path.join(identityRoot, "features/consents/ui/consent-history-page.tsx"),
      "utf8",
    );
    const invitationSource = readFileSync(
      path.join(identityRoot, "features/invitations/ui/invitation-list-page.tsx"),
      "utf8",
    );

    expect(consentSource).toContain('name="consentId" value={consent.consent_id}');
    expect(invitationSource).toContain("value: account.account_id");
    expect(invitationSource).toContain("value: status");
    expect(render(consentPage()).container.textContent).toContain("Terms of Service · Version v2");
  });

  it("retains labeled operator references without exposing them on customer surfaces", () => {
    const accountDetailSource = readFileSync(
      path.join(identityRoot, "features/accounts/ui/account-detail-page.tsx"),
      "utf8",
    );
    expect(accountDetailSource).toContain("accountDetailPage.account.id");
    expect(accountDetailSource).toContain("value: data.account_id");

    const text = render(consentPage()).container.textContent ?? "";
    expect(text).not.toContain("usr_customer");
    expect(text).not.toContain("acc_customer");
    expect(text).not.toContain("cns_current");
  });

  it("preserves raw filter order and exposes localized status text accessibly", () => {
    expect(grantableRoleSelectItems.map((item) => item.value)).toEqual(["owner", "manager", "fulfillment", "viewer"]);
    expect(grantableRoleSelectItems.map((item) => item.label)).toEqual(["Owner", "Manager", "Fulfillment", "Viewer"]);
    expect(render(consentPage()).getByText("Recorded")).toBeTruthy();
  });

  it("hydrates Identity/Auth machine-value fixtures without date text mismatch", async () => {
    await hydrateAcrossDefaultLocales();
  });

  it("keeps human-readable Identity/Auth presentation stable on repeated render and hydration", async () => {
    const first = renderToString(consentPage());
    const second = renderToString(consentPage());
    expect(second).toBe(first);
    expect(consentFixture.map((consent) => consent.consent_id)).toEqual(["cns_current"]);
    await hydrateAcrossDefaultLocales();
  });
});
