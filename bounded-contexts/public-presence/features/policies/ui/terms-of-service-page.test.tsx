import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { requiredTermsOfServiceSubjectIds, termsOfServicePolicyArtifact } from "../domain/terms-of-service";
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

  it("links every policy reference inside its unchanged operative Terms paragraph, not just the footer", () => {
    renderPage();
    const article = screen.getByRole("article");
    const referencesBySection: Record<string, readonly string[]> = {
      "conduct-and-policy-incorporation": [
        "seller-agreement",
        "payments-terms",
        "agent-terms",
        "authenticity-terms",
        "privacy",
        "founders",
      ],
      "electronic-agents-and-automated-access": ["agent-terms"],
      "disclaimers-and-liability-limits": ["authenticity-terms"],
    };

    for (const section of termsOfServicePolicyArtifact.sections) {
      const region = within(article).getByRole("region", { name: section.title });
      const paragraph = region.querySelector("p");
      if (section.draftText.trim().length === 0) continue;
      expect(paragraph?.textContent, section.id).toBe(section.draftText);
      const expectedSlugs = referencesBySection[section.id] ?? [];
      const links = within(paragraph!).queryAllByRole("link");
      expect(
        links.map((link) => [link.textContent, link.getAttribute("href")]),
        section.id,
      ).toEqual(expectedSlugs.map((slug) => [`chasesets.com/${slug}`, `/${slug}`]));
    }
    expect(within(article).getAllByRole("link")).toHaveLength(8);
    expect(article.textContent).toContain("chasesets.com/developers");
    expect(within(article).queryByRole("link", { name: "chasesets.com/developers" })).toBeNull();
    expect(within(article).getAllByText("Counsel-approved language required")).toHaveLength(
      requiredTermsOfServiceSubjectIds.length,
    );
  });
});
