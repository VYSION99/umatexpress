import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});
after(async () => vite.close());

const { TOURS, LAUNCHER_TOUR, CAMPUS_TICKET_TOUR, HOSTEL_TOUR, PRINT_COPY_TOUR } =
  await vite.ssrLoadModule("/lib/tour-engine/manifests.ts");
const { TourOverlay } = await vite.ssrLoadModule("/components/tour/TourOverlay.tsx");

test("tour manifests are properly structured and registered", () => {
  assert.ok(TOURS.launcher, "Launcher tour exists");
  assert.ok(TOURS["campus-ticket"], "Campus ticket tour exists");
  assert.ok(TOURS.hostel, "Hostel tour exists");
  assert.ok(TOURS["print-copy"], "Print & Copy tour exists");

  assert.equal(LAUNCHER_TOUR.id, "launcher");
  assert.equal(LAUNCHER_TOUR.steps.length, 5);
  const launcherSelectors = LAUNCHER_TOUR.steps.map((s) => s.targetSelector);
  assert.deepEqual(launcherSelectors, [
    '[data-tour="curiosity-pilot"]',
    '[data-tour="launcher-bell"]',
    '[data-tour="service-campus"]',
    '[data-tour="service-hostel"]',
    '[data-tour="launcher-profile"]',
  ]);

  assert.equal(CAMPUS_TICKET_TOUR.id, "campus-ticket");
  assert.equal(CAMPUS_TICKET_TOUR.steps.length, 3);
  const ticketSelectors = CAMPUS_TICKET_TOUR.steps.map((s) => s.targetSelector);
  assert.deepEqual(ticketSelectors, [
    '[data-tour="ticket-progress"]',
    '[data-tour="ticket-pin"]',
    '[data-tour="ticket-chat"]',
  ]);

  assert.equal(HOSTEL_TOUR.id, "hostel");
  assert.equal(HOSTEL_TOUR.steps.length, 2);
  const hostelSelectors = HOSTEL_TOUR.steps.map((s) => s.targetSelector);
  assert.deepEqual(hostelSelectors, [
    '[data-tour="hostel-periods"]',
    '[data-tour="hostel-filters"]',
  ]);

  assert.equal(PRINT_COPY_TOUR.id, "print-copy");
  assert.equal(PRINT_COPY_TOUR.steps.length, 2);
  const printSelectors = PRINT_COPY_TOUR.steps.map((s) => s.targetSelector);
  assert.deepEqual(printSelectors, [
    '[data-tour="print-quote-trigger"]',
    '[data-tour="print-my-quotes"]',
  ]);
});

test("TourOverlay renders accessible modal dialog with SVG spotlight and progress indicators", () => {
  const step = LAUNCHER_TOUR.steps[0];
  const html = renderToStaticMarkup(
    createElement(TourOverlay, {
      tour: LAUNCHER_TOUR,
      step,
      stepIndex: 0,
      totalSteps: LAUNCHER_TOUR.steps.length,
      onNext: () => {},
      onPrev: () => {},
      onDismiss: () => {},
    }),
  );

  assert.ok(html.includes('class="tour-backdrop-layer"'), "Backdrop layer renders");
  assert.ok(html.includes('class="tour-spotlight-svg"'), "Spotlight SVG renders");
  assert.ok(html.includes('id="tour-spotlight-mask"'), "Spotlight mask renders");
  assert.ok(html.includes('class="tour-card-popover"'), "Card popover renders");
  assert.ok(html.includes(step.title), "Step title renders");
  assert.ok(html.includes(step.content), "Step content renders");
  assert.ok(html.includes("Step 1/5") || html.includes("1/5"), "Step badge renders");
  assert.ok(html.includes("Next"), "Next button renders");
});

test("tour styles support mobile bottom docking and reduced motion preferences", async () => {
  const css = await readFile(new URL("../components/tour/tour.css", import.meta.url), "utf8");
  assert.match(css, /\.tour-backdrop-layer/);
  assert.match(css, /\.tour-spotlight-svg/);
  assert.match(css, /\.tour-card-popover/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)/);
  assert.match(css, /bottom:\s*max\(16px,\s*env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.tour-target-highlight/);
});

test("all tour step target data attributes exist across application surfaces", async () => {
  const launcher = await readFile(new URL("../components/launcher/CampusLauncher.tsx", import.meta.url), "utf8");
  const ticket = await readFile(new URL("../app/campus/ticket/page.tsx", import.meta.url), "utf8");
  const hostel = await readFile(new URL("../components/campusRide/hostel/HostelFilters.tsx", import.meta.url), "utf8");
  const printCopy = await readFile(new URL("../components/printCopy/PrintCopyActions.tsx", import.meta.url), "utf8");

  // Launcher anchors
  assert.match(launcher, /data-tour="curiosity-pilot"/);
  assert.match(launcher, /data-tour="launcher-bell"/);
  assert.match(launcher, /service\.id === "campus" \? "service-campus"/);
  assert.match(launcher, /service\.id === "hostels" \? "service-hostel"/);
  assert.match(launcher, /data-tour="launcher-profile"/);

  // Ticket anchors
  assert.match(ticket, /data-tour="ticket-progress"/);
  assert.match(ticket, /data-tour="ticket-pin"/);
  assert.match(ticket, /data-tour="ticket-chat"/);

  // Hostel anchors
  assert.match(hostel, /data-tour="hostel-periods"/);
  assert.match(hostel, /data-tour="hostel-filters"/);

  // Print & Copy anchors
  assert.match(printCopy, /data-tour="print-quote-trigger"/);
  assert.match(printCopy, /data-tour="print-my-quotes"/);
});
