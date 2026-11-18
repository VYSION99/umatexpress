import assert from "node:assert/strict";
import { existsSync } from "node:fs";

async function inspectRoute(worker, path, options = {}) {
  const url = `http://localhost${path}`;
  const response = await worker.fetch(
    new Request(url, {
      headers: {
        accept: options.accept || "text/html",
        ...(options.headers || {}),
      },
      method: options.method || "GET",
      body: options.body,
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  const status = response.status;
  const contentType = response.headers.get("content-type") || "";
  const bodyText = await response.text();

  return { status, contentType, bodyText, url };
}

async function runLiveInspection() {
  console.log("==================================================");
  console.log("   UMaTeXPRESS — Live Engine & UI Inspection     ");
  console.log("==================================================");

  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  if (!existsSync(workerUrl)) {
    console.error("dist/server/index.js not found. Please build first.");
    process.exit(1);
  }

  workerUrl.searchParams.set("t", String(Date.now()));
  const { default: worker } = await import(workerUrl.href);

  const checks = [
    {
      name: "1. Launcher Home Screen (/)",
      path: "/",
      expectedStatus: 200,
      mustContain: [
        "UMaTeXPRESS",
        "CampusRide",
        "Hostel",
        "Vacation",
      ],
    },
    {
      name: "2. CampusRide Shell (/campus)",
      path: "/campus",
      expectedStatus: 200,
      mustContain: [
        "campusRide",
      ],
    },
    {
      name: "3. CampusRide Ticket Shell (/campus/ticket)",
      path: "/campus/ticket",
      expectedStatus: 200,
      mustContain: [
        "ticket",
      ],
    },
    {
      name: "4. Hostel Finder Directory (/hostel)",
      path: "/hostel",
      expectedStatus: 200,
      mustContain: [
        "Hostel",
      ],
    },
    {
      name: "5. Print & Copy Hub (/print-copy)",
      path: "/print-copy",
      expectedStatus: 200,
      mustContain: [
        "Print",
        "Copy",
      ],
    },
    {
      name: "6. Notification Feed API Gate (/api/notifications)",
      path: "/api/notifications",
      accept: "application/json",
      expectedStatus: 401,
      mustContain: [
        "UNAUTHORIZED",
      ],
    },
    {
      name: "7. Curbside / Quote Messages API Gate (/api/messages)",
      path: "/api/messages",
      accept: "application/json",
      expectedStatus: 400,
      mustContain: [
        "VALIDATION_ERROR",
      ],
    },
  ];

  let passedCount = 0;

  for (const check of checks) {
    console.log(`\nInspecting: ${check.name}...`);
    const result = await inspectRoute(worker, check.path, { accept: check.accept });
    console.log(`  → URL: ${result.url}`);
    console.log(`  → Status: ${result.status} (Expected: ${check.expectedStatus})`);
    console.log(`  → Content-Type: ${result.contentType}`);
    console.log(`  → Body Size: ${result.bodyText.length} bytes`);

    assert.equal(result.status, check.expectedStatus, `Status mismatch on ${check.path}`);

    for (const phrase of check.mustContain) {
      const match = new RegExp(phrase, "i").test(result.bodyText);
      assert.ok(
        match,
        `Expected rendered output to contain "${phrase}"`,
      );
      console.log(`  ✓ Contains expected token: "${phrase}"`);
    }

    passedCount++;
  }

  console.log("\n==================================================");
  console.log(`All ${passedCount}/${checks.length} live routes inspected and verified successfully!`);
  console.log("==================================================");
}

runLiveInspection().catch((err) => {
  console.error("\nInspection Failure:", err);
  process.exit(1);
});
