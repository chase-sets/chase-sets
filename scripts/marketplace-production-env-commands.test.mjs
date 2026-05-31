import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_PRODUCTION_ENV_COMMANDS_VERSION,
  buildProductionEnvCommands,
  parseProductionEnvCommandsArgs,
} from "./marketplace-production-env-commands.mjs";

function productionEnvironment(overrides = {}) {
  return {
    PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "true",
    PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
    PRODUCTION_MARKETPLACE_PROMOTION_APPROVED: "true",
    PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: "LAUNCH-REVIEW-2026-05-30",
    PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED: "true",
    PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE: "PAYMENTS-FEE-2026-05-30",
    PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED: "true",
    PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE: "STRIPE-MONEY-2026-05-30",
    PRODUCTION_SUPPORT_OPERATIONS_APPROVED: "true",
    PRODUCTION_SUPPORT_OPERATIONS_REFERENCE: "SUPPORT-OPS-2026-05-30",
    PRODUCTION_FULFILLMENT_POSTAGE_APPROVED: "true",
    PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE: "FULFILLMENT-POSTAGE-2026-05-30",
    PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED: "true",
    PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE: "NOTIFICATIONS-SES-2026-05-30",
    PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED: "true",
    PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE: "CATALOG-MEASURES-2026-05-30",
    PRODUCTION_TAX_READINESS_APPROVED: "true",
    PRODUCTION_TAX_READINESS_REFERENCE: "TAX-READINESS-2026-05-30",
    TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "false",
    EASYPOST_MODE: "production",
    ...overrides,
  };
}

describe("marketplace production environment commands", () => {
  it("builds deterministic GitHub variable commands from productionEnvironment", () => {
    const result = buildProductionEnvCommands({
      productionEnvironment: productionEnvironment({
        PRODUCTION_MARKETPLACE_PROOF_ENABLED: "false",
        PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "",
      }),
      environmentName: "production",
    });

    expect(result.schemaVersion).toBe(MARKETPLACE_PRODUCTION_ENV_COMMANDS_VERSION);
    expect(result.passesProductionEnvCommandsGate).toBe(true);
    expect(result.commands[0]).toBe(
      'gh variable set PRODUCTION_MARKETPLACE_PUBLIC_ENABLED --env "production" --body "true"',
    );
    expect(result.commands[1]).toBe(
      'gh variable set PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE --env "production" --body "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30"',
    );
    expect(result.commands).toContain(
      'gh variable set PRODUCTION_TAX_READINESS_REFERENCE --env "production" --body "TAX-READINESS-2026-05-30"',
    );
    expect(result.commands).toContain('gh variable set EASYPOST_MODE --env "production" --body "production"');
    expect(result.commands).toContain(
      'gh variable set PRODUCTION_MARKETPLACE_PROOF_ENABLED --env "production" --body "false"',
    );
    expect(result.commands.some((command) => command.includes("PRODUCTION_MARKETPLACE_PROOF_REFERENCE"))).toBe(false);
    expect(result.commandCount).toBe(result.commands.length);
  });

  it("escapes quoted values for PowerShell command output", () => {
    const result = buildProductionEnvCommands({
      productionEnvironment: productionEnvironment({
        PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: 'LAUNCH "REVIEW"',
      }),
      environmentName: 'prod "blue"',
    });

    expect(result.commands).toContain(
      'gh variable set PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE --env "prod `"blue`"" --body "LAUNCH `"REVIEW`""',
    );
  });

  it("parses packet path and environment from flags or environment", () => {
    expect(parseProductionEnvCommandsArgs(["--file", "packet.json", "--environment", "production"], {})).toMatchObject({
      packetPath: "packet.json",
      environmentName: "production",
    });

    expect(
      parseProductionEnvCommandsArgs([], {
        MARKETPLACE_LAUNCH_EVIDENCE_PACKET: "secure/packet.json",
        GITHUB_ENVIRONMENT_NAME: "production",
      }),
    ).toMatchObject({
      packetPath: "secure/packet.json",
      environmentName: "production",
    });
  });
});
