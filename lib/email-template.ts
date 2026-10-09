/**
 * One email layout for every notification delivered through Resend. The
 * outbox's subject and message remain the source of truth; this module only
 * presents them, without inventing booking or payment facts.
 */

export type EmailPresentation = {
  template: string;
  subject: string;
  message: string;
  appUrl?: string;
  actionUrl?: string;
  actionLabel?: string;
  replyTo?: string;
};

const PUBLIC_BRAND_ORIGIN = "https://umatexpress.acmdevelopers2020.workers.dev";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.toString() : "";
  } catch {
    return "";
  }
}

function brandOrigin(value: string) {
  const configured = safeHttpsUrl(String(value || "").trim());
  return configured ? new URL(configured).origin : PUBLIC_BRAND_ORIGIN;
}

function sectionFor(template: string) {
  if (template.startsWith("auth_")) return { label: "ACCOUNT SECURITY", color: "#285c80", pale: "#eaf3f8" };
  if (template.startsWith("hostel_") || template.startsWith("landlord_")) return { label: "HOSTEL FINDER", color: "#176b50", pale: "#eaf6ef" };
  if (template.startsWith("vacation_") || template.startsWith("organizer_")) return { label: "VACATIONRIDE", color: "#a24f21", pale: "#fff2e8" };
  if (template.startsWith("campus_") || template.startsWith("driver_") || template === "trip_completed") return { label: "CAMPUSRIDE", color: "#285cb0", pale: "#edf3ff" };
  if (template.startsWith("cinema_")) return { label: "ONLINECINEMA", color: "#6e46a8", pale: "#f3effa" };
  return { label: "UMATEXPRESS", color: "#176b50", pale: "#eaf6ef" };
}

function messageLines(message: string, template: string) {
  const lines = String(message || "").replace(/\r\n?/g, "\n").split("\n");
  const code = template === "auth_login_code"
    ? message.match(/(?:sign-in code is|Code:)\s*(\d{6})/i)?.[1] || ""
    : template === "auth_password_reset"
      ? message.match(/(?:^|\n)Code:\s*(\d{6})/i)?.[1] || ""
      : "";
  const resetUrl = template === "auth_password_reset"
    ? lines.map(line => safeHttpsUrl(line.trim())).find(Boolean) || ""
    : "";
  const body = lines.filter(line => {
    const trimmed = line.trim();
    if (template === "auth_login_code" && /^Your one-time sign-in code is \d{6}\.$/i.test(trimmed)) return false;
    if (template === "auth_password_reset" && (/^Code:\s*\d{6}$/i.test(trimmed) || trimmed === resetUrl)) return false;
    return true;
  }).join("\n").trim();
  return { body, code, resetUrl };
}

function paragraphs(message: string) {
  return message.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean).map(block => {
    const text = escapeHtml(block).replace(/\n/g, "<br>");
    return `<p style="margin:0 0 18px;color:#34453f;font:16px/1.65 Arial,Helvetica,sans-serif;word-break:break-word;">${text}</p>`;
  }).join("");
}

/** HTML is escaped before interpolation; only HTTPS destinations become links. */
export function renderNotificationEmail(input: EmailPresentation) {
  const section = sectionFor(input.template);
  const { body, code, resetUrl } = messageLines(input.message, input.template);
  const suppliedAction = safeHttpsUrl(String(input.actionUrl || ""));
  const actionUrl = suppliedAction || resetUrl;
  const actionLabel = suppliedAction ? String(input.actionLabel || "Open details") : resetUrl ? "Reset password" : "";
  const logoUrl = `${brandOrigin(input.appUrl || "")}/logo-web.png`;
  const subject = escapeHtml(String(input.subject || "UMaTeXPRESS update"));
  const replyNote = input.replyTo ? `<p style="margin:0 0 6px;color:#61716a;font:12px/1.6 Arial,Helvetica,sans-serif;">Need help? Reply to this email.</p>` : "";
  const codeBlock = code ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 22px;border:1px solid #d8e6e0;border-radius:12px;background:#f3f8f5;"><tr><td align="center" style="padding:19px 16px;"><span style="display:block;color:#5b6f65;font:700 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:1.5px;">YOUR ONE-TIME CODE</span><strong style="display:block;margin-top:8px;color:#163b2e;font:700 31px/1.2 Arial,Helvetica,sans-serif;letter-spacing:6px;">${code}</strong></td></tr></table>` : "";
  const actionBlock = actionUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:7px 0 24px;"><tr><td bgcolor="${section.color}" style="border-radius:10px;"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:14px 22px;color:#ffffff;text-decoration:none;font:700 15px/1.3 Arial,Helvetica,sans-serif;">${escapeHtml(actionLabel)}</a></td></tr></table><p style="margin:0 0 22px;color:#64756c;font:12px/1.5 Arial,Helvetica,sans-serif;word-break:break-all;">Button not working? Open <a href="${escapeHtml(actionUrl)}" style="color:${section.color};text-decoration:underline;">this link</a>.</p>` : "";

  const preview = input.template.startsWith("auth_")
    ? "Account information from UMaTeXPRESS. Open this email for the details."
    : String(input.message || "").replace(/\s+/g, " ").slice(0, 130);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head><body style="margin:0;padding:0;background:#f2f5f2;color:#193027;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f2f5f2"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border:1px solid #e0e8e1;border-radius:18px;overflow:hidden;background:#ffffff;">
<tr><td align="center" bgcolor="#06120d" style="padding:14px 24px 12px;background:#06120d;"><img src="${escapeHtml(logoUrl)}" width="178" height="141" alt="UMaTeXPRESS" style="display:block;width:178px;max-width:100%;height:auto;border:0;"></td></tr>
<tr><td style="padding:34px 36px 24px;"><span style="display:inline-block;padding:7px 10px;border-radius:6px;background:${section.pale};color:${section.color};font:700 11px/1.2 Arial,Helvetica,sans-serif;letter-spacing:1.2px;">${section.label}</span><h1 style="margin:19px 0 20px;color:#142d22;font:700 27px/1.24 Arial,Helvetica,sans-serif;">${subject}</h1>${paragraphs(body)}${codeBlock}${actionBlock}</td></tr>
<tr><td style="padding:22px 36px 28px;border-top:1px solid #e7ede8;background:#f9fbf9;">${replyNote}<p style="margin:0;color:#718077;font:12px/1.6 Arial,Helvetica,sans-serif;">UMaTeXPRESS · Your campus companion</p></td></tr>
</table></td></tr></table></body></html>`;
}
