import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());
const { renderNotificationEmail } = await vite.ssrLoadModule("/lib/email-template.ts");

test("branded email keeps its own message, logo banner and relevant action", () => {
  const html = renderNotificationEmail({
    template: "hostel_booking_confirmed",
    subject: "Your hostel bed is confirmed",
    message: "Your place in Room A is confirmed.\n\nKeep reference HF-123.",
    appUrl: "https://rides.example.com",
    actionUrl: "https://rides.example.com/hostel/resident",
    actionLabel: "Open residency",
  });
  assert.match(html, /https:\/\/rides\.example\.com\/logo-web\.png/);
  assert.match(html, /HOSTEL FINDER/);
  assert.match(html, /Your hostel bed is confirmed/);
  assert.match(html, /Your place in Room A is confirmed/);
  assert.match(html, /Keep reference HF-123/);
  assert.match(html, /Open residency/);
  assert.match(html, /href="https:\/\/rides\.example\.com\/hostel\/resident"/);
});

test("sign-in code is prominent without leaking it into the subject or preview", () => {
  const html = renderNotificationEmail({
    template: "auth_login_code",
    subject: "Your UMaTeXPRESS sign-in code",
    message: "Your one-time sign-in code is 123456.\n\nIt expires in 10 minutes.",
  });
  assert.match(html, /ACCOUNT SECURITY/);
  assert.match(html, /YOUR ONE-TIME CODE/);
  assert.match(html, />123456</);
  assert.equal((html.match(/123456/g) || []).length, 1);
  assert.doesNotMatch(html, /<a href=/);
});

test("reset link becomes an action and untrusted content is escaped", () => {
  const html = renderNotificationEmail({
    template: "auth_password_reset",
    subject: "Reset your password",
    message: "Hello <script>alert(1)</script>,\n\nCode: 654321\n\nhttps://rides.example.com/reset-password?token=a&b=c\n\nExpires in 30 minutes.",
  });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Reset password/);
  assert.match(html, /href="https:\/\/rides\.example\.com\/reset-password\?token=a&amp;b=c"/);
  assert.equal((html.match(/654321/g) || []).length, 1);
});

test("unsafe action URLs do not render a button", () => {
  const html = renderNotificationEmail({ template: "campus_seats_open", subject: "A seat opened", message: "A place is free.", actionUrl: "javascript:alert(1)", actionLabel: "Open route" });
  assert.match(html, /CAMPUSRIDE/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /<a href=/);
});
