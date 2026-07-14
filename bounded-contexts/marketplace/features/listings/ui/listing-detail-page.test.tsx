// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplaceListingDetailPage } from "./listing-detail-page";
import type { MarketplaceListingDetail, MarketplaceListingTermsPreview } from "./contracts";

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

describe("MarketplaceListingDetailPage", () => {
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
