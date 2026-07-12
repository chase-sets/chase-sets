import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:net";

const maxMessageBytes = 512 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

export function parseEmailList(value) {
  return new Set(
    String(value ?? "")
      .split(/[;,]/u)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function parseGrafanaMessage(rawMessage) {
  const normalized = String(rawMessage).replaceAll("\r\n", "\n");
  const separator = normalized.indexOf("\n\n");
  const headerBlock = separator >= 0 ? normalized.slice(0, separator) : "";
  const body = separator >= 0 ? normalized.slice(separator + 2) : normalized;
  const unfoldedHeaders = headerBlock.replace(/\n[ \t]+/gu, " ").split("\n");
  const subjectHeader = unfoldedHeaders.find((line) => line.toLowerCase().startsWith("subject:"));
  const subject = subjectHeader?.slice(subjectHeader.indexOf(":") + 1).trim() || "Chase Sets observability alert";

  return {
    subject: subject.slice(0, 200),
    body: body.slice(0, 200_000),
  };
}

export function buildSesRequest({ fromAddress, sourceArn, configurationSetName, recipients, rawMessage }) {
  const message = parseGrafanaMessage(rawMessage);
  return {
    FromEmailAddress: fromAddress,
    FromEmailAddressIdentityArn: sourceArn,
    ConfigurationSetName: configurationSetName,
    Destination: { ToAddresses: recipients },
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: { Text: { Data: message.body, Charset: "UTF-8" } },
      },
    },
  };
}

export function signSesRequest({ accessKeyId, secretAccessKey, region, payload, now = new Date() }) {
  const service = "ses";
  const host = `email.${region}.amazonaws.com`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadText = JSON.stringify(payload);
  const payloadHash = sha256(payloadText);
  const canonicalHeaders = [
    "content-type:application/json",
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["POST", "/v2/email/outbound-emails", "", canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");

  return {
    url: `https://${host}/v2/email/outbound-emails`,
    body: payloadText,
    headers: {
      "content-type": "application/json",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

async function sendWithSes(config, recipients, rawMessage) {
  const payload = buildSesRequest({
    fromAddress: config.fromAddress,
    sourceArn: config.sourceArn,
    configurationSetName: config.configurationSetName,
    recipients,
    rawMessage,
  });
  const request = signSesRequest({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    payload,
  });
  const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
  if (!response.ok) {
    const errorType = response.headers.get("x-amzn-errortype")?.split(":", 1)[0] || "unknown";
    throw new Error(`SES SendEmail failed with HTTP ${response.status} type=${errorType}.`);
  }
}

export function createSmtpRelay(config) {
  return createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 chase-sets-observability ESMTP\r\n");
    let buffer = "";
    let collectingData = false;
    let message = "";
    let recipients = [];

    const reset = () => {
      collectingData = false;
      message = "";
      recipients = [];
    };

    const processCommand = async (line) => {
      if (collectingData) {
        if (line === ".") {
          collectingData = false;
          try {
            if (Buffer.byteLength(message, "utf8") > maxMessageBytes) {
              throw new Error("Message exceeds relay size limit.");
            }
            if (recipients.length === 0) {
              throw new Error("No accepted recipients.");
            }
            await sendWithSes(config, recipients, message.replace(/^\.\./gmu, "."));
            console.log(`SES alert accepted environment=${config.environment} recipient_count=${recipients.length}`);
            socket.write("250 2.0.0 accepted\r\n");
          } catch (error) {
            console.error(`SES alert rejected environment=${config.environment} reason=${error.message}`);
            socket.write("451 4.3.0 delivery failed\r\n");
          } finally {
            reset();
          }
          return;
        }
        message += `${line}\r\n`;
        if (Buffer.byteLength(message, "utf8") > maxMessageBytes) {
          socket.write("552 5.3.4 message too large\r\n");
          reset();
        }
        return;
      }

      const command = line.toUpperCase();
      if (command.startsWith("EHLO") || command.startsWith("HELO")) {
        socket.write(`250-${config.hostname}\r\n250 SIZE ${maxMessageBytes}\r\n`);
      } else if (command.startsWith("MAIL FROM:")) {
        reset();
        socket.write("250 2.1.0 ok\r\n");
      } else if (command.startsWith("RCPT TO:")) {
        const match = /<([^>]+)>/u.exec(line);
        const recipient = match?.[1]?.trim().toLowerCase();
        if (!recipient || !config.allowedRecipients.has(recipient)) {
          socket.write("550 5.7.1 recipient not allowed\r\n");
        } else {
          recipients.push(recipient);
          socket.write("250 2.1.5 ok\r\n");
        }
      } else if (command === "DATA") {
        collectingData = true;
        message = "";
        socket.write("354 end with <CRLF>.<CRLF>\r\n");
      } else if (command === "RSET") {
        reset();
        socket.write("250 2.0.0 reset\r\n");
      } else if (command === "NOOP") {
        socket.write("250 2.0.0 ok\r\n");
      } else if (command === "QUIT") {
        socket.end("221 2.0.0 bye\r\n");
      } else {
        socket.write("502 5.5.2 unsupported command\r\n");
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      lines
        .reduce((pending, line) => pending.then(() => processCommand(line)), Promise.resolve())
        .catch(() => {
          socket.destroy();
        });
    });
  });
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = {
    hostname: "ses-alert-relay",
    environment: "shared",
    accessKeyId: requiredEnv("SES_AWS_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("SES_AWS_SECRET_ACCESS_KEY"),
    region: requiredEnv("SES_AWS_REGION"),
    fromAddress: requiredEnv("GRAFANA_SMTP_FROM_ADDRESS"),
    sourceArn: requiredEnv("SES_SOURCE_ARN"),
    configurationSetName: requiredEnv("SES_CONFIGURATION_SET_NAME"),
    allowedRecipients: parseEmailList(requiredEnv("OBSERVABILITY_ALERT_EMAILS")),
  };
  createSmtpRelay(config).listen(2525, "0.0.0.0", () => {
    console.log("SES alert relay listening port=2525");
  });
}
