import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelPublicationBlockedListing, ChannelPublicationConnectionDetail } from "../domain/contracts";
import { readChannelPublicationBlockedListings } from "../read-model/queries";
import { ChannelPublicationDetailPage } from "../ui/publication-pages";

const connectionId = "connection-tcgplayer";
const blockedListing: ChannelPublicationBlockedListing = {
  listingId: "listing-one-piece-luffy",
  channelListingId: `${connectionId}:listing-one-piece-luffy`,
  blockingReasonCodes: ["provider-catalog-item-reference-unlinked"],
};

describe("channel-publication-blocking-reason-surface", () => {
  it("reads the reason codes a blocked channel listing link recorded", async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const db = rowsDb(calls, [
      {
        listing_id: blockedListing.listingId,
        channel_listing_id: blockedListing.channelListingId,
        blocking_reason_codes: [...blockedListing.blockingReasonCodes],
        total: 1,
      },
    ]);

    await expect(readChannelPublicationBlockedListings(db, connectionId)).resolves.toEqual({
      items: [blockedListing],
      total: 1,
    });
    expect(calls[0]?.sql).toContain("publish_state='blocked'");
    expect(calls[0]?.values).toEqual([connectionId, 25]);
  });

  it("renders the reason codes for a deliberately blocked listing", () => {
    const markup = renderDetail(detail([blockedListing], 1));

    expect(markup).toContain("Blocked listings");
    expect(markup).toContain(blockedListing.listingId);
    expect(markup).toContain(blockedListing.channelListingId);
    expect(markup).toContain("provider-catalog-item-reference-unlinked");
    expect(markup).not.toContain("No blocked listings");
  });

  it("names a blocked listing whose reasons were not recorded instead of rendering an empty row", () => {
    const markup = renderDetail(detail([{ ...blockedListing, blockingReasonCodes: [] }], 1));

    expect(markup).toContain("reason not recorded");
  });

  it("says how many blocked listings the page leaves out", () => {
    const markup = renderDetail(detail([blockedListing], 30));

    expect(markup).toContain("Showing the first 1 of 30 blocked listings.");
  });

  it("does not claim every listing composed when none is blocked", () => {
    const markup = renderDetail(detail([], 0));

    expect(markup).toContain("No blocked listings");
    expect(markup).toContain("This does not confirm that every listing has been composed.");
    expect(markup).not.toContain("provider-catalog-item-reference-unlinked");
  });
});

function renderDetail(value: ChannelPublicationConnectionDetail): string {
  const router = createMemoryRouter(
    [{ path: "/", element: <ChannelPublicationDetailPage state={{ kind: "ready", detail: value }} /> }],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
}

function detail(items: readonly ChannelPublicationBlockedListing[], total: number): ChannelPublicationConnectionDetail {
  return {
    connection: {
      connectionId,
      providerKey: "tcgplayer",
      environment: "sandbox",
      connectionStatus: "active",
      settingsState: "configured",
      reviewCount: 0,
    },
    settings: {
      titlePrefix: "",
      titleSuffix: "",
      descriptionFooter: "",
      categoryAllowlist: ["cards"],
      excludedListingIds: [],
    },
    mappingReview: { items: [], nextCursor: null, completeness: { kind: "complete", total: 0 } },
    blockedListings: { items, total },
    configurationStreamVersion: 1,
  };
}

function rowsDb(
  calls: { sql: string; values: readonly unknown[] }[],
  rows: readonly Record<string, unknown>[],
): PgQueryable {
  return {
    query: async <QueryRow,>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: rows as unknown as QueryRow[], rowCount: rows.length };
    },
  };
}
