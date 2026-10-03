import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  configFile: false,
  appType: "custom",
  root,
  resolve: { alias: { "@": root } },
  plugins: [{
    name: "setup-readiness-fixture",
    enforce: "pre",
    resolveId(source) {
      if (source === "@/lib/hostel-engine/onboarding" || source.endsWith("/lib/hostel-engine/onboarding")) return "\0setup-readiness-fixture";
    },
    load(id) {
      if (id === "\0setup-readiness-fixture") return "export async function ownerReadiness(id) { const [profileStatus, identityStatus, payoutStatus] = id.split(':'); return { profileStatus, identityStatus, payoutStatus }; }";
    },
  }],
  server: { middlewareMode: true, hmr: false },
});
after(async () => vite.close());
const { requireApprovedRoomSetup } = await vite.ssrLoadModule("/lib/hostel-engine/room-setup.ts");

test("rooms unlock only after account, identity, payout and property approvals", async () => {
  const approved = "APPROVED:VERIFIED:APPROVED";
  await assert.doesNotReject(requireApprovedRoomSetup(approved, "APPROVED"));
  for (const [owner, property] of [
    ["PENDING:VERIFIED:APPROVED", "APPROVED"],
    ["APPROVED:PENDING:APPROVED", "APPROVED"],
    ["APPROVED:VERIFIED:PENDING", "APPROVED"],
    [approved, "PENDING_REVIEW"],
    [approved, "DRAFT"],
  ]) {
    await assert.rejects(requireApprovedRoomSetup(owner, property), error => error.code === "INVALID_STATE" && error.status === 409);
  }
});
