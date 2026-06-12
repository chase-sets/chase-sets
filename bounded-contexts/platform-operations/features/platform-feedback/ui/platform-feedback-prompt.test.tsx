// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMocks = vi.hoisted(() => ({
  dismissPlatformFeedbackPrompt: vi.fn(),
  getPromptEligibility: vi.fn(),
  submitPlatformFeedback: vi.fn(),
}));

vi.mock("../../../support/request-support/api-client", () => ({
  ExperienceApiError: class ExperienceApiError extends Error {
    public constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${status}`);
    }
  },
  createExperienceApiClient: () => apiMocks,
}));

import { PlatformFeedbackPrompt } from "./platform-feedback-prompt";

describe("platform feedback prompt", () => {
  afterEach(() => {
    cleanup();
    apiMocks.dismissPlatformFeedbackPrompt.mockReset();
    apiMocks.getPromptEligibility.mockReset();
    apiMocks.submitPlatformFeedback.mockReset();
  });

  it("submits contextual feedback with related IDs", async () => {
    apiMocks.getPromptEligibility.mockResolvedValue({ shouldPrompt: true, reason: "eligible" });
    apiMocks.submitPlatformFeedback.mockResolvedValue({
      id: "pfb_test",
      version: 1,
      status: "submitted",
    });
    const user = userEvent.setup();
    render(
      <PlatformFeedbackPrompt
        workflow="listing-update"
        sourceRoutePath="/account/listings/lst_test"
        relatedEntities={[
          { type: "listing", id: "lst_test" },
          { type: "inventory-item", id: "inv_test" },
        ]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Leave feedback" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /Topic/ }), "pricing-fees");
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "Fee preview was clear.");
    await user.click(
      screen.getByRole("checkbox", {
        name: /I am open to follow-up using my existing account contact methods/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Submit feedback" }));

    expect(apiMocks.submitPlatformFeedback).toHaveBeenCalledWith({
      rating: 5,
      topic: "pricing-fees",
      comment: "Fee preview was clear.",
      followUpConsent: true,
      workflow: "listing-update",
      sourceRoutePath: "/account/listings/lst_test",
      relatedEntities: [
        { type: "listing", id: "lst_test" },
        { type: "inventory-item", id: "inv_test" },
      ],
    });
    expect(await screen.findByText("Thanks for the feedback")).toBeTruthy();
  });

  it("keeps the open form input available when submission fails", async () => {
    apiMocks.getPromptEligibility.mockResolvedValue({ shouldPrompt: true, reason: "eligible" });
    apiMocks.submitPlatformFeedback.mockRejectedValue(new Error("Offline. Try again."));
    const user = userEvent.setup();
    render(
      <PlatformFeedbackPrompt
        workflow="inventory-adjust"
        sourceRoutePath="/account/inventory/items/inv_test"
        relatedEntities={[{ type: "inventory-item", id: "inv_test" }]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Leave feedback" }));
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "Adjustment was slow.");
    await user.click(screen.getByRole("button", { name: "Submit feedback" }));

    expect(await screen.findByText("Offline. Try again.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Comment" })).toMatchObject({
      value: "Adjustment was slow.",
    });
    expect(screen.getByRole("button", { name: "Submit feedback" })).toBeTruthy();
  });
});
