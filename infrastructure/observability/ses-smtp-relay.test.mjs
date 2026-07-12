import { describe, expect, it } from "vitest";
import { buildSesRequest, parseEmailList, parseGrafanaMessage, signSesRequest } from "./stack/ses-smtp-relay.mjs";

describe("SES SMTP relay", () => {
  it("keeps recipients on the configured allowlist", () => {
    expect([...parseEmailList("ops@example.com; alerts@example.com")]).toEqual([
      "ops@example.com",
      "alerts@example.com",
    ]);
  });

  it("converts Grafana mail to the least-privilege SES SendEmail shape", () => {
    expect(parseGrafanaMessage("Subject: [FIRING] staging\r\nContent-Type: text/plain\r\n\r\nalert body")).toEqual({
      subject: "[FIRING] staging",
      body: "alert body",
    });
    expect(
      buildSesRequest({
        fromAddress: "notifications@example.com",
        sourceArn: "arn:aws:ses:us-east-2:123456789012:identity/example.com",
        configurationSetName: "transactional-production",
        recipients: ["ops@example.com"],
        rawMessage: "Subject: Staging alert\r\n\r\nbody",
      }),
    ).toMatchObject({
      FromEmailAddress: "notifications@example.com",
      FromEmailAddressIdentityArn: "arn:aws:ses:us-east-2:123456789012:identity/example.com",
      ConfigurationSetName: "transactional-production",
      Destination: { ToAddresses: ["ops@example.com"] },
      Content: { Simple: { Subject: { Data: "Staging alert" }, Body: { Text: { Data: "body" } } } },
    });
  });

  it("signs the SES v2 SendEmail endpoint without exposing credentials in the payload", () => {
    const request = signSesRequest({
      accessKeyId: "example-access-key",
      secretAccessKey: "example-secret-key",
      region: "us-east-2",
      payload: { test: true },
      now: new Date("2026-07-12T12:00:00Z"),
    });
    expect(request.url).toBe("https://email.us-east-2.amazonaws.com/v2/email/outbound-emails");
    expect(request.headers.authorization).toContain(
      "Credential=example-access-key/20260712/us-east-2/ses/aws4_request",
    );
    expect(request.body).not.toContain("example-secret-key");
  });
});
