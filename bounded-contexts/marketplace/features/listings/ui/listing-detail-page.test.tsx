// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplaceListingDetailPage } from "./listing-detail-page";
import { ListingEvidenceReadiness } from "./listing-evidence-readiness";
import type { MarketplaceListingDetail, MarketplaceListingTermsPreview } from "./contracts";
import { authoredTextRecoveryMessage } from "../../reviews/ui/authored-text-recovery";

const listing: MarketplaceListingDetail = {
  listing_id: "lst_1",
  account_id: "acc_1",
  inventory_item_id: "inv_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::dim_condition:near_mint",
  item_language_code: "ja",
  item_title: "Charizard",
  item_subtitle: null,
  selected_options: [],
  product_summary: "Condition: Near Mint",
  product_measure_snapshot: null,
  graded_card: null,
  storage_location_name: "North shelf",
  ship_from_code: "CHI-WH-1",
  ship_from_address: {
    name: "",
    line1: "",
    city: "",
    state: "",
    postalCode: "",
    country: "US",
  },
  price_amount: "20.00",
  price_currency_code: "USD",
  listing_stream_version: 1,
  marketplace_sales_fee_unit_amount: "0.00",
  seller_net_unit_amount: "20.00",
  shipping_allowance_percentage_bps: 500,
  terms_schedule_id: "cts_launch",
  terms_agreement_id: null,
  terms_resolved_at: "2026-04-01T00:00:00.000Z",
  fee_quote_fingerprint: "stale-fingerprint",
  fee_locks: [],
  quantity_cap: 1,
  evidence_requirements: null,
  evidence: [],
  evidence_readiness: {
    ready: true,
    policy: {
      policyId: null,
      policyVersion: null,
      policyHash: "sha256:test",
      requirementHash: "sha256:requirement",
      evaluatedAt: "2026-07-13T00:00:00.000Z",
      explanationCodes: [],
    },
    requirements: {
      minimumPhotoCount: 0,
      requiredSlots: [],
      sellerTrustRequirements: [],
      buyerAcknowledgment: "none",
    },
    coverage: {
      complete: true,
      unmetCodes: [],
      slots: [],
      activePhotoCount: 0,
      minimumPhotoCount: 0,
    },
    nextActions: [],
    publicGallery: [],
  },
  status: "active",
  created_at: "2026-04-01T00:00:00.000Z",
  updated_at: "2026-04-01T00:00:00.000Z",
};

const currentQuote: MarketplaceListingTermsPreview = {
  account_type: "business",
  basis_amount: "20.00",
  marketplace_sales_fee_unit_amount: "1.00",
  seller_net_unit_amount: "19.00",
  marketplace_sales_fee_percentage_bps: 500,
  marketplace_sales_fee_fixed_amount: "0.00",
  marketplace_sales_fee_cap_amount: "25.00",
  shipping_allowance_percentage_bps: 750,
  schedule_id: "cts_current",
  agreement_id: null,
  resolved_at: "2026-04-17T00:00:00.000Z",
  fee_quote_fingerprint: "current-fingerprint",
};

afterEach(() => {
  cleanup();
});

function expectChrome(root: Element | null, label: string, included: readonly string[], excluded: readonly string[]) {
  expect(root, `${label} root`).not.toBeNull();
  const tokens = new Set((root as HTMLElement).className.split(/\s+/));
  for (const token of included) expect(tokens.has(token), `${label} includes ${token}`).toBe(true);
  for (const token of excluded) expect(tokens.has(token), `${label} excludes ${token}`).toBe(false);
}

const cardChromeExcluded = [
  "ds-glass",
  "border",
  "border-muted",
  "shadow-tokenSm",
  "shadow-tokenLg",
  "ds-glow",
  "hover:border-accent",
  "hover:shadow-tokenMd",
] as const;

