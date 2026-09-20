import assert from "node:assert/strict";
import test from "node:test";
import {
  CONSOLE_GROUP_ORDER,
  consoleGroupsForRole,
  consoleServiceById,
  consoleServices,
  consoleServicesForRole,
} from "../components/admin/console-services.ts";

// The console is one console for every service. This test pins the shape of
// that promise, because the shell renders whatever this registry returns and a
// broken entry would break a role's whole sidebar rather than one page.

test("every console service belongs to a declared group", () => {
  for (const service of consoleServices) {
    assert.ok(CONSOLE_GROUP_ORDER.includes(service.group), `${service.id} is in an undeclared group: ${service.group}`);
    assert.match(service.id, /^[a-z]+$/);
    assert.ok(service.title.trim() && service.detail.trim() && service.action.trim(), `${service.id} is missing display copy`);
  }
});

test("a service that can be opened has navigation and an internal destination", () => {
  for (const service of consoleServices) {
    assert.ok(Array.isArray(service.nav), `${service.id} must declare its navigation`);
    if (!service.href) {
      assert.equal(service.nav.length, 0, `${service.id} is coming soon, so it cannot have navigation`);
      continue;
    }
    assert.match(service.href, /^\//, `${service.id} must open an internal page`);
    assert.ok(service.nav.length >= 1, `${service.id} must offer at least one navigation entry`);
    for (const entry of service.nav) {
      assert.match(entry.href, /^\//, `${service.id} navigation must stay inside the app`);
      assert.ok(entry.label.trim(), `${service.id} has an unlabelled navigation entry`);
    }
  }
});

test("each role gets the services it may use, without repeats", () => {
  for (const role of ["ADMIN", "MODERATOR", "ORGANIZER", "LANDLORD", "DRIVER"]) {
    const services = consoleServicesForRole(role);
    assert.ok(services.length, `${role} must be offered something`);
    const ids = services.map((service) => service.id);
    assert.equal(new Set(ids).size, ids.length, `${role} was offered a service twice`);
    for (const service of services) {
      assert.ok(consoleServices.some((entry) => entry.id === service.id), `${role} was offered an unknown service`);
    }
    assert.ok(ids.includes("security"), `${role} must always be able to change its password`);
  }
  assert.deepEqual(
    consoleServicesForRole("ADMIN").map((service) => service.id),
    ["campus", "vacation", "organizers", "payouts", "disputes", "hostels", "food", "cinema", "security"],
    "an administrator gets the platform's services, never another role's personal workspace, and still sees what is coming",
  );
  assert.deepEqual(consoleServicesForRole("SOMETHING").map((service) => service.id), ["security"], "an unknown role only ever reaches account security");
});

test("the grouped directory is a re-grouping of exactly what the role was offered", () => {
  for (const role of ["ADMIN", "MODERATOR", "ORGANIZER", "LANDLORD", "DRIVER"]) {
    const offered = consoleServicesForRole(role).map((service) => service.id);
    const groups = consoleGroupsForRole(role);
    assert.deepEqual(groups.map((entry) => entry.group), CONSOLE_GROUP_ORDER.filter((group) => groups.some((entry) => entry.group === group)), `${role} groups are out of order`);
    for (const entry of groups) {
      assert.ok(entry.services.length, `${role} has an empty ${entry.group} group`);
      for (const service of entry.services) assert.equal(service.group, entry.group);
    }
    const grouped = groups.flatMap((entry) => entry.services.map((service) => service.id)).sort();
    assert.deepEqual(grouped, [...offered].sort(), `${role} grouping lost or duplicated a service`);
  }
});

test("every openable service lives on the console origin", () => {
  for (const service of consoleServicesForRole("ADMIN")) {
    if (!service.href) continue;
    assert.match(service.href, /^\/console(\/|$)/, `${service.id} must be served by the console`);
    for (const entry of service.nav) assert.match(entry.href, /^\/console(\/|$)/, `${service.id} navigation must stay on the console origin`);
  }
});

test("a role is only offered the services its work belongs to", () => {
  assert.deepEqual(consoleServicesForRole("DRIVER").map((service) => service.id), ["driver", "security"], "a driver only works the driver portal and their own account");
  assert.deepEqual(consoleServicesForRole("LANDLORD").map((service) => service.id), ["hostels", "security"], "a landlord only gets the hostel workspace and their own account");
  for (const role of ["MODERATOR", "ORGANIZER"]) {
    const ids = consoleServicesForRole(role).map((service) => service.id);
    assert.ok(!ids.includes("campus") && !ids.includes("vacation"), `${role} was offered operations services: ${ids.join(", ")}`);
  }
  for (const id of ["driver", "organizer", "profile", "earnings"]) {
    const adminIds = consoleServicesForRole("ADMIN").map((service) => service.id);
    assert.ok(!adminIds.includes(id), `an administrator must not be offered ${id}: the page belongs to another role`);
  }
});

test("the shell can resolve the service a page names", () => {
  for (const service of consoleServices) assert.equal(consoleServiceById(service.id)?.id, service.id);
  assert.equal(consoleServiceById("nope"), null);
});
