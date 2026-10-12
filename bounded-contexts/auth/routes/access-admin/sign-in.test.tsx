// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import AccessAdminSignInRoute, { action } from "./sign-in";

const marker = "Bearer synthetic-admin-social-token-marker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderRoute(code: string) {
  const router = createMemoryRouter([{ path: "/sign-in", Component: AccessAdminSignInRoute, action }], {
    initialEntries: [`/sign-in?socialLoginError=${encodeURIComponent(code)}`],
  });
  render(<RouterProvider router={router} />);
  return router;
}

it.each([
  ["workspace_domain_required", "auth.support.apiSupport.socialLoginRoutes.admin.workspace.domain.required"],
  [marker, "auth.support.apiSupport.socialLoginRoutes.state.invalid"],
] as const)("localizes the admin social destination for %s without raw query copy", (code, key) => {
  renderRoute(code);
  expect(screen.getByText(t(key))).toBeTruthy();
  expect(document.body.textContent).not.toContain(marker);
});

it("keeps admin action errors ahead of social destination copy", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: marker }, { status: 401 })));
  const router = renderRoute("workspace_domain_required");
  const formData = new FormData();
  formData.set("intent", "password");
  formData.set("email", "admin@example.test");
  formData.set("password", "synthetic-password");
  await act(() =>
    router.navigate("/sign-in?socialLoginError=workspace_domain_required", { formMethod: "post", formData }),
  );
  expect(screen.getByText(t("auth.support.apiSupport.passwordRoutes.invalid.email.or.password"))).toBeTruthy();
  expect(screen.queryByText(t("auth.support.apiSupport.socialLoginRoutes.admin.workspace.domain.required"))).toBeNull();
  expect(document.body.textContent).not.toContain(marker);
});
