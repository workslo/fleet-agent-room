// End-to-end CLI tests. Each run gets its own state dir and port, so it never touches ~/.agent-room or port 7331.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "agent_room.mjs");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-room-test-"));
const PORT = String(17000 + Math.floor(Math.random() * 2000));
const env = { ...process.env, AGENT_ROOM_HOME: HOME, AGENT_ROOM_PORT: PORT };

const room = (...args) => run(process.execPath, [SCRIPT, ...args], { env });
const transcript = async (code) => (await room("transcript", code)).stdout;
let code;

before(async () => {
  const { stdout } = await room("create", "--title", "Test", "--name", "Fable");
  code = stdout.match(/AM-[A-Z0-9]{4}/)[0];
  await room("join", code, "--name", "Sol");
});

after(async () => {
  await room("stop");
  fs.rmSync(HOME, { recursive: true });
});

test("a message that starts with -- is posted verbatim", async () => {
  await room("send", code, "--name", "Fable", "--message", "--force is risky here");

  assert.match(await transcript(code), /Fable: --force is risky here/);
});

test("--flag=value form is accepted", async () => {
  await room("send", code, "--name=Fable", "--message=equals form works");

  assert.match(await transcript(code), /Fable: equals form works/);
});

test("a value flag with nothing after it fails instead of sending 'true'", async () => {
  await assert.rejects(room("send", code, "--name", "Fable", "--message"), /--message requires a value/);

  assert.doesNotMatch(await transcript(code), /Fable: true/);
});

test("a bare --wait waits the 45s default, not 1s", async () => {
  await room("listen", code, "--name", "Sol", "--wait", "0");
  const started = Date.now();
  const listener = room("listen", code, "--name", "Sol", "--wait");

  await new Promise((resolve) => setTimeout(resolve, 2500));
  await room("send", code, "--name", "Fable", "--message", "wake up");
  const { stdout } = await listener;

  assert.ok(Date.now() - started >= 2500, "bare --wait returned before a message arrived");
  assert.match(stdout, /Fable: wake up/);
});

test("--wait 0 returns immediately instead of falling back to 45s", async () => {
  const started = Date.now();

  await room("listen", code, "--name", "Sol", "--wait", "0");

  assert.ok(Date.now() - started < 5000);
});

test("a non-numeric --wait is rejected", async () => {
  await assert.rejects(room("listen", code, "--name", "Sol", "--wait", "soon"), /--wait must be a number/);
});
