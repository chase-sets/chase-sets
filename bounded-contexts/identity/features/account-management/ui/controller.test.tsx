// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, render } from "@testing-library/react";
import { Button, HiddenInput, TextInput } from "@chase-sets/design-system";
import { AccountMutationBoundary, AccountMutationForm } from "./controller";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router";
import * as routerApi from "react-router";
import {
  renderAccountManagementPage,
  renderHeldAccountManagementRoute,
  settleAccountManagementRoute,
  stubHeldAccountManagementTransport,
} from "./test-support";
import { syntheticMutationResult } from "../api/test-support";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("issue-9909 controller hand-off", () => {
  const target = "adr_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const otherTarget = "adr_01ARZ3NDEKTSV4RRFFQ69G5FAT";
  const marker = "SYNTHETIC-SECRET-MARKER-9909";
  const failedSafe = "No change was recorded. Review and submit again.";
  const ambiguous = "We could not confirm the result. Do not repeat this action yet.";
  const failure = {
    kind: "validation",
    status: 400,
    code: "validation_failed",
    message: "City is required.",
    intent: "update",
    shippingAddressId: target,
    classification: marker,
    errors: { fieldErrors: { city: ["City is required."] }, formErrors: [] },
  };
  function setup(value: unknown = { failure }, status = 400) {
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(routerApi, "UNSAFE_decodeViaTurboStream").mockResolvedValue({ value: { data: value } } as never);
    const fetch = vi.fn().mockImplementation(async () => new Response("synthetic", { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  function ShippingForm({
    name = "Save",
    intent = "update",
    id = target,
    onMutation,
  }: {
    name?: string;
    intent?: string;
    id?: string;
    onMutation?: ComponentProps<typeof AccountMutationForm>["onMutation"];
  }) {
    return (
      <AccountMutationForm method="post" onMutation={onMutation}>
        <HiddenInput name="intent" value={intent} />
        {intent !== "create" ? <HiddenInput name="shippingAddressId" value={id} /> : null}
        <TextInput name="city" label={`${name} city`} defaultValue="Old" />
        <Button type="submit">{name}</Button>
      </AccountMutationForm>
    );
  }
  function form(name: string) {
    return screen.getByRole("button", { name }).closest("form")!;
  }
  async function ready(name = "Save") {
    await waitFor(() => expect(screen.getByRole("button", { name }).matches(":disabled")).toBe(false));
  }
  function assertPrivate(spies: ReturnType<typeof vi.spyOn>[]) {
    expect(document.body.innerHTML).not.toContain(marker);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(marker);
  }
  it("caller-presented failures repeat without controller Banner or status focus and exclude secret markers", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
      vi.spyOn(console, "trace"),
    ];
    const fetch = setup();
    const onMutation = vi.fn();
    renderAccountManagementPage(<ShippingForm onMutation={onMutation} />, "/account/shipping-addresses");
    await ready();
    for (let attempt = 1; attempt <= 2; attempt++) {
      fireEvent.submit(form("Save"));
      await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(attempt * 2));
      expect(screen.queryByText(failedSafe)).toBeNull();
      expect(document.activeElement).not.toBe(screen.getByRole("status"));
      expect(JSON.stringify(onMutation.mock.calls)).not.toContain(marker);
      assertPrivate(spies);
    }
    expect(onMutation.mock.calls.map(([event]) => event.type)).toEqual(["accepted", "failure", "accepted", "failure"]);
    expect(onMutation.mock.calls[1][0].failure).not.toBe(onMutation.mock.calls[3][0].failure);
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "POST"]);
  });
  it.each([
    ["rejected field message", { ...failure, errors: { fieldErrors: { unknown: [marker] }, formErrors: [] } }],
    ["unknown nested key", { ...failure, errors: { ...failure.errors, unknown: marker } }],
    ["rejected envelope message", { ...failure, intent: "create", message: marker }],
  ])("caller-presented failures exclude secret markers from %s", async (_name, rejected) => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
      vi.spyOn(console, "trace"),
    ];
    setup({ failure: rejected });
    const onMutation = vi.fn();
    renderAccountManagementPage(<ShippingForm onMutation={onMutation} />, "/account/shipping-addresses");
    await ready();
    fireEvent.submit(form("Save"));
    await waitFor(() => expect(onMutation.mock.calls.length).toBeGreaterThan(0));
    if (rejected.intent === "create") await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(2));
    else await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
    expect(JSON.stringify(onMutation.mock.calls)).not.toContain(marker);
    assertPrivate(spies);
  });
  it("caller-presented failures keep pre-send rejection controller-presented", async () => {
    const fetch = setup();
    const onMutation = vi.fn();
    renderAccountManagementPage(
      <AccountMutationForm method="post" onMutation={onMutation}>
        <HiddenInput name="intent" value="unknown" />
        <Button type="submit">Save</Button>
      </AccountMutationForm>,
      "/account/shipping-addresses",
    );
    await ready();
    fireEvent.submit(form("Save"));
    await screen.findByText(failedSafe);
    expect(onMutation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });
  it("caller-presented failures keep an unmounted submitting form controller-presented", async () => {
    const fetch = setup();
    let release!: (response: Response) => void;
    fetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const onMutation = vi.fn();
    function Removable() {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          <Button type="button" onClick={() => setMounted(false)}>
            Remove form
          </Button>
          {mounted ? <ShippingForm onMutation={onMutation} /> : null}
        </>
      );
    }
    renderAccountManagementPage(<Removable />, "/account/shipping-addresses");
    await ready();
    fireEvent.submit(form("Save"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Remove form" }));
    release(new Response("synthetic", { status: 400 }));
    await screen.findByText(failedSafe);
    expect(onMutation.mock.calls.map(([event]) => event.type)).toEqual(["accepted"]);
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });
  it.each(["conflict", "ambiguous"])("caller-presented failures preserve %s Banner focus and hold", async (state) => {
    const fetch = setup({ outcome: "conflict", code: "conflict" }, 409);
    if (state === "ambiguous")
      fetch
        .mockRejectedValueOnce(new TypeError("synthetic loss"))
        .mockResolvedValueOnce(Response.json({ outcome: "indeterminate", code: "INDETERMINATE" }));
    const onMutation = vi.fn();
    renderAccountManagementPage(<ShippingForm onMutation={onMutation} />, "/account/shipping-addresses");
    await ready();
    fireEvent.submit(form("Save"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
    expect(screen.getByRole("status").textContent).not.toBe("");
    expect(onMutation.mock.calls.map(([event]) => event.type)).toEqual(["accepted"]);
    expect(screen.getByRole("button", { name: "Save" }).matches(":disabled")).toBe(state === "ambiguous");
  });
  it("caller-presented failures suggestion-choice resubmit retains the original callback", async () => {
    const suggestedAddress = {
      name: "Test",
      company: null,
      line1: "1 Test St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
      verification: {
        status: "unverified",
        source: "synthetic",
        checkedAt: "2026-01-01T00:00:00Z",
        buyerDecision: "provider-unavailable",
      },
    };
    const fetch = setup({ outcome: "not-recorded", code: "address-standardization-suggested", suggestedAddress });
    const onMutation = vi.fn();
    renderAccountManagementPage(<ShippingForm onMutation={onMutation} />, "/account/shipping-addresses");
    await ready();
    fireEvent.submit(form("Save"));
    const choice = await screen.findByRole("button", { name: /Use suggested/i });
    vi.mocked(routerApi.UNSAFE_decodeViaTurboStream).mockResolvedValue({ value: { data: { failure } } } as never);
    fireEvent.click(choice);
    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(3));
    expect(onMutation.mock.calls.map(([event]) => event.type)).toEqual(["accepted", "accepted", "failure"]);
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "POST"]);
    expect((fetch.mock.calls[1][1].body as FormData).get("addressVerificationDecision")).toBe("accept-suggested");
  });
  it.each([401, 403, 200])(
    "caller-presented failures preserve non-failure presentation for HTTP %s",
    async (status) => {
      setup(
        status === 200
          ? syntheticMutationResult(
              "update",
              { tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" },
              { target },
            )
          : null,
        status,
      );
      const onMutation = vi.fn();
      renderAccountManagementPage(<ShippingForm onMutation={onMutation} />, "/account/shipping-addresses");
      await ready();
      fireEvent.submit(form("Save"));
      const controllerStatus = () => screen.getAllByRole("status").find((region) => region.tabIndex === -1)!;
      await waitFor(() => expect(document.activeElement).toBe(controllerStatus()));
      expect(controllerStatus().textContent).not.toBe("");
      expect(onMutation.mock.calls.map(([event]) => event.type)).toEqual(["accepted"]);
      expect(screen.getByRole("button", { name: "Save" }).matches(":disabled")).toBe(status !== 200);
    },
  );
  it("consumer preservation keeps the non-opted account profile Banner and focus", async () => {
    const fetch = setup({ outcome: "not-recorded", code: "validation-failed" });
    renderAccountManagementPage(
      <AccountMutationForm method="post">
        <HiddenInput name="intent" value="update-profile" />
        <TextInput name="name" label="Profile name" defaultValue="User work" />
        <Button type="submit">Save profile</Button>
      </AccountMutationForm>,
    );
    await ready("Save profile");
    fireEvent.submit(form("Save profile"));
    await screen.findByText(failedSafe);
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST"]);
    await ready("Save profile");
    expect((screen.getByLabelText("Profile name") as HTMLInputElement).value).toBe("User work");
  });
  it("consumer preservation keeps row-local busy holds values and non-opted presentation", async () => {
    const fetch = setup();
    let lose!: () => void;
    let confirm!: (response: Response) => void;
    fetch
      .mockReturnValueOnce(
        new Promise<Response>((_resolve, reject) => {
          lose = () => reject(new TypeError("synthetic loss"));
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          confirm = resolve;
        }),
      );
    const onMutation = vi.fn();
    renderAccountManagementPage(
      <>
        <ShippingForm name="Create" intent="create" onMutation={onMutation} />
        <ShippingForm name="Update" onMutation={onMutation} />
        <ShippingForm name="Default" intent="default" id={otherTarget} />
        <ShippingForm name="Archive" intent="archive" id={otherTarget} />
        <ShippingForm name="Other update" id={otherTarget} />
        <ShippingForm name="Duplicate update" />
      </>,
      "/account/shipping-addresses",
    );
    await ready("Update");
    fireEvent.change(screen.getByLabelText("Update city"), { target: { value: "User work" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await screen.findByText("Saving your change");
    for (const name of ["Create", "Default", "Archive", "Other update", "Duplicate update"])
      expect(screen.getByRole("button", { name }).matches(":disabled")).toBe(false);
    fireEvent.submit(form("Update"));
    expect(fetch).toHaveBeenCalledTimes(1);
    lose();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Update" }).matches(":disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Update" }).getAttribute("aria-busy")).toBe("true");
    for (const name of ["Create", "Default", "Archive", "Other update", "Duplicate update"])
      expect(screen.getByRole("button", { name }).matches(":disabled")).toBe(false);
    fireEvent.submit(form("Update"));
    expect(fetch).toHaveBeenCalledTimes(2);
    confirm(Response.json({ outcome: "not-recorded", code: "not-recorded" }));
    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(2));
    await ready("Update");
    expect((screen.getByLabelText("Update city") as HTMLInputElement).value).toBe("User work");
    expect(screen.queryByText(failedSafe)).toBeNull();
    for (const name of ["Default", "Archive", "Other update"]) {
      const before = fetch.mock.calls.length;
      screen.getByRole("button", { name }).focus();
      fireEvent.submit(form(name));
      await screen.findByText(failedSafe);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(before + 1));
      await ready(name);
      expect(screen.getByText(failedSafe)).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("status"));
    }
    fetch
      .mockRejectedValueOnce(new TypeError("synthetic loss"))
      .mockResolvedValueOnce(Response.json({ outcome: "indeterminate", code: "INDETERMINATE" }));
    fireEvent.submit(form("Update"));
    await screen.findByText(ambiguous);
    expect(screen.getByRole("button", { name: "Update" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Duplicate update" }).matches(":disabled")).toBe(true);
    for (const name of ["Create", "Default", "Archive", "Other update"])
      expect(screen.getByRole("button", { name }).matches(":disabled")).toBe(false);
    const posts = fetch.mock.calls.filter((call) => call[1].method === "POST").length;
    fireEvent.submit(form("Update"));
    expect(fetch.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(posts);
    fireEvent.submit(form("Create"));
    await waitFor(() => expect(fetch.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(posts + 1));
    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(5));
    expect(fetch.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(6);
    expect(fetch.mock.calls.filter((call) => call[1].method === "GET")).toHaveLength(2);
  });
});
describe("issue-7168-ac9-transport-state", () => {
  it("caller-presented failures notify once per attempt and suppress the controller Banner", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(routerApi, "UNSAFE_decodeViaTurboStream").mockResolvedValue({
      value: {
        data: {
          failure: {
            kind: "validation",
            status: 400,
            code: "validation_failed",
            message: "Name is required.",
            intent: "update-profile",
            errors: { fieldErrors: { name: ["Name is required."] }, formErrors: [] },
          },
        },
      },
    } as never);
    const fetch = vi.fn().mockResolvedValue(new Response("synthetic", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const onMutation = vi.fn();
    renderAccountManagementPage(
      <AccountMutationForm method="post" onMutation={onMutation}>
        <HiddenInput name="intent" value="update-profile" />
        <TextInput name="name" label="Name" />
        <Button type="submit">Save</Button>
      </AccountMutationForm>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).matches(":disabled")).toBe(false));
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(2));
    expect(onMutation.mock.calls.map(([event]) => event.type)).toEqual(["accepted", "failure"]);
    expect(onMutation.mock.calls[1][0]).toMatchObject({
      type: "failure",
      failure: { intent: "update-profile", target: "acc_test", message: "Name is required." },
    });
    expect(screen.queryByText("No change was recorded. Review and submit again.")).toBeNull();
  });

  it("holds only the ambiguous action/target while an unrelated team form still submits", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const observe = vi.fn();
    vi.spyOn(routerApi, "UNSAFE_decodeViaTurboStream").mockResolvedValue({
      value: { data: { outcome: "not-recorded", code: "validation-failed" } },
    } as never);
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic lost response"))
      .mockResolvedValueOnce(Response.json({ outcome: "indeterminate", code: "INDETERMINATE" }))
      .mockResolvedValueOnce(Response.json({ outcome: "not-recorded", code: "validation-failed" }, { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    function DuplicateRevoke() {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          <Button type="button" onClick={() => setMounted((value) => !value)}>
            Toggle duplicate
          </Button>
          {mounted ? (
            <AccountMutationForm method="post">
              <HiddenInput name="intent" value="revoke" />
              <HiddenInput name="membershipId" value="mbr_test" />
              <Button type="submit">Duplicate revoke</Button>
            </AccountMutationForm>
          ) : null}
        </>
      );
    }
    const router = createMemoryRouter(
      [
        {
          path: "/account/team",
          element: (
            <AccountMutationBoundary
              actor={{ tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" }}
              onRecoveryDescriptor={observe}
            >
              <AccountMutationForm method="post">
                <HiddenInput name="intent" value="revoke" />
                <HiddenInput name="membershipId" value="mbr_test" />
                <Button type="submit">Revoke</Button>
              </AccountMutationForm>
              <DuplicateRevoke />
              <AccountMutationForm method="post">
                <HiddenInput name="intent" value="create-invitation" />
                <TextInput name="email" label="Email" defaultValue="synthetic@example.test" />
                <Button type="submit">Invite</Button>
              </AccountMutationForm>
            </AccountMutationBoundary>
          ),
        },
      ],
      { initialEntries: ["/account/team"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Revoke$/ }).matches(":disabled")).toBe(false));
    fireEvent.submit(screen.getByRole("button", { name: /^Revoke$/ }).closest("form")!);
    await screen.findByText("We could not confirm the result. Do not repeat this action yet.");
    const retained = observe.mock.calls.at(-1)?.[0];
    expect(retained).toMatchObject({ action: "revoke", target: "mbr_test" });
    expect(screen.getByRole("button", { name: /^Revoke$/ }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Invite" }).matches(":disabled")).toBe(false);
    fireEvent.submit(screen.getByRole("button", { name: "Invite" }).closest("form")!);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "GET", "POST"]);
    expect(screen.getByRole("button", { name: "Duplicate revoke" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /^Revoke$/ }).matches(":disabled")).toBe(true);
    await waitFor(() => expect(observe.mock.calls.at(-1)?.[0]).toEqual(retained));
    fireEvent.click(screen.getByRole("button", { name: "Toggle duplicate" }));
    expect(screen.queryByRole("button", { name: "Duplicate revoke" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle duplicate" }));
    expect(screen.getByRole("button", { name: "Duplicate revoke" }).matches(":disabled")).toBe(true);
  });
  it("preserves entered fields across submitting/confirming/failed-safe and performs no second write", async () => {
    vi.stubGlobal("crypto", webcrypto);
    let loseResponse!: () => void;
    const pending = new Promise<Response>((_resolve, reject) => {
      loseResponse = () => reject(new TypeError("synthetic lost response"));
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json({ outcome: "not-recorded", code: "not-recorded" }));
    vi.stubGlobal("fetch", fetch);
    renderAccountManagementPage(
      <AccountMutationForm method="post">
        <HiddenInput name="intent" value="update-profile" />
        <TextInput name="name" label="Name" defaultValue="Old" />
        <Button type="submit">Save</Button>
      </AccountMutationForm>,
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "User work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    try {
      await screen.findByText("Saving your change");
      expect(screen.getByRole("button", { name: "Save" }).matches(":disabled")).toBe(false);
      expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-busy")).toBe("true");
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("User work");
      fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
      expect(fetch).toHaveBeenCalledTimes(1);
      loseResponse();
      await screen.findByText("No change was recorded. Review and submit again.");
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("User work");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(["POST", "GET"]);
    } finally {
      loseResponse();
    }
  });
});
describe("issue-7125 boundary lock", () => {
  const actor = { tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" };
  const refusal = "Another account change is in progress. Wait for it to finish before trying again.";
  const reauth = "Sign in again to check this action's result.";
  function Rows({ phase = "initial" }: { phase?: string }) {
    return (
      <>
        <span data-testid="route-phase">{phase}</span>
        {["A", "B"].map((name) => (
          <AccountMutationForm key={name} method="post">
            <HiddenInput name="intent" value="default" />
            <HiddenInput name="shippingAddressId" value={`adr_${name}`} />
            <Button type="submit">{name}</Button>
          </AccountMutationForm>
        ))}
      </>
    );
  }
  const button = (name: string) => screen.getByRole("button", { name });
  const controllerStatus = () => screen.getAllByRole("status").find((region) => region.tabIndex === -1)!;
  it("sibling activation refusal is announced", async () => {
    const transport = stubHeldAccountManagementTransport();
    const { loads } = renderHeldAccountManagementRoute("/account/shipping-addresses", null, () => <Rows />);
    await waitFor(() => expect(button("A").matches(":disabled")).toBe(false));

    fireEvent.click(button("A"));
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    fireEvent.click(button("A"));
    expect(screen.queryByText(refusal)).toBeNull();
    button("B").focus();
    fireEvent.click(button("B"));
    const inFlight = await screen.findByText(refusal);
    expect(controllerStatus().contains(inFlight)).toBe(true);
    expect(transport.posts()).toHaveLength(1);
    expect(button("B").matches(":disabled")).toBe(false);
    expect(button("B").getAttribute("aria-busy")).toBeNull();
    expect(button("A").getAttribute("aria-busy")).toBe("true");

    transport.posts()[0].respond(syntheticMutationResult("default", actor, { target: "adr_A" }));
    await waitFor(() => expect(loads).toHaveLength(1));
    fireEvent.click(button("B"));
    await waitFor(() => expect(screen.getByText(refusal)).not.toBe(inFlight));
    expect(transport.posts()).toHaveLength(1);
    expect(button("B").getAttribute("aria-busy")).toBeNull();
    loads[0](null);
    await waitFor(() => expect(screen.queryByText(refusal)).toBeNull());
    expect(button("A").getAttribute("aria-busy")).toBeNull();

    fireEvent.click(button("B"));
    await waitFor(() => expect(transport.posts()).toHaveLength(2));
    transport.posts()[1].respond(null, 401);
    await waitFor(() => expect(button("B").matches(":disabled")).toBe(true));
    button("A").focus();
    fireEvent.click(button("A"));
    expect(document.activeElement).toBe(controllerStatus());
    expect(controllerStatus().textContent).toContain(reauth);
    expect(screen.queryByText(refusal)).toBeNull();
    expect(screen.queryByText("Saving your change")).toBeNull();
    expect(transport.posts()).toHaveLength(2);
    expect(button("A").matches(":disabled")).toBe(false);
    expect(button("A").getAttribute("aria-busy")).toBeNull();
  });
  it("releases the boundary lock only after the revalidated route commit", async () => {
    const transport = stubHeldAccountManagementTransport();
    const { loads, router } = renderHeldAccountManagementRoute(
      "/account/shipping-addresses",
      { phase: "before" },
      ({ phase }) => <Rows phase={phase} />,
    );
    await waitFor(() => expect(button("A").matches(":disabled")).toBe(false));

    fireEvent.click(button("A"));
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    transport.posts()[0].respond(syntheticMutationResult("default", actor, { target: "adr_A" }));
    await waitFor(() => expect(loads).toHaveLength(1));
    expect(button("A").getAttribute("aria-busy")).toBe("true");
    expect(button("B").getAttribute("aria-busy")).toBeNull();

    const states: { phase: string; busy: string | null }[] = [];
    let staleUnlocked = false;
    const observer = new MutationObserver(() => {
      const phase = screen.getByTestId("route-phase").textContent ?? "";
      const state = { phase, busy: button("A").getAttribute("aria-busy") };
      states.push(state);
      if (phase === "before" && state.busy === null) staleUnlocked = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    loads[0]({ phase: "after" });
    await settleAccountManagementRoute(router, () => button("A").getAttribute("aria-busy") === null);
    expect(button("A").getAttribute("aria-busy")).toBeNull();
    observer.disconnect();
    expect(screen.getByTestId("route-phase").textContent).toBe("after");
    expect(staleUnlocked).toBe(false);
    expect(states.some(({ phase, busy }) => phase === "before" && busy === null)).toBe(false);
  });
  it("keeps the boundary lock through a batched revalidation commit", async () => {
    const transport = stubHeldAccountManagementTransport();
    let loads = 0;
    function BatchedRows() {
      const { phase } = useLoaderData() as { phase: string };
      return <Rows phase={phase} />;
    }
    const router = createMemoryRouter(
      [
        {
          id: "page",
          path: "/account/shipping-addresses",
          loader: () => {
            loads += 1;
            return { phase: "after" };
          },
          element: (
            <AccountMutationBoundary actor={actor}>
              <BatchedRows />
            </AccountMutationBoundary>
          ),
        },
      ],
      {
        initialEntries: ["/account/shipping-addresses"],
        hydrationData: { loaderData: { page: { phase: "before" } } },
      },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(button("A").matches(":disabled")).toBe(false));

    fireEvent.click(button("A"));
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    transport.posts()[0].respond(syntheticMutationResult("default", actor, { target: "adr_A" }));

    const states: { phase: string; busy: string | null }[] = [];
    let staleUnlocked = false;
    const observer = new MutationObserver(() => {
      const phase = screen.getByTestId("route-phase").textContent ?? "";
      const state = { phase, busy: button("A").getAttribute("aria-busy") };
      states.push(state);
      if (phase === "before" && state.busy === null) staleUnlocked = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    await waitFor(() => expect(loads).toBe(1));
    await settleAccountManagementRoute(router, () => button("A").getAttribute("aria-busy") === null);
    expect(button("A").getAttribute("aria-busy")).toBeNull();
    observer.disconnect();

    expect(screen.getByTestId("route-phase").textContent).toBe("after");
    expect(staleUnlocked).toBe(false);
    expect(states.some(({ phase, busy }) => phase === "before" && busy === null)).toBe(false);
    expect(transport.posts()).toHaveLength(1);
  });
  it("superseded flight releases the boundary lock", async () => {
    const transport = stubHeldAccountManagementTransport();
    function Switcher() {
      const [accountId, setAccountId] = useState(actor.accountId);
      return (
        <>
          <Button type="button" onClick={() => setAccountId("acc_other")}>
            Switch account
          </Button>
          <AccountMutationBoundary actor={{ ...actor, accountId }}>
            <Rows />
          </AccountMutationBoundary>
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/account/shipping-addresses", element: <Switcher /> }], {
      initialEntries: ["/account/shipping-addresses"],
    });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(button("A").matches(":disabled")).toBe(false));
    fireEvent.click(button("A"));
    await waitFor(() => expect(transport.posts()).toHaveLength(1));
    expect(button("A").getAttribute("aria-busy")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => expect(button("A").getAttribute("aria-busy")).toBeNull());
    transport.posts()[0].respond(syntheticMutationResult("default", actor, { target: "adr_A" }));
    fireEvent.click(button("B"));
    await waitFor(() => expect(transport.posts()).toHaveLength(2));
    expect(screen.queryByText(refusal)).toBeNull();
    expect(button("B").getAttribute("aria-busy")).toBe("true");
  });
});
