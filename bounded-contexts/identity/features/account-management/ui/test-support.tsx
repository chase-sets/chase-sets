import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { AccountMutationBoundary } from "./controller";

export function accountManagementTestElement(ui: ReactNode, path = "/account") {
  const router = createMemoryRouter(
    [
      {
        path,
        element: (
          <AccountMutationBoundary actor={{ tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" }}>
            {ui}
          </AccountMutationBoundary>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  return <RouterProvider router={router} />;
}

export const renderAccountManagementPage = (ui: ReactNode, path = "/account") =>
  render(accountManagementTestElement(ui, path));
export const renderAccountManagementPageToString = (ui: ReactNode) => renderToString(accountManagementTestElement(ui));
