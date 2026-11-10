import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const code = ts.transpileModule(readFileSync(new URL("../lib/cinema-engine/chat-history.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const room = { id: "room", isMember: true, currentRole: "HOST", status: "LIVE", sourceType: "UPLOAD", videoId: "second" };
  const message = { id: "message", sessionId: "room", video: { sourceType: "UPLOAD", videoId: "first" }, atSeconds: 42 };
  let uploads = [{ id: "first", status: "READY", durationSeconds: 100 }], changed = 1, historyReads = 0;
  const writes = [], exports = {};
  class EngineError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status; } }
  const deps = {
    "@/lib/campus-engine/errors": { CampusEngineError: EngineError },
    "./rooms": { readRoom: async () => room },
    "./messages": { readCinemaMessage: async () => message, cinemaMessagePage: async () => { historyReads++; return { messages: [] }; } },
    "./uploads": { cinemaUploadsForRoom: async () => uploads },
    "@/lib/turso": { turso: async (sql, args) => { writes.push([sql, args]); return { affected_row_count: changed }; } },
  };
  vm.runInNewContext(code, { exports, require: name => deps[name], Date });
  return { room, message, writes, exports, setUploads: value => { uploads = value; }, conflict: () => { changed = 0; }, get reads() { return historyReads; } };
}
const input = { roomId: "room", studentId: "student", messageId: "message" };
test("chat history checks membership before reading any rows", async () => {
  const f = fixture(); f.room.isMember = false;
  await assert.rejects(f.exports.readCinemaChatHistory(input), error => error.status === 403);
  assert.equal(f.reads, 0);
});
test("only room members with playback permission may open a reference", async () => {
  for (const currentRole of ["VIEWER", ""]) {
    const f = fixture(); f.room.currentRole = currentRole;
    await assert.rejects(f.exports.activateCinemaChatMoment(input), error => error.status === 403);
    assert.equal(f.writes.length, 0);
  }
});
test("host opens the exact stored upload and timestamp rather than the current file", async () => {
  const f = fixture(); const result = await f.exports.activateCinemaChatMoment(input);
  assert.equal(result.videoId, "first"); assert.equal(result.positionSeconds, 42);
  assert.equal(f.writes[0][1][0], "first"); assert.equal(f.writes[0][1][3], "second");
});
test("presenter may seek the current video but cannot replace a playlist source", async () => {
  const f = fixture(); f.room.currentRole = "PRESENTER";
  await assert.rejects(f.exports.activateCinemaChatMoment(input), error => error.status === 403);
  f.room.videoId = "first";
  assert.equal((await f.exports.activateCinemaChatMoment(input)).positionSeconds, 42);
});
test("removed messages, cross-room references and removed uploads cannot change playback", async () => {
  for (const mutate of [f => { f.message.removed = true; }, f => { f.message.sessionId = "elsewhere"; }, f => f.setUploads([]), f => { f.message.video = undefined; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.exports.activateCinemaChatMoment(input), error => error.status === 404);
    assert.equal(f.writes.length, 0);
  }
});
test("ended rooms and concurrent playlist changes are refused", async () => {
  const f = fixture(); f.room.status = "ENDED";
  await assert.rejects(f.exports.activateCinemaChatMoment(input), error => error.status === 409);
  f.room.status = "LIVE"; f.conflict();
  await assert.rejects(f.exports.activateCinemaChatMoment(input), error => error.status === 409);
});
test("chat merging is ordered and never resurrects removed text", () => {
  const exports = {};
  const mergeCode = ts.transpileModule(readFileSync(new URL("../lib/cinema-engine/chat-state.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(mergeCode, { exports });
  const one = { id: "one", sequence: 1, content: "Removed text", createdAt: "" }, two = { id: "two", sequence: 2, content: "Kept text", createdAt: "" };
  const result = exports.mergeCinemaChat([two], [one, two], new Set(["one"]));
  assert.equal(result.length, 2); assert.equal(result[0].content, ""); assert.equal(result[0].removed, true);
  assert.equal(exports.mergeCinemaChat(result, [one])[0].content, "");
});
