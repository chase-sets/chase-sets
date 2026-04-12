import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveAdminWebNavItems } from "../host";

describe("admin route layout navigation", () => {
  it("prefixes catalog navigation under the catalog section", () => {
    expect(
      resolveAdminWebNavItems({ permissions: [] }, {
        section: "catalog",
      }).map((item) => item.href),
    ).toContain("/catalog/dimensions");
  });

  it("prefixes identity navigation under the identity section", () => {
    expect(
      resolveAdminWebNavItems({ permissions: [] }, {
        section: "identity",
      }).map((item) => item.href),
    ).toContain("/identity/accounts");
  });

  it("renders a lightweight admin shell fragment for smoke coverage", () => {
    const html = renderToString(
        <div>
        {resolveAdminWebNavItems({ permissions: [] }, {
          section: "catalog",
        }).map((item) => (
          <a key={item.key} href={item.href}>
            {item.label}
          </a>
        ))}
      </div>,
    );

    expect(html).toContain("/catalog/dimensions");
  });
});
