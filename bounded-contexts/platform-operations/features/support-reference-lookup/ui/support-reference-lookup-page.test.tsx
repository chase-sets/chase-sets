// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SupportReferenceLookupPage } from "./support-reference-lookup-page";
import type { SupportReferenceLookupResult } from "../api/contracts";

afterEach(() => {
  cleanup();
});

describe("SupportReferenceLookupPage", () => {
  it("shows only the search box before any search has been submitted", () => {
    render(<SupportReferenceLookupPage query="" result={null} searched={false} />);

    expect(screen.getByLabelText("Reference")).toBeTruthy();
    expect(screen.queryByText("Result")).toBeNull();
    expect(screen.queryByText("No record found")).toBeNull();
  });

  it("renders a resolved result with its owning context, type, reference, status, and a link to the record", () => {
    const result: SupportReferenceLookupResult = {
      contextName: "ordering",
      entityType: "order",
      displayReference: "ORD-E6K7M8N9",
      status: "pending-payment",
      summary: "Order ORD-E6K7M8N9",
      adminHref: "/orders/ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    };

    render(<SupportReferenceLookupPage query="ORD-E6K7M8N9" result={result} searched />);

    expect(screen.getByText("Order ORD-E6K7M8N9")).toBeTruthy();
    expect(screen.getByText("ordering")).toBeTruthy();
    expect(screen.getByText("order")).toBeTruthy();
    expect(screen.getByText("ORD-E6K7M8N9")).toBeTruthy();
    expect(screen.getByText("pending-payment")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open record" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/orders/ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
  });

  it("renders a not-found state after an unmatched search without hiding the search box", () => {
    render(<SupportReferenceLookupPage query="ORD-MISSING" result={null} searched />);

    expect(screen.getByLabelText("Reference")).toBeTruthy();
    expect(screen.getByText("No record found")).toBeTruthy();
    expect(screen.getByText(/ORD-MISSING/)).toBeTruthy();
  });

  it("renders an error banner instead of a result section when the lookup failed", () => {
    render(<SupportReferenceLookupPage query="ORD-E6K7M8N9" result={null} searched error="Lookup failed." />);

    expect(screen.getByText("Lookup failed.")).toBeTruthy();
    expect(screen.queryByText("No record found")).toBeNull();
  });

  it("omits the record type row's link when no admin href is available", () => {
    const result: SupportReferenceLookupResult = {
      contextName: "checkout",
      entityType: "sell-list-confirmation",
      displayReference: "CS-SL-A1B2C3D4",
      status: null,
      summary: "Sell list confirmation CS-SL-A1B2C3D4",
      adminHref: null,
    };

    render(<SupportReferenceLookupPage query="CS-SL-A1B2C3D4" result={result} searched />);

    expect(screen.queryByRole("link", { name: "Open record" })).toBeNull();
  });
});
