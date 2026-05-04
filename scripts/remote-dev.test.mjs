import { describe, expect, it } from "vitest";
import {
  buildCaddyfile,
  buildCreatePlan,
  buildDestroyPlan,
  createSessionSlug,
  createSessionTags,
  normalizeDomain,
  parseArgs,
  resolveDnsRecordNames,
  resolveExpiresAt,
  resolveSessionUrls,
  sanitizeSlugPart,
  selectExpiredSessions,
  toSshRepoUrl,
} from "./remote-dev.mjs";

describe("remote-dev planning helpers", () => {
  it("creates stable, DNS-safe session slugs", () => {
    expect(sanitizeSlugPart("Feature/Add Stripe Webhooks!")).toBe("feature-add-stripe-webhooks");
    expect(createSessionSlug({ branch: "feature/Remote DO", sha: "abcdef123456", random: "z9y8x7" }))
      .toBe("feature-remote-do-abcdef12-z9y8x7");
  });

  it("normalizes domains and service URLs", () => {
    expect(normalizeDomain("https://Dev.Example.com/path")).toBe("dev.example.com");
    expect(resolveSessionUrls("abc", "dev.example.com")).toMatchObject({
      portal: "https://portal.abc.dev.example.com",
      marketplace: "https://marketplace.abc.dev.example.com",
      admin: "https://admin.abc.dev.example.com",
      api: "https://api.abc.dev.example.com",
    });
  });

  it("resolves TTLs and expiration tags", () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    const expiresAt = resolveExpiresAt(now, 48);
    expect(expiresAt.toISOString()).toBe("2026-05-05T12:00:00.000Z");
    expect(createSessionTags({ slug: "abc", branch: "main", expiresAt })).toContain("rd-exp:1777982400");
  });

  it("resolves DNS record names inside an apex zone", () => {
    expect(resolveDnsRecordNames("smoke-test", "dev.chasesets.com", "chasesets.com")).toEqual({
      root: "smoke-test.dev",
      wildcard: "*.smoke-test.dev",
    });
    expect(resolveDnsRecordNames("smoke-test", "dev.chasesets.com")).toEqual({
      root: "smoke-test",
      wildcard: "*.smoke-test",
    });
  });

  it("builds create plans with DigitalOcean droplet, firewall, and DNS commands", () => {
    const plan = buildCreatePlan({
      slug: "main-fedefa2-x1y2z3",
      branch: "main",
      expiresAt: new Date("2026-05-05T12:00:00.000Z"),
      region: "nyc3",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      domain: "dev.example.com",
      dnsZone: "example.com",
      sshKeyId: "12345",
      userDataPath: "/tmp/cloud-init.yml",
      publicIpPlaceholder: "203.0.113.10",
    });

    expect(plan.map((step) => step.label)).toEqual([
      "Create remote-dev base tag",
      "Create session tag rd-slug:main-fedefa2-x1y2z3",
      "Create session tag rd-exp:1777982400",
      "Create session tag rd-branch:main",
      "Create cloud firewall",
      "Create Droplet",
      "Create root DNS record",
      "Create wildcard DNS record",
    ]);
    expect(plan.find((step) => step.label === "Create Droplet").args).toContain("ubuntu-24-04-x64");
    expect(plan.at(-2).args).toContain("main-fedefa2-x1y2z3.dev");
    expect(plan.at(-1).args).toContain("*.main-fedefa2-x1y2z3.dev");
  });

  it("builds destroy plans for droplet, DNS, firewall, and session tag cleanup", () => {
    const plan = buildDestroyPlan({
      slug: "abc",
      domain: "dev.example.com",
      dnsZone: "example.com",
      dropletId: 101,
      dnsRecordIds: [201, 202],
      firewallId: "fw-1",
    });

    expect(plan.map((step) => step.command)).toEqual(["doctl", "doctl", "doctl", "doctl", "doctl"]);
    expect(plan[0].args).toEqual(["compute", "droplet", "delete", "101", "--force"]);
    expect(plan[1].args).toContain("201");
    expect(plan[1].args).toContain("example.com");
    expect(plan[3].args).toContain("fw-1");
  });

  it("selects expired sessions from canonical DigitalOcean tags", () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    expect(selectExpiredSessions([
      { slug: "old", tags: ["rd-exp:1"] },
      { slug: "future", tags: ["rd-exp:2777982400"] },
      { slug: "untagged", tags: [] },
    ], now).map((session) => session.slug)).toEqual(["old"]);
  });

  it("generates Caddy config with Basic Auth and unauthenticated webhook routes", () => {
    const caddyfile = buildCaddyfile({
      slug: "abc",
      domain: "dev.example.com",
      basicAuthUser: "dev",
      basicAuthHash: "$2a$14$example",
    });

    expect(caddyfile).toContain("marketplace.abc.dev.example.com");
    expect(caddyfile).toContain("basicauth");
    expect(caddyfile).toContain("@webhook1 path /api/payments/provider/webhooks");
    expect(caddyfile).toContain("reverse_proxy @webhook2 127.0.0.1:6182");
  });

  it("parses command flags and converts GitHub remotes to SSH URLs", () => {
    expect(parseArgs(["create", "--name", "demo", "--dry-run"])).toEqual({
      command: "create",
      positionals: [],
      flags: { name: "demo", "dry-run": true },
    });
    expect(toSshRepoUrl("https://github.com/todd-skelton/chase-sets.git"))
      .toBe("git@github.com:todd-skelton/chase-sets.git");
  });
});
