import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AgreementListPage } from "./agreement-list-page";

describe("agreement list page", () => {
  it("clearly validates typed account ids before agreement submission", () => {
    const markup = renderToString(<AgreementListPage items={[]} />);

    expect(markup).toContain('name="accountId"');
    expect(markup).toContain('pattern="acc_.*"');
    expect(markup).toContain("Enter the exact account ID beginning with acc_.");
    expect(markup).toContain("Account ID must start with acc_.");
  });
});
