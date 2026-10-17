// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SessionListPage } from "./session-list-page";
import { identitySeedIds } from "@chase-sets/identity-seed";
import type { Session } from "./contracts";

afterEach(cleanup);

describe("session list page heading hierarchy", () => {
  it("renders exactly one top-level heading", () => {
    render(
      <MemoryRouter>
        <SessionListPage initialData={{ items: [], count: 0, total: 0 }} />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Sessions" })).toBeTruthy();
  });
});

describe("seeded session list destinations", () => {
  const seededSessions: Session[] = [identitySeedIds.demo, identitySeedIds.support, identitySeedIds.collector].map(
    (fixture) => ({
      session_id: fixture.sessionId,
      user_id: fixture.userId,
      account_id:
        fixture.sessionId === identitySeedIds.support.sessionId ? identitySeedIds.demo.accountId : fixture.accountId,
      available_account_ids:
        fixture.sessionId === identitySeedIds.support.sessionId
          ? [fixture.accountId, identitySeedIds.demo.accountId]
          : [fixture.accountId],
      authentication_method: fixture.sessionId === identitySeedIds.support.sessionId ? "magic-link" : "password",
      status: fixture.sessionId === identitySeedIds.collector.sessionId ? "expired" : "active",
      expires_at:
        fixture.sessionId === identitySeedIds.collector.sessionId
          ? "2026-10-04T12:00:00.000Z"
          : "2026-11-04T12:00:00.000Z",
      updated_at: "2026-10-05T12:00:00.000Z",
    }),
  );

  it.each([
    { hrefBase: "/access/sessions", items: seededSessions },
    { hrefBase: "/account/sessions", items: [seededSessions[2]] },
  ])("renders seeded statuses and detail links at $hrefBase with All statuses selected", ({ hrefBase, items }) => {
    render(
      <MemoryRouter>
        <SessionListPage hrefBase={hrefBase} initialData={{ items, total: items.length, count: items.length }} />
      </MemoryRouter>,
    );

    expect((screen.getByRole("combobox", { name: "Status" }) as HTMLSelectElement).value).toBe("all");
    for (const session of items) {
      const row = screen.getByRole("row", { name: new RegExp(session.user_id) });
      expect(within(row).getByText(session.status === "expired" ? "Expired" : "Active")).toBeTruthy();
      expect(
        within(row)
          .getAllByRole("link")
          .some((link) => link.getAttribute("href") === `${hrefBase}/${session.session_id}`),
      ).toBe(true);
    }
    if (hrefBase === "/account/sessions") {
      expect(screen.queryByText(identitySeedIds.demo.userId)).toBeNull();
      expect(screen.queryByText(identitySeedIds.support.userId)).toBeNull();
    }
  });
});
