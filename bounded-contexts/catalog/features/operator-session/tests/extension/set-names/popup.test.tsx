// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system/theme";
import { OperatorExtensionPopup } from "../../../ui/extension-popup/popup";
import type { SetNamesPost } from "../../../domain/extension/set-names/transport";
import type { SetNamesRequest } from "../../../domain/extension/set-names/probe";
import { counts, entry, response } from "./fixture";

afterEach(cleanup);
function mount(
  request: SetNamesRequest = vi.fn(async () => response()),
  post: SetNamesPost = vi.fn(async () => ({ outcome: "recorded", ...counts })),
  copyReceipt = vi.fn(async (_text: string) => undefined),
) {
  render(
    <ChaseRoot>
      <OperatorExtensionPopup
        request={async () => ({
          paired: true,
          state: "idle",
          lastOutcome: null,
          lastPushedAt: null,
          serverRevision: 0,
        })}
        setNameRequest={request}
        postSetNames={post}
        copyProbeReport={copyReceipt}
      />
    </ChaseRoot>,
  );
  return { request, post, copyReceipt };
}
async function select() {
  await waitFor(() => expect(screen.getByText("Paired. Session forwarding is ready.")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Product line"), { target: { value: "3" } });
}

describe("TCGplayer set names action states", () => {
  it("offers exactly the four bound product lines, no Lorcana, and starts empty with Run disabled", async () => {
    mount();
    const select = screen.getByLabelText("Product line") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "1", "2", "3", "68"]);
    expect(Array.from(select.options).map((option) => option.text)).not.toContain("Disney Lorcana");
    expect((screen.getByRole("button", { name: "Run", exact: true }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Receipt")).toBeNull();
    await selectStatus();
  });
  it("shows fetching then receipt and posting, prevents duplicate Run and environment changes, and renders Catalog counts", async () => {
    let resolveFetch!: (value: ReturnType<typeof response>) => void;
    let resolvePost!: (value: { outcome: "recorded" } & typeof counts) => void;
    const request = vi.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const post = vi.fn<SetNamesPost>(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    mount(request, post);
    await select();
    const run = screen.getByRole("button", { name: "Run", exact: true });
    fireEvent.click(run);
    fireEvent.click(run);
    expect((screen.getByRole("button", { name: "Fetching set names" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Environment") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Receipt")).toBeNull();
    await act(async () => resolveFetch(response()));
    expect(screen.getByLabelText("Receipt")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Posting to Catalog" }) as HTMLButtonElement).disabled).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith("3");
    expect(post).toHaveBeenCalledOnce();
    await act(async () => resolvePost({ outcome: "recorded", ...counts }));
    expect(screen.getByText("Catalog set names recorded")).toBeTruthy();
    expect(screen.getByText("Catalog observations: 1")).toBeTruthy();
    expect(screen.getByText("New observations: 1")).toBeTruthy();
    expect(screen.getByText("Mappings proposed: 0")).toBeTruthy();
  });
  it("copies only the value-free receipt, never provider name/id/body/auth markers", async () => {
    const marker = "Cookie TCGAuthTicket=private Bearer private";
    const { copyReceipt } = mount(async () =>
      response({
        errors: [],
        results: [entry({ name: marker, cleanSetName: marker, urlName: marker, setNameId: 1931987 })],
      }),
    );
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Run", exact: true }));
    await screen.findByText("Catalog set names recorded");
    fireEvent.click(screen.getByRole("button", { name: "Copy receipt text" }));
    expect(copyReceipt).toHaveBeenCalledOnce();
    const receipt = copyReceipt.mock.calls[0]![0];
    expect(JSON.parse(receipt)).toMatchObject({ resultCount: 1, activeCount: 1, errorsCount: 0 });
    expect(receipt).not.toMatch(/private|TCGAuthTicket|Cookie|Bearer|1931987/);
    expect(document.body.textContent).not.toMatch(/private|TCGAuthTicket|Cookie|Bearer|1931987/);
    expect((screen.getByLabelText("Receipt") as HTMLTextAreaElement).value).toBe(receipt);
  });
  it("shows only fixed error codes for an invalid response and does not post", async () => {
    const post = vi.fn<SetNamesPost>();
    mount(async () => response({ errors: ["Cookie TCGAuthTicket=private"], results: [entry()] }), post);
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Run", exact: true }));
    await screen.findByText("Set names stopped: unqualified (invalid-body)");
    expect(post).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/TCGAuthTicket|private|Synthetic Pokemon/);
  });
  it("shows the re-pair prompt on an expired grant without retry", async () => {
    const post = vi.fn<SetNamesPost>(async () => ({ outcome: "grant-invalid" }));
    const request = vi.fn(async () => response());
    mount(request, post);
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Run", exact: true }));
    await screen.findByText("The grant is no longer valid. Pair again with a new grant.");
    expect(request).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
  });
  it("clears receipt/results when product line or environment changes", async () => {
    mount();
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Run", exact: true }));
    await screen.findByText("Catalog set names recorded");
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "production" } });
    expect(screen.queryByLabelText("Receipt")).toBeNull();
    expect(screen.queryByText("Catalog set names recorded")).toBeNull();
    await selectStatus();
  });
  it("contains clipboard failure without echoing exception text", async () => {
    mount(
      undefined,
      undefined,
      vi.fn(async () => {
        throw new Error("TCGAuthTicket=private");
      }),
    );
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Run", exact: true }));
    await screen.findByText("Catalog set names recorded");
    fireEvent.click(screen.getByRole("button", { name: "Copy receipt text" }));
    await screen.findByText("Receipt copy failed.");
    expect(document.body.textContent).not.toContain("TCGAuthTicket");
  });
});

async function selectStatus() {
  await waitFor(() => expect(screen.queryByText("Loading status")).toBeNull());
}
