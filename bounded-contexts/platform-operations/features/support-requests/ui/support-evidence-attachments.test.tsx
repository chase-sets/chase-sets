import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SupportEvidenceAttachmentGallery, SupportEvidenceAttachmentInput } from "./support-evidence-attachments";

describe("support evidence attachment UI", () => {
  afterEach(cleanup);

  it("keeps an oversized photo selection recoverable with a clear client-side error", async () => {
    const user = userEvent.setup();
    render(<SupportEvidenceAttachmentInput required />);

    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "too-large.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByLabelText("Add evidence photos"), file);

    expect(screen.getByText("Each photo must be 10 MB or smaller.")).toBeTruthy();
    expect(screen.getByLabelText("Add evidence photos").getAttribute("aria-invalid")).toBe("true");
  });

  it("renders private attachment thumbnails with an authorized full-size view", () => {
    render(
      <SupportEvidenceAttachmentGallery
        supportRequestId="sup_case"
        attachments={[
          "support-attachment:v1:sea_photo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:jpg",
          "https://public.example.test/must-not-render.jpg",
        ]}
      />,
    );

    const image = screen.getByRole("img", { name: "Evidence photo 1" });
    expect(image.getAttribute("src")).toBe("/api/marketplace/support-requests/sup_case/attachments/sea_photo");
    const fullSize = screen.getByRole("link", { name: "View full-size photo 1" });
    expect(fullSize.getAttribute("href")).toBe("/api/marketplace/support-requests/sup_case/attachments/sea_photo");
    expect(document.body.innerHTML).not.toContain("public.example.test");
  });
});
