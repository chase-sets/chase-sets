import { describe, expect, it } from "vitest";
import { disablePreventDestroyInTerraformContent } from "./disable-terraform-prevent-destroy.mjs";

describe("disable-terraform-prevent-destroy", () => {
  it("removes prevent_destroy while preserving other lifecycle settings", () => {
    const result = disablePreventDestroyInTerraformContent(`resource "digitalocean_database_cluster" "postgres" {
  name = "preview-postgres"

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [storage_size_mib]
  }
}
`);

    expect(result.disabledCount).toBe(1);
    expect(result.content).not.toContain("prevent_destroy");
    expect(result.content).toContain("lifecycle {");
    expect(result.content).toContain("ignore_changes  = [storage_size_mib]");
  });

  it("removes lifecycle blocks left empty by disabling prevent_destroy", () => {
    const result = disablePreventDestroyInTerraformContent(`resource "digitalocean_database_cluster" "postgres" {
  name = "preview-postgres"

  lifecycle {
    prevent_destroy = true
  }
}
`);

    expect(result.disabledCount).toBe(1);
    expect(result.content).not.toContain("lifecycle");
    expect(result.content).not.toContain("prevent_destroy");
  });

  it("reports when no prevent_destroy setting exists", () => {
    const source = `resource "digitalocean_database_cluster" "postgres" {
  name = "preview-postgres"
}
`;

    const result = disablePreventDestroyInTerraformContent(source);

    expect(result.disabledCount).toBe(0);
    expect(result.content).toBe(source);
  });
});
