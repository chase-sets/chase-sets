// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import PressRoute, { loader } from "../routes/marketplace/press";
import {
  POLICY_VALUE_KEY_ATTRIBUTE,
  POLICY_VALUE_STATE_ATTRIBUTE,
  POLICY_VALUE_UNAVAILABLE_STATE,
  POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE,
  POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE,
  parsePolicyValueKeys,
} from "../features/help/domain/policy-value-state";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("press route policy values", () => {
  it.each([
    ["non-OK", "non-ok", 503, () => vi.fn(async () => new Response("unavailable", { status: 503 }))],
    ["network", "transport", undefined, () => vi.fn(async () => Promise.reject(new Error("network unavailable")))],
    [
      "missing-key",
      "missing",
      undefined,
      () =>
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                values: {},
                resolvedAt: "2026-07-12T00:00:00.000Z",
                propagationSeconds: 360,
                changeCalloutDays: 30,
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
        ),
    ],
  ])(
    "keeps the page available with explicit markers on a %s failure",
    async (_failure, classification, status, createFetch) => {
      vi.stubGlobal("fetch", createFetch());
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const data = await loader({ request: new Request("https://chasesets.test/press") } as never);
      const router = createMemoryRouter([{ path: "/press", loader: () => data, Component: PressRoute }], {
        initialEntries: ["/press"],
      });

      render(<RouterProvider router={router} />);

      expect((await screen.findAllByText("Temporarily unavailable")).length).toBeGreaterThan(0);
      expect(document.body.textContent).not.toContain("5% of the item price");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[public-presence] Public policy values are unavailable.", {
        event: "public-policy-values.unavailable",
        route: "/press",
        unresolvedKeys: [...data.article.policyValueKeys].sort(),
        classification,
        ...(status === undefined ? {} : { status }),
      });

      const expectedKeys = [...data.article.policyValueKeys].sort();
      const markers = [
        ...document.querySelectorAll(`[${POLICY_VALUE_STATE_ATTRIBUTE}="${POLICY_VALUE_UNAVAILABLE_STATE}"]`),
      ]
        .map((node) => node.getAttribute(POLICY_VALUE_KEY_ATTRIBUTE))
        .sort();
      expect(markers).toEqual(expectedKeys);
      const aggregate = document.querySelector(`[${POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE}]`);
      expect(
        [...parsePolicyValueKeys(aggregate!.getAttribute(POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE)!)].sort(),
      ).toEqual(expectedKeys);
    },
  );
});
