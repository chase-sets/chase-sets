import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { requiredTermsOfServiceSubjectIds } from "../domain/terms-of-service";
import { TermsOfServicePage } from "./terms-of-service-page";

function renderPage() {
  return render(
    <MemoryRouter>
      <TermsOfServicePage />
    </MemoryRouter>,
  );
}

describe("Terms of Service publication page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders durable publication metadata and all counsel placeholders accessibly", () => {
    const { container } = renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Terms of service" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Wallet nature, custody, and interest" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Marketplace role and limited payments agent" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Governing law and forum" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Terms sections" });
    expect(within(nav).getAllByRole("link")).toHaveLength(requiredTermsOfServiceSubjectIds.length);
    expect(screen.getAllByText("Counsel-approved language required")).toHaveLength(
      requiredTermsOfServiceSubjectIds.length,
    );
    expect(screen.getByText("Version v1")).toBeTruthy();
    expect(screen.getByText("Effective date pending counsel approval")).toBeTruthy();

    const page = container.querySelector('[data-policy-key="terms-of-service"]');
    expect(page?.getAttribute("data-policy-version")).toBe("v1");
    expect(page?.getAttribute("data-policy-publication-status")).toBe("counsel-review-required");
    expect(page?.getAttribute("data-policy-effective-at")).toBe("");
  });

  it("offers a printable view using the design-system action", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Print terms" }));

    expect(print).toHaveBeenCalledOnce();
  });
});
