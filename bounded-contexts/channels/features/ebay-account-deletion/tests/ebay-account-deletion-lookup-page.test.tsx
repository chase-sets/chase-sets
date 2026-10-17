import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { EbayAccountDeletionLookupPage } from "../ui/ebay-account-deletion-lookup-page";

describe("eBay account-deletion lookup page", () => {
  const html = (props: Parameters<typeof EbayAccountDeletionLookupPage>[0]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <EbayAccountDeletionLookupPage {...props} />
      </MemoryRouter>,
    );
  it("shows loading, empty, error and only receipt fields without echoing subjects", () => {
    expect(html({ counts: null, matches: null, error: false, pending: true })).toContain("disabled");
    expect(html({ counts: null, matches: [], error: false })).toContain("No unexpired receipt matches");
    expect(html({ counts: null, matches: null, error: true })).toContain('role="alert"');
    const result = html({
      counts: { connections: 0, credentialEnvelopes: 0 },
      error: false,
      matches: [{ notificationId: "notice-id", eventDate: "2026-10-11", expiresAt: "2026-11-11" }],
    });
    expect(result).toContain("notice-id");
    expect(result).toContain("<table");
    expect(result).not.toContain("synthetic-secret-subject-marker");
  });
});
