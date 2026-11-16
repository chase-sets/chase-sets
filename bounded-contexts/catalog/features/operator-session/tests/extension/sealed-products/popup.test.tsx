// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system/theme";
import { OperatorExtensionPopup } from "../../../ui/extension-popup/popup";
import type { SealedFetch } from "../../../domain/extension/sealed-products/collector";
import type { SealedPost } from "../../../domain/extension/sealed-products/transport";
import { entry } from "../set-names/fixture";
import { counts, detail, selection, page, response } from "./fixture";
afterEach(cleanup);
function mount(
  request: SealedFetch = async (request) =>
    response(request.endpoint === "search" ? page(0, 1) : { ...detail(), productId: 1 }),
  post: SealedPost = async () => ({ outcome: "recorded", ...counts }),
) {
  const copy = vi.fn(async (_text: string) => undefined);
  const provider = vi.fn(request);
  const catalog = vi.fn(post);
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
        setNameRequest={async () =>
          response({
            errors: [],
            results: [
              entry({
                categoryId: selection().productLineId,
                setNameId: selection().setId,
                name: selection().setName,
                cleanSetName: selection().setName,
              }),
            ],
          })
        }
        postSetNames={async () => ({
          outcome: "recorded",
          observationCount: 1,
          newObservationCount: 1,
          mappingsProposed: 0,
        })}
        sealedRequest={provider}
        postSealedProducts={catalog}
        copyProbeReport={copy}
      />
    </ChaseRoot>,
  );
  return { provider, catalog, copy };
}
async function select() {
  await waitFor(() => expect(screen.getByText("Paired. Session forwarding is ready.")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Product line"), { target: { value: String(selection().productLineId) } });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await screen.findByText("Catalog set names recorded");
  fireEvent.change(screen.getByLabelText("Sealed product line"), {
    target: { value: String(selection().productLineId) },
  });
  fireEvent.change(screen.getByLabelText("Set"), { target: { value: String(selection().setId) } });
}
describe("sealed products popup", () => {
  it("starts empty, excludes unbound lines and uses only the last set-name fetch for the chosen line", async () => {
    mount();
    expect(
      Array.from((screen.getByLabelText("Sealed product line") as HTMLSelectElement).options).map(
        (option) => option.value,
      ),
    ).toEqual(["", "1", "3"]);
    expect((screen.getByRole("button", { name: "Run sealed products" }) as HTMLButtonElement).disabled).toBe(true);
    await select();
    expect((screen.getByRole("button", { name: "Run sealed products" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Sealed product line"), { target: { value: "3" } });
    expect((screen.getByLabelText("Set") as HTMLSelectElement).options.length).toBe(1);
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "production" } });
    await waitFor(() => expect((screen.getByLabelText("Sealed product line") as HTMLSelectElement).value).toBe(""));
  });
  it("shows loading, prevents overlapping runs and environment changes, then displays and copies only the receipt and Catalog counts", async () => {
    let resolve!: (value: Awaited<ReturnType<SealedPost>>) => void;
    const { provider, catalog, copy } = mount(
      undefined,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await select();
    const run = screen.getByRole("button", { name: "Run sealed products" });
    fireEvent.click(run);
    fireEvent.click(run);
    await screen.findByText("Searching, fetching sealed details and posting to Catalog");
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Environment") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Run probe" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(catalog).toHaveBeenCalledOnce());
    await act(async () => resolve({ outcome: "recorded", ...counts }));
    await screen.findByText("Catalog sealed products recorded");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("Catalog recorded: 1; changed: 1; unchanged: 0; candidates: 1; exclusions: 0"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy sealed product receipt" }));
    expect(copy).toHaveBeenCalledOnce();
    const receipt = copy.mock.calls[0]![0];
    expect(JSON.parse(receipt)).toMatchObject({ verdict: "complete", posts: 1 });
    expect(receipt).not.toMatch(/productId|productName|price|Bearer|Cookie/i);
    expect((screen.getByLabelText("Sealed product receipt") as HTMLTextAreaElement).value).toBe(receipt);
  });
  it.each(["grant-invalid", "unavailable", "refused", "invalid-response"] as const)(
    "renders the fixed %s error and stops",
    async (outcome) => {
      const { catalog } = mount(undefined, async () => ({ outcome }));
      await select();
      fireEvent.click(screen.getByRole("button", { name: "Run sealed products" }));
      await screen.findByText(
        outcome === "grant-invalid"
          ? "The grant is no longer valid. Pair again with a new grant."
          : `Sealed products stopped: ${outcome}`,
      );
      expect(catalog).toHaveBeenCalledOnce();
    },
  );
  it("shows an unqualified receipt without echoing provider errors or posting", async () => {
    const { catalog } = mount(async () => response({ errors: ["Cookie TCGAuthTicket=private"], results: [] }));
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Run sealed products" }));
    await screen.findByText("Sealed products stopped: unqualified");
    expect(catalog).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/TCGAuthTicket|private/);
  });
});
