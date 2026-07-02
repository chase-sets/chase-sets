import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AgreementAccountCreatePage } from "./agreement-account-create-page";
import { AgreementCreateFields } from "./agreement-create-fields";
import { AgreementListPage } from "./agreement-list-page";

describe("agreement list page", () => {
  it("clearly validates typed account ids before agreement submission", () => {
    const markup = renderToString(<AgreementListPage items={[]} />);

    expect(markup).toContain('name="accountId"');
    expect(markup).toContain('pattern="acc_.*"');
    expect(markup).toContain("Enter the exact account ID beginning with acc_.");
    expect(markup).toContain("Account ID must start with acc_.");
  });

  it("can render creation fields with account id hidden from account route context", () => {
    const markup = renderToString(<AgreementCreateFields accountId="acc_route" />);

    expect(markup).toContain('type="hidden"');
    expect(markup).toContain('name="accountId"');
    expect(markup).toContain('value="acc_route"');
    expect(markup).not.toContain("Enter the exact account ID beginning with acc_.");
  });

  it("renders the account-scoped create page without a typed account id field", () => {
    const markup = renderToString(<AgreementAccountCreatePage accountId="acc_route" />);

    expect(markup).toContain("Account: ");
    expect(markup).toContain("acc_route");
    expect(markup).toContain('type="hidden"');
    expect(markup).not.toContain('pattern="acc_.*"');
  });
});
