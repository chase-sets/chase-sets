import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { AccountMutationBoundary } from "./controller";

export function accountManagementTestElement(ui: ReactNode) {
  const router = createMemoryRouter(
    [
      {
        path: "/account",
        element: (
          <AccountMutationBoundary actor={{ tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" }}>
            {ui}
          </AccountMutationBoundary>
        ),
      },
    ],
    { initialEntries: ["/account"] },
  );
  return <RouterProvider router={router} />;
}

export const renderAccountManagementPage = (ui: ReactNode) => render(accountManagementTestElement(ui));
export const renderAccountManagementPageToString = (ui: ReactNode) => renderToString(accountManagementTestElement(ui));
