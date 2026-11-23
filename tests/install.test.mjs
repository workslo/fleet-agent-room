// install.sh tests. Each test gets a throwaway HOME, so nothing touches the real skill libraries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["SKILL.md", "agents/openai.yaml", "scripts/agent_room.mjs"];

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-room-install-"));
  const tmp = path.join(home, "tmp");
  fs.mkdirSync(tmp);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp };
  return {
    home, tmp, env,
    store: path.join(home, ".agents/skills/agent-room"),
    links: [path.join(home, ".codex/skills/agent-room"), path.join(home, ".claude/skills/agent-room")],
    install: (extra = {}) => run("bash", [path.join(REPO, "install.sh")], { env: { ...env, ...extra } }),
    done: () => fs.rmSync(home, { recursive: true }),
  };
}

// The ROOM_CLI line from an installed SKILL.md, expanded the way an agent's shell would.
const roomCli = (skillMd, home) =>
  fs.readFileSync(skillMd, "utf8").match(/^ROOM_CLI="(.*)"$/m)[1].replace("$HOME", home);

const skillEntries = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith("agent-room"));

test("installs one copy in ~/.agents/skills and links both agents to it", async () => {
  const box = sandbox();
  try {
    await box.install();

    assert.ok(!fs.lstatSync(box.store).isSymbolicLink());
    for (const file of FILES) {
      assert.equal(fs.readFileSync(path.join(box.store, file), "utf8"), fs.readFileSync(path.join(REPO, file), "utf8"));
    }
    for (const link of box.links) {
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} should be a link`);
      assert.equal(fs.realpathSync(link), fs.realpathSync(box.store));
    }
  } finally { box.done(); }
});

test("ROOM_CLI in the installed SKILL.md resolves from both agents' skill paths", async () => {
  const box = sandbox();
  try {
    await box.install();

    for (const link of box.links) {
      const cli = roomCli(path.join(link, "SKILL.md"), box.home);
      assert.ok(fs.statSync(cli).mode & 0o111, `${cli} should be executable`);
      const { stdout } = await run(process.execPath, [cli]);
      assert.match(stdout, /^Usage: agent_room\.mjs/);
    }
  } finally { box.done(); }
});

test("a custom AGENTS_SKILLS_HOME rewrites ROOM_CLI to match", async () => {
  const box = sandbox();
  const custom = path.join(box.home, "elsewhere/skills");
  try {
    await box.install({ AGENTS_SKILLS_HOME: custom });

    const cli = roomCli(path.join(box.links[1], "SKILL.md"), box.home);
    assert.equal(cli, path.join(custom, "agent-room/scripts/agent_room.mjs"));
    assert.ok(fs.existsSync(cli));
  } finally { box.done(); }
});

test("migrating from the old copy-into-Codex layout leaves no second skill behind", async () => {
  const box = sandbox();
  const [codexLink, claudeLink] = box.links;
  try {
    fs.mkdirSync(path.join(codexLink, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(codexLink, "SKILL.md"), "---\nname: agent-room\n---\nold copy\n");
    fs.mkdirSync(path.dirname(claudeLink), { recursive: true });
    fs.symlinkSync(codexLink, claudeLink);

    const { stdout } = await box.install();

    for (const link of box.links) {
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.deepEqual(skillEntries(path.dirname(link)), ["agent-room"]);
      assert.equal(fs.realpathSync(link), fs.realpathSync(box.store));
    }
    assert.match(stdout, /Moved the old copy/);
    const moved = fs.readdirSync(box.tmp).filter((name) => name.startsWith("agent-room-old-install-"));
    assert.equal(moved.length, 1);
    assert.match(fs.readFileSync(path.join(box.tmp, moved[0], "SKILL.md"), "utf8"), /old copy/);
  } finally { box.done(); }
});

test("re-running the installer updates in place without backups or stray folders", async () => {
  const box = sandbox();
  try {
    await box.install();
    fs.writeFileSync(path.join(box.store, "SKILL.md"), "stale\n");

    await box.install();

    assert.equal(fs.readFileSync(path.join(box.store, "SKILL.md"), "utf8"), fs.readFileSync(path.join(REPO, "SKILL.md"), "utf8"));
    for (const dir of [path.dirname(box.store), ...box.links.map((link) => path.dirname(link))]) {
      assert.deepEqual(fs.readdirSync(dir), ["agent-room"], `${dir} should hold only agent-room`);
    }
  } finally { box.done(); }
});