describe("MarketplaceListingDetailPage", () => {
  it("distinguishes a system capacity pause and its actionable publication condition, clearing it when active", () => {
    const blocked = {
      ...listing,
      status: "paused",
      pause_reason: "inventory-capacity" as const,
      inventory_capacity_recovery_block: "evidence-incomplete" as const,
    };
    const { rerender } = render(<MarketplaceListingDetailPage listing={blocked} feeHistory={[]} />);
    expect(screen.getByText("Paused for inventory capacity")).toBeTruthy();
    expect(screen.getByText(/Review the Listing evidence checklist/)).toBeTruthy();
    rerender(
      <MarketplaceListingDetailPage
        listing={{ ...listing, status: "active", pause_reason: null, inventory_capacity_recovery_block: null }}
        feeHistory={[]}
      />,
    );
    expect(screen.queryByText("Paused for inventory capacity")).toBeNull();
  });

  it("explains a routine capacity shortage without attributing it to the seller", () => {
    render(
      <MarketplaceListingDetailPage
        listing={{
          ...listing,
          status: "paused",
          pause_reason: "inventory-capacity",
          inventory_capacity_recovery_block: null,
        }}
        feeHistory={[]}
      />,
    );
    expect(screen.getByText(/This system pause protects held stock/)).toBeTruthy();
  });
  it.each([
    [null, null],
    [null, "9.50"],
    ["0.50", null],
  ])("shows not-set rather than a fabricated native summary for fee %s and net %s", (fee, net) => {
    const { container } = render(
      <MarketplaceListingDetailPage
        listing={{
          ...listing,
          price_amount: "10.01",
          status: "draft",
          marketplace_sales_fee_unit_amount: fee,
          seller_net_unit_amount: net,
          fee_quote_fingerprint: null,
          terms_schedule_id: null,
          terms_resolved_at: null,
          shipping_allowance_percentage_bps: 0,
        }}
        feeHistory={[]}
      />,
    );
    expect(screen.getAllByText("Not set").length).toBeGreaterThan(0);
    expect(screen.queryByText("Incomplete price")).toBeNull();
    expect(screen.getByText("Marketplace sales fee:").nextElementSibling?.textContent).toBe(
      fee === null ? "Not set" : "$0.50",
    );
    expect(screen.getByText("Seller net:").nextElementSibling?.textContent).toBe(net === null ? "Not set" : "$9.50");
    expect(container.textContent).not.toContain("0.00");
    expect(screen.queryByText(/Marketplace \$.*\. Net/)).toBeNull();
    for (const input of container.querySelectorAll<HTMLInputElement>('input[name="feeQuoteFingerprint"]')) {
      expect(input.value).toBe("");
    }
  });

  it("preserves the native fee summary", () => {
    render(<MarketplaceListingDetailPage listing={listing} feeHistory={[]} />);
    expect(screen.getByText(/Marketplace \$0.00\. Net \$20.00\./)).toBeTruthy();
  });

  it("pins all six listing-detail roots to their ratified chrome", () => {
    const { container } = render(
      <MarketplaceListingDetailPage
        listing={{ ...listing, status: "draft", product_measure_snapshot: {} as never }}
        feeHistory={[]}
        priceDraftAmount="20.00"
        pricePreview={currentQuote}
      />,
    );

    expectChrome(
      screen.getByText("Near Mint").closest(".rounded-tokenLg"),
      "listing overview",
      ["ds-glass", "border", "border-muted", "shadow-tokenSm"],
      ["bg-surface-2", "ds-glow"],
    );
    const rootForIntent = (intent: string) =>
      container.querySelector(`[name="intent"][value="${intent}"]`)?.closest(".rounded-tokenLg") ?? null;
    expectChrome(rootForIntent("update-price"), "update listing", ["bg-surface-2"], cardChromeExcluded);
    expectChrome(rootForIntent("update-quantity-cap"), "quantity cap", ["bg-surface-2"], cardChromeExcluded);
    expectChrome(rootForIntent("update-purchase-limits"), "purchase limits", ["bg-surface-2"], cardChromeExcluded);
    expectChrome(rootForIntent("publish"), "publish controls", ["bg-surface-2"], cardChromeExcluded);

    const feeHistorySection = screen.getAllByRole("heading", { name: /fee lock history/i })[0]?.closest("section");
    expectChrome(
      feeHistorySection?.querySelector(".rounded-tokenLg.bg-surface-2") ?? null,
      "fee history",
      ["bg-surface-2"],
      cardChromeExcluded,
    );
  });

  it("directly renders a populated evidence photo as an outlined entity", () => {
    render(
      <ListingEvidenceReadiness
        listing={
          {
            status: "draft",
            evidence: [
              {
                photoId: "lpho_detail_1",
                altText: "Detail flow active photo",
                slotId: null,
                viewKind: null,
                status: "active",
                sortOrder: 0,
              },
            ],
            evidence_readiness: {
              ready: true,
              policy: {
                policyId: null,
                policyVersion: null,
                policyHash: "sha256:test",
                requirementHash: "sha256:req",
                evaluatedAt: "2026-08-19T00:00:00.000Z",
                explanationCodes: [],
              },
              requirements: {
                minimumPhotoCount: 1,
                requiredSlots: [],
                sellerTrustRequirements: [],
                buyerAcknowledgment: "none",
              },
              coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 1, minimumPhotoCount: 1 },
              nextActions: [],
              publicGallery: [],
            },
          } as never
        }
      />,
    );

    expectChrome(
      screen.getByText("Detail flow active photo").closest(".rounded-tokenLg"),
      "active evidence photo",
      ["border", "border-muted", "bg-surface"],
      ["ds-glass", "shadow-tokenSm", "shadow-tokenLg", "ds-glow", "hover:border-accent", "hover:shadow-tokenMd"],
    );
  });

  it("renders the fresh stale-quote fingerprint for browser retry submission", () => {
    const { container } = render(
      <MarketplaceListingDetailPage
        listing={listing}
        feeHistory={[]}
        priceDraftAmount="20.00"
        pricePreview={currentQuote}
        errorMessage="Fee quote changed. Review the current preview and submit again."
      />,
    );

    expect(screen.getByText("Fee quote changed. Review the current preview and submit again.")).toBeTruthy();
    expect(screen.getAllByText("Buyer shipping credit").length).toBeGreaterThan(0);
    expect(screen.getByText("Japanese")).toBeTruthy();
    expect(screen.getByText(/Buyer shipping credit 7.5%/)).toBeTruthy();
    expect(container.querySelector('input[name="feeQuoteFingerprint"][value="current-fingerprint"]')).toBeTruthy();
  });

  it("renders listing photo gallery with responsive variants", () => {
    render(
      <MarketplaceListingDetailPage
        listing={{
          ...listing,
          evidence: [
            {
              photoId: "lpho_1",
              originalFilename: "front.webp",
              altText: "Charizard front photo",
              slotId: null,
              viewKind: null,
              status: "active",
              sortOrder: 0,
              capturedAt: null,
              uploadedAt: "2026-04-01T00:00:00.000Z",
              assetRevision: "rev-source_hash",
              replacesPhotoId: null,
              assetSet: {
                kind: "listing-photo",
                sourceHash: "source_hash",
                source: {
                  role: "source",
                  width: 1200,
                  height: 1600,
                  density: null,
                  mediaType: "image/webp",
                  storageKey: "marketplace/listings/lst_1/lpho_1/source.webp",
                  publicUrl: "/listing-source.webp",
                  byteSize: 200,
                  generatedAt: "2026-04-01T00:00:00.000Z",
                },
                variants: [
                  {
                    role: "catalog-detail",
                    width: 480,
                    height: 640,
                    density: 1,
                    mediaType: "image/webp",
                    storageKey: "marketplace/listings/lst_1/lpho_1/catalog-detail-480w.webp",
                    publicUrl: "/listing-detail-480w.webp",
                    byteSize: 100,
                    generatedAt: "2026-04-01T00:00:00.000Z",
                  },
                  {
                    role: "catalog-detail",
                    width: 960,
                    height: 1280,
                    density: 2,
                    mediaType: "image/webp",
                    storageKey: "marketplace/listings/lst_1/lpho_1/catalog-detail-960w.webp",
                    publicUrl: "/listing-detail-960w.webp",
                    byteSize: 150,
                    generatedAt: "2026-04-01T00:00:00.000Z",
                  },
                  {
                    role: "thumbnail",
                    width: 96,
                    height: 128,
                    density: 1,
                    mediaType: "image/webp",
                    storageKey: "marketplace/listings/lst_1/lpho_1/thumbnail-96w.webp",
                    publicUrl: "/listing-thumbnail-96w.webp",
                    byteSize: 40,
                    generatedAt: "2026-04-01T00:00:00.000Z",
                  },
                  {
                    role: "thumbnail",
                    width: 192,
                    height: 256,
                    density: 2,
                    mediaType: "image/webp",
                    storageKey: "marketplace/listings/lst_1/lpho_1/thumbnail-192w.webp",
                    publicUrl: "/listing-thumbnail-192w.webp",
                    byteSize: 60,
                    generatedAt: "2026-04-01T00:00:00.000Z",
                  },
                ],
              },
            },
          ],
          evidence_readiness: {
            ...listing.evidence_readiness,
            coverage: {
              ...listing.evidence_readiness.coverage,
              activePhotoCount: 1,
            },
            publicGallery: [
              {
                photoId: "lpho_1",
                slotId: null,
                viewKind: null,
                altText: "Charizard front photo",
                sortOrder: 0,
                assets: [
                  {
                    role: "catalog-detail",
                    publicUrl: "/listing-detail-480w.webp",
                    width: 480,
                    height: 640,
                    density: 1,
                  },
                  {
                    role: "catalog-detail",
                    publicUrl: "/listing-detail-960w.webp",
                    width: 960,
                    height: 1280,
                    density: 2,
                  },
                ],
              },
            ],
          },
        }}
        feeHistory={[]}
        priceDraftAmount="20.00"
        pricePreview={currentQuote}
      />,
    );

    const image = screen.getByRole("img", { name: "Charizard front photo" });
    expect(image.getAttribute("src")).toBe("/listing-detail-480w.webp");
    expect(image.getAttribute("srcset")).toBe("/listing-detail-480w.webp 480w, /listing-detail-960w.webp 960w");
    expect(image.getAttribute("sizes")).toBe("(min-width: 768px) 480px, min(100vw, 276px)");
    expect(image.getAttribute("width")).toBe("480");
    expect(image.getAttribute("height")).toBe("640");
  });

  it("blocks draft publication when shipping measure is unresolved", () => {
    render(
      <MarketplaceListingDetailPage
        listing={{
          ...listing,
          status: "draft",
        }}
        feeHistory={[]}
        priceDraftAmount="20.00"
        pricePreview={currentQuote}
      />,
    );

    expect(screen.getByRole("button", { name: "Publish listing" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Resolve the catalog shipping measure before publishing this listing.")).toBeTruthy();
  });

  it("names a legacy incomplete price, blocks publication, and exposes a blank seller repair currency", () => {
    const { container } = render(
      <MarketplaceListingDetailPage
        listing={{
          ...listing,
          status: "draft",
          product_measure_snapshot: {} as never,
          price_currency_code: null,
        }}
        feeHistory={[]}
      />,
    );

    expect(screen.getAllByText("Incomplete price").length).toBeGreaterThan(0);
    expect(screen.getByText(/This historical listing has an amount but no currency/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish listing" }).hasAttribute("disabled")).toBe(true);
    expect((container.querySelector('input[name="priceCurrencyCode"]') as HTMLInputElement).value).toBe("");
    expect(container.innerHTML).not.toContain('value="USD"');
  });

  it("walks a draft through the concrete server-owned evidence action before publication", () => {
    const { container } = render(
      <MarketplaceListingDetailPage
        listing={{
          ...listing,
          status: "draft",
          product_measure_snapshot: {} as never,
          evidence_readiness: {
            ...listing.evidence_readiness,
            ready: false,
            requirements: {
              ...listing.evidence_readiness.requirements,
              minimumPhotoCount: 1,
              requiredSlots: [
                {
                  slotId: "front",
                  viewKind: "front",
                  minimumWidthPixels: 800,
                  minimumHeightPixels: 1000,
                  maximumAgeHours: null,
                },
              ],
            },
            coverage: {
              complete: false,
              unmetCodes: ["min-photo-count-unmet", "slot-missing"],
              slots: [
                {
                  slotId: "front",
                  viewKind: "front",
                  satisfied: false,
                  matchedPhotoId: null,
                  unmetCode: "slot-missing",
                },
              ],
              activePhotoCount: 0,
              minimumPhotoCount: 1,
            },
            nextActions: [
              {
                code: "min-photo-count-unmet",
                localeKey: "marketplace.features.listings.evidenceCoverage.min-photo-count-unmet",
                slotIds: [],
              },
              {
                code: "slot-missing",
                localeKey: "marketplace.features.listings.evidenceCoverage.slot-missing",
                slotIds: ["front"],
              },
            ],
          },
        }}
        feeHistory={[]}
      />,
    );

    expect(screen.getByText("Evidence required")).toBeTruthy();
    expect(screen.getByText("Add the required photo for this view.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish listing" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Complete the required evidence actions above before publishing.")).toBeTruthy();
    expect(container.querySelector('input[type="file"][capture="environment"]')).toBeTruthy();
  });
});

describe("issue-5258-marketplace-ac4 Listing publish standards and description recovery", () => {
  const draftWithPhoto = {
    ...listing,
    status: "draft",
    product_measure_snapshot: {} as never,
    evidence: [
      {
        photoId: "lpho_1",
        originalFilename: "front.png",
        altText: "Stored description",
        slotId: null,
        viewKind: null,
        status: "active",
        sortOrder: 0,
      },
    ],
  } as unknown as MarketplaceListingDetail;

  function expectStandardsLinksBefore(control: Element) {
    const guidelines = screen.getAllByRole("link", { name: "Community guidelines" });
    const support = screen.getAllByRole("link", { name: "Contact support" });
    expect(new Set(guidelines.map((link) => link.getAttribute("href")))).toEqual(
      new Set(["/help/buying/community-guidelines-and-enforcement"]),
    );
    expect(new Set(support.map((link) => link.getAttribute("href")))).toEqual(new Set(["/contact"]));
    expect(guidelines[0]!.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(support[0]!.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }

  it("links the canonical community guidelines and support before publishing and before saving a description", () => {
    render(<MarketplaceListingDetailPage listing={draftWithPhoto} feeHistory={[]} />);

    expectStandardsLinksBefore(screen.getByRole("button", { name: "Publish listing" }));
    expectStandardsLinksBefore(screen.getByRole("button", { name: "Save view" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the rejected description and links its field from an accessible summary", () => {
    const message = authoredTextRecoveryMessage("text_duplicate_link")!;
    render(
      <MarketplaceListingDetailPage
        listing={draftWithPhoto}
        feeHistory={[]}
        evidenceAltTextRecovery={{
          photoId: "lpho_1",
          altText: "Front https://x.example https://x.example",
          recovery: { code: "text_duplicate_link", message, fieldLevel: true },
        }}
      />,
    );

    const summary = screen.getByRole("alert");
    expect(summary.textContent).toContain("Your text was not posted");
    const fieldLink = within(summary).getByRole("link", { name: `Image description: ${message}` });
    const description = screen.getByRole("textbox", { name: "Image description" }) as HTMLInputElement;
    expect(fieldLink.getAttribute("href")).toBe(`#${description.id}`);
    expect(description.value).toBe("Front https://x.example https://x.example");
    expect(description.getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(fieldLink, { key: "Enter" });
    expect(document.activeElement).toBe(description);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});
