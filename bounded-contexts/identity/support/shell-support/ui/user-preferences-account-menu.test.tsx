// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { defaultUserPresentationPreferences } from "../../../features/preferences/domain/domain";
import { createIdentityApiClient, type IdentityApiClient } from "../api/client";
import { useUserPreferencesAccountMenu } from "./user-preferences-account-menu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Shell({
  userId = "usr_A",
  accountId = "acc_A",
  client,
}: {
  userId?: string;
  accountId?: string;
  client: IdentityApiClient;
}) {
  const state = useUserPreferencesAccountMenu("system", userId, client);
  return (
    <ChaseRoot colorMode={state.colorMode}>
      <output data-testid="phase">{state.phase}</output>
      <output data-testid="mode">{state.colorMode}</output>
      <span>{accountId}</span>
      {state.preferences}
    </ChaseRoot>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const preferences = (colorMode = "dark", userId = "usr_A") => ({
  userId,
  ...defaultUserPresentationPreferences,
  colorMode,
});
const success = () => Response.json({ preferences: preferences() });
const phase = (value: string) => waitFor(() => expect(screen.getByTestId("phase").textContent).toBe(value));

describe("User Preference Write Attempt recovery", () => {
  it.each([
    [400, null, "failed-safe"],
    [401, null, "reauthentication-required"],
    [403, null, "reauthentication-required"],
    [409, null, "conflict"],
    [503, 200, "succeeded"],
    [503, 409, "conflict"],
    [503, 401, "reauthentication-required"],
    [503, 403, "reauthentication-required"],
    [503, 503, "ambiguous"],
    [0, 200, "succeeded"],
    [0, 0, "ambiguous"],
  ] as const)(
    "preference-write-client-interruption-matrix PUT %s GET %s -> %s",
    async (putStatus, getStatus, expected) => {
      const calls: Request[] = [];
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        const status = request.method === "PUT" ? putStatus : getStatus;
        if (status === 0) throw new TypeError("response lost");
        if (request.method === "GET" && status === 409) return Response.json(preferences("light"));
        if (request.method === "GET" && status === 200) return Response.json(preferences());
        return Response.json({ preferences: preferences("light") }, { status: status ?? 500 });
      });
      const client = createIdentityApiClient({ baseUrl: "https://identity.test/api/identity", fetch });
      render(<Shell client={client} />);
      await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
      await phase(expected);
      expect(calls.map((request) => request.method)).toEqual(getStatus === null ? ["PUT"] : ["PUT", "GET"]);
      expect(calls[0].headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
      if (expected !== "succeeded") expect(screen.queryByRole("heading", { name: "Preferences saved" })).toBeNull();
      if (expected === "ambiguous") {
        await userEvent.click(screen.getByRole("button", { name: "Check again" }));
        await phase("ambiguous");
        expect(calls.map((request) => request.method)).toEqual(["PUT", "GET", "GET"]);
      }
    },
  );

  it("preference-write-client-interruption-matrix zero-fetch key failure and fresh explicit Save", async () => {
    const fetch = vi.fn(async () => success());
    const client = createIdentityApiClient({ baseUrl: "https://identity.test/api/identity", fetch });
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("no entropy");
    });
    render(<Shell client={client} />);
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    await phase("failed-safe");
    expect(fetch).not.toHaveBeenCalled();
    uuid.mockRestore();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await phase("succeeded");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preference-write-user-generation-day-after", async () => {
    const lost = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(lost.promise).mockResolvedValue(success());
    const client = createIdentityApiClient({ baseUrl: "https://identity.test/api/identity", fetch });
    const view = render(<Shell client={client} />);
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(<Shell client={client} accountId="acc_second" />);
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    await phase("submitting");
    view.rerender(<Shell client={client} userId="usr_B" />);
    await phase("editing");
    await act(async () => {
      lost.resolve(Response.json({}, { status: 503 }));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mode").textContent).toBe("system");
    expect(screen.queryByRole("heading", { name: "Preferences saved" })).toBeNull();
    view.unmount();
    render(<Shell client={client} userId="usr_B" />);
    await act(async () => {});
    await phase("editing");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("preference-write-user-generation-day-after same User Account switch retains ownership, not another write", async () => {
    const result = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(result.promise);
    const client = createIdentityApiClient({ baseUrl: "https://identity.test/api/identity", fetch });
    const view = render(<Shell client={client} />);
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    view.rerender(<Shell client={client} accountId="acc_second" />);
    await phase("submitting");
    await act(async () => {
      result.resolve(success());
    });
    await phase("succeeded");
    expect(fetch).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<Shell client={client} accountId="acc_second" />);
    await phase("editing");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
