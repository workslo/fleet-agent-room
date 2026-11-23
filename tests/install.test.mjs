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

// Everything the installer moved out, as paths under ~/.agents/agent-room-old-installs/<run>/.
const oldInstalls = (box) => {
  const root = path.join(box.home, ".agents/agent-room-old-installs");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((run) => fs.readdirSync(path.join(root, run)).map((name) => path.join(root, run, name)));
};

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

test("ROOM_CLI in each agent's SKILL.md, and each agent's own link path, both run the CLI", async () => {
  const box = sandbox();
  try {
    await box.install();

    for (const link of box.links) {
      for (const cli of [roomCli(path.join(link, "SKILL.md"), box.home), path.join(link, "scripts/agent_room.mjs")]) {
        assert.ok(fs.statSync(cli).mode & 0o111, `${cli} should be executable`);
        const { stdout } = await run(process.execPath, [cli]);
        assert.match(stdout, /^Usage: agent_room\.mjs/);
      }
    }
  } finally { box.done(); }
});

test("a custom AGENTS_SKILLS_HOME rewrites ROOM_CLI to match", async () => {
  const box = sandbox();
  const custom = path.join(box.home, "elsewhere/skills");
  try {
    await box.install({ AGENTS_SKILLS_HOME: custom });

    const cli = roomCli(path.join(box.links[1], "SKILL.md"), box.home);
    assert.ok(path.isAbsolute(cli), cli);
    assert.equal(fs.realpathSync(cli), fs.realpathSync(path.join(custom, "agent-room/scripts/agent_room.mjs")));
    for (const link of box.links) assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(custom, "agent-room")));
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
    assert.match(stdout, /Moved .*\.codex\/skills\/agent-room to /);
    const moved = oldInstalls(box);
    assert.equal(moved.length, 1);
    assert.match(fs.readFileSync(path.join(moved[0], "SKILL.md"), "utf8"), /old copy/);
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

test("a skills dir that is itself a link to the store keeps the real copy", async () => {
  const box = sandbox();
  const codexSkills = path.dirname(box.links[0]);
  try {
    fs.mkdirSync(path.dirname(box.store), { recursive: true });
    fs.mkdirSync(path.dirname(codexSkills), { recursive: true });
    fs.symlinkSync(path.dirname(box.store), codexSkills);

    const { stdout } = await box.install();

    assert.ok(!fs.lstatSync(box.store).isSymbolicLink(), "the store copy must stay a real folder");
    assert.ok(fs.existsSync(path.join(box.store, "scripts/agent_room.mjs")));
    assert.match(stdout, /Skipped .*\.codex\/skills\/agent-room/);
    assert.equal(fs.realpathSync(box.links[1]), fs.realpathSync(box.store));
    assert.deepEqual(oldInstalls(box), []);
  } finally { box.done(); }
});

test("old agent-room.backup-* folders are swept out of both skills dirs", async () => {
  const box = sandbox();
  try {
    for (const link of box.links) {
      const backup = `${link}.backup-20261123-000000`;
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, "SKILL.md"), "---\nname: agent-room\n---\nbackup\n");
    }

    await box.install();

    for (const link of box.links) assert.deepEqual(skillEntries(path.dirname(link)), ["agent-room"]);
    assert.equal(oldInstalls(box).length, 2, "both backups are kept outside the skills dirs");
  } finally { box.done(); }
});

test("a failed install leaves the previous copy intact and no temp folder in the store", async () => {
  const box = sandbox();
  const broken = path.join(box.home, "broken-checkout");
  try {
    await box.install();
    const before = fs.readFileSync(path.join(box.store, "scripts/agent_room.mjs"), "utf8");
    fs.mkdirSync(path.join(broken, "agents"), { recursive: true });
    for (const file of ["install.sh", "SKILL.md", "agents/openai.yaml"]) fs.copyFileSync(path.join(REPO, file), path.join(broken, file));

    await assert.rejects(run("bash", [path.join(broken, "install.sh")], { env: box.env }));

    assert.equal(fs.readFileSync(path.join(box.store, "scripts/agent_room.mjs"), "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.dirname(box.store)), ["agent-room"]);
  } finally { box.done(); }
});

test("a relative AGENTS_SKILLS_HOME with & in it still yields a working absolute ROOM_CLI", async () => {
  const box = sandbox();
  try {
    await run("bash", [path.join(REPO, "install.sh")], { env: { ...box.env, AGENTS_SKILLS_HOME: "odd&dir/skills" }, cwd: box.home });

    const cli = roomCli(path.join(box.links[0], "SKILL.md"), box.home);
    assert.ok(path.isAbsolute(cli), cli);
    assert.equal(fs.realpathSync(cli), fs.realpathSync(path.join(box.home, "odd&dir/skills/agent-room/scripts/agent_room.mjs")));
    for (const link of box.links) assert.ok(fs.existsSync(path.join(link, "SKILL.md")), `${link} should resolve`);
  } finally { box.done(); }
});

test("a store path with a quote is refused before anything is written", async () => {
  const box = sandbox();
  try {
    await assert.rejects(box.install({ AGENTS_SKILLS_HOME: path.join(box.home, 'bad"dir') }), /can't contain quotes/);

    for (const link of box.links) assert.ok(!fs.existsSync(link));
  } finally { box.done(); }
});
