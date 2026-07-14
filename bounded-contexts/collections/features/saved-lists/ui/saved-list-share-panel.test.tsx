// @vitest-environment jsdom

import { t } from "@chase-sets/localization";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SavedListSharePanel, type SavedListShareState } from "./saved-list-share-panel";

afterEach(() => cleanup());

function state(overrides: Partial<SavedListShareState> = {}): SavedListShareState {
  return {
    visibility: "unlisted",
    disclosure: { showTrackedQuantities: true, showEstimatedValue: false },
    shareUrl: "https://chase-sets.com/lists/abc123",
    previewHref: "/lists/abc123",
    ...overrides,
  };
}

describe("SavedListSharePanel", () => {
  it("offers every visibility choice", () => {
    render(<SavedListSharePanel state={state()} />);

    expect(screen.getByText(t("collections.features.savedLists.web.share.visibility.private"))).toBeTruthy();
    expect(screen.getByText(t("collections.features.savedLists.web.share.visibility.unlisted"))).toBeTruthy();
    expect(screen.getByText(t("collections.features.savedLists.web.share.visibility.public"))).toBeTruthy();
  });

  it("hides disclosure and link controls while the list is private", () => {
    render(<SavedListSharePanel state={state({ visibility: "private", shareUrl: null, previewHref: null })} />);

    expect(screen.getByText(t("collections.features.savedLists.web.share.privateNotice"))).toBeTruthy();
    expect(screen.queryByText(t("collections.features.savedLists.web.share.disclosure.heading"))).toBeNull();
    expect(screen.queryByText(t("collections.features.savedLists.web.share.link.copy"))).toBeNull();
  });

  it("shows the unlisted link with copy, rotate, and revoke controls", () => {
    render(<SavedListSharePanel state={state()} />);

    expect(screen.getByText("https://chase-sets.com/lists/abc123")).toBeTruthy();
    expect(screen.getByText(t("collections.features.savedLists.web.share.link.copy"))).toBeTruthy();
    expect(screen.getByText(t("collections.features.savedLists.web.share.link.rotate"))).toBeTruthy();
    expect(screen.getByText(t("collections.features.savedLists.web.share.link.revoke"))).toBeTruthy();
  });

  it("hides the rotate control for a public list", () => {
    render(<SavedListSharePanel state={state({ visibility: "public" })} />);

    expect(screen.queryByText(t("collections.features.savedLists.web.share.link.rotate"))).toBeNull();
    expect(screen.getByText(t("collections.features.savedLists.web.share.link.revoke"))).toBeTruthy();
  });
});
