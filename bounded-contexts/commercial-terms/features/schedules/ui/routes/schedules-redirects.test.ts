import type { LoaderFunctionArgs } from "react-router";
import { expect, it } from "vitest";
import { loader as schedulesRedirectLoader } from "../../../../routes/admin/schedules";
import { loader as scheduleRedirectLoader } from "../../../../routes/admin/schedules-detail";

it.each([
  ["/commerce/terms/schedules", "/commerce/terms/schedules", schedulesRedirectLoader, {}, "/commerce/terms"],
  [
    "/commerce/terms/schedules/cts_active",
    "/commerce/terms/schedules/:id",
    scheduleRedirectLoader,
    { id: "cts_active" },
    "/commerce/terms?schedule=cts_active",
  ],
] satisfies [string, string, typeof schedulesRedirectLoader, LoaderFunctionArgs["params"], string][])(
  "redirects the retired schedule route %s to the home query-state contract",
  async (path, pattern, loader, params, location) => {
    const url = new URL(path, "https://admin.chasesets.com");
    const response = await loader({
      request: new Request(url),
      url,
      pattern,
      params,
      context: undefined,
    });
    expect(response.headers.get("Location")).toBe(location);
  },
);
