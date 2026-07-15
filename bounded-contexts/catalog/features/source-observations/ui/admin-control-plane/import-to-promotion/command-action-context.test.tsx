// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../primary-workbench-route-context";
import {
  CatalogIntegrationCommandActionProvider,
  useCatalogIntegrationCommandHref,
  useCatalogIntegrationSurfaceHref,
} from "./command-action-context";

afterEach(cleanup);

function Probe() {
  const context = parseCatalogPrimaryWorkbenchRouteContext(
    "https://admin.example/catalog/integrations?languageCode=en&expansionId=scope_expansion_paldean_fates&jobId=sync_1",
  );
  const href = useCatalogIntegrationCommandHref(context);
  return <form action={href} data-testid="command-form" />;
}

function ReviewPagerProbe() {
  const context = parseCatalogPrimaryWorkbenchRouteContext(
    "https://admin.example/catalog/integrations?languageCode=en&scopeRecordId=scope_expansion_paldean_fates&reviewOffset=25",
  );
  const href = useCatalogIntegrationSurfaceHref(context, "source-observation-review");
  return <a href={href} data-testid="review-page" />;
}

describe("Catalog integration command action context", () => {
  it("uses the daily integrations action by default", () => {
    const { getByTestId } = render(<Probe />);
    const action = new URL((getByTestId("command-form") as HTMLFormElement).action);

    expect(action.pathname).toBe("/catalog/integrations");
    expect(action.searchParams.get("jobId")).toBe("sync_1");
  });

  it("keeps commands on the supplied Scope Detail path while preserving context", () => {
    const { getByTestId } = render(
      <CatalogIntegrationCommandActionProvider actionPath="/catalog/scopes/scope_expansion_paldean_fates">
        <Probe />
      </CatalogIntegrationCommandActionProvider>,
    );
    const action = new URL((getByTestId("command-form") as HTMLFormElement).action);

    expect(action.pathname).toBe("/catalog/scopes/scope_expansion_paldean_fates");
    expect(action.searchParams.get("expansionId")).toBe("scope_expansion_paldean_fates");
    expect(action.searchParams.get("jobId")).toBe("sync_1");
  });

  it("keeps review pagination on its section and the supplied Scope Detail path", () => {
    const { getByTestId } = render(
      <CatalogIntegrationCommandActionProvider actionPath="/catalog/scopes/scope_expansion_paldean_fates">
        <ReviewPagerProbe />
      </CatalogIntegrationCommandActionProvider>,
    );
    const href = new URL((getByTestId("review-page") as HTMLAnchorElement).href);

    expect(href.pathname).toBe("/catalog/scopes/scope_expansion_paldean_fates");
    expect(href.searchParams.get("section")).toBe("source-observation-review");
    expect(href.searchParams.get("reviewOffset")).toBe("25");
    expect(href.searchParams.get("scopeRecordId")).toBe("scope_expansion_paldean_fates");
  });
});
