import type { TransactionalEmailMessage, TransactionalEmailTemplateRenderer } from "@chase-sets/outbound-messaging";

export const platformEmailTemplateRenderer: TransactionalEmailTemplateRenderer = {
  render(message) {
    const bodyLines = renderPlatformEmailBodyLines(message);
    const textBody = [message.subject, "", ...bodyLines].join("\n");
    const htmlBody = renderBrandedHtmlEmail(message.subject, bodyLines);

    return {
      subject: message.subject,
      htmlBody,
      textBody,
    };
  },
};

function renderBrandedHtmlEmail(subject: string, bodyLines: readonly string[]) {
  const contentHtml = bodyLines
    .filter((line) => line.trim().length > 0 && line.trim() !== "Chase Sets")
    .map((line, index) => {
      const escaped = linkifyEscapedText(escapeHtml(line));
      const weight = index === 0 ? "600" : "400";
      const size = index === 0 ? "18px" : "15px";
      return `<p style="margin:0 0 16px 0;color:#26312b;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:${size};font-weight:${weight};line-height:1.55;">${escaped}</p>`;
    })
    .join("");

  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:0;background:#f4f6f2;color:#141a16;">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(subject)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f4f6f2;">',
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:640px;">',
    '<tr><td style="padding:0 0 14px 0;">',
    "<div style=\"font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:0;color:#101511;\">Chase Sets</div>",
    "<div style=\"margin-top:4px;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:13px;color:#5f6f65;\">Card marketplace updates</div>",
    "</td></tr>",
    '<tr><td style="background:#ffffff;border:1px solid #dde5dc;border-radius:8px;padding:32px;box-shadow:0 1px 2px rgba(20,26,22,0.06);">',
    '<div style="width:48px;height:4px;background:#22c55e;border-radius:999px;margin:0 0 22px 0;"></div>',
    `<h1 style="margin:0 0 20px 0;color:#101511;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:28px;font-weight:700;line-height:1.2;">${escapeHtml(subject)}</h1>`,
    contentHtml,
    "<div style=\"margin-top:24px;padding-top:20px;border-top:1px solid #e7ece6;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#26312b;\">Chase Sets</div>",
    "</td></tr>",
    "<tr><td style=\"padding:18px 2px 0 2px;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6d7a70;\">You received this email because of activity or consent on Chase Sets.</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("");
}

function renderPlatformEmailBodyLines(message: TransactionalEmailMessage): readonly string[] {
  if (message.templateId === "auth_magic_link") {
    return [
      "Use this secure link to sign in to Chase Sets:",
      String(message.templateData.magicLink ?? ""),
      "",
      "This link expires soon. If you did not request this email, you can ignore it.",
      "",
      "Chase Sets",
    ];
  }

  if (message.templateId === "auth_guest_checkout_claim_link") {
    return [
      "Use this secure link to save your guest checkout order to your Chase Sets account:",
      String(message.templateData.claimLink ?? ""),
      "",
      "This link expires soon. If you did not request this email, you can ignore it.",
      "",
      "Chase Sets",
    ];
  }

  if (message.templateId === "waitlist_signup_confirmation") {
    return [
      String(message.templateData.headline ?? "You are on the Chase Sets early access list."),
      String(
        message.templateData.intro ??
          "Thanks for requesting early access to a faster card marketplace with sharper pricing and cleaner workflows.",
      ),
      String(message.templateData.nextStep ?? "We will send launch updates and beta invites as access opens."),
      "",
      "Chase Sets",
    ];
  }

  if (message.templateId === "order_confirmed") {
    return [
      "Your Chase Sets order has been confirmed.",
      `Order reference: ${String(message.templateData.orderReference ?? "")}`,
      `Order total: ${String(message.templateData.orderTotal ?? "")}`,
      "",
      "Chase Sets",
    ];
  }

  if (message.templateId === "order_payment_deadline_cancelled") {
    return [
      "Your Chase Sets order was cancelled after the payment deadline passed.",
      `Order reference: ${String(message.templateData.orderReference ?? "")}`,
      `Reorder: ${String(message.templateData.reorderHref ?? "")}`,
      "",
      "Chase Sets",
    ];
  }

  if (message.templateId === "payment_captured") {
    return [
      "Your Chase Sets payment was received.",
      `Payment reference: ${String(message.templateData.paymentReference ?? "")}`,
      `Amount: ${String(message.templateData.amount ?? "")} ${String(message.templateData.currencyCode ?? "")}`,
      "",
      "Chase Sets",
    ];
  }

  if (message.templateId === "shipment_delivered") {
    return [
      "Your Chase Sets shipment has been delivered.",
      `Order ID: ${String(message.templateData.orderId ?? "")}`,
      `Tracking number: ${String(message.templateData.trackingNumber ?? "")}`,
      "",
      "Chase Sets",
    ];
  }

  const dataLines = Object.entries(message.templateData).map(([key, value]) => `${key}: ${String(value ?? "")}`);
  return ["A Chase Sets account update is available.", ...dataLines, "", "Chase Sets"];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function linkifyEscapedText(value: string) {
  return value.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener noreferrer">$1</a>');
}
