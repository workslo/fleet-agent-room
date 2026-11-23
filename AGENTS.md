# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`CLAUDE.md` is a symlink to this `AGENTS.md`, so Codex and Claude Code read the same file.

## What this repo is

Agent Room is a skill, not an app: a localhost meeting room where Codex, Claude Code, and other terminal agents talk to each other through a CLI while a human watches or joins in a browser. `workslo/fleet-agent-room` is a fork of `steviebuilds/agent-room` (remote `upstream`).

Four files make up the product:

- `scripts/agent_room.mjs`: everything. HTTP server, CLI, state store, and the browser UI, with zero dependencies.
- `SKILL.md`: the instructions agents follow once the skill is installed. Changing it changes agent behavior (the room-loop rules, addressed-only etiquette, stop conditions). Treat it as product code.
- `agents/openai.yaml`: Codex skill-picker metadata.
- `install.sh`: copies those three into `~/.agents/skills/agent-room` (Shane's skills store; `AGENTS_SKILLS_HOME` overrides it) and links `$CODEX_HOME/skills/agent-room` and `$CLAUDE_HOME/skills/agent-room` to that copy.

## Commands

There is no package.json, build, or linter. The runtime is Node 20+ or Bun.

```bash
node --check scripts/agent_room.mjs                 # syntax check
node --test tests/*.test.mjs                        # CLI tests (also: bun test tests/cli.test.mjs)
node --test --test-name-pattern="bare --wait" tests/*.test.mjs   # one test
node scripts/agent_room.mjs                         # usage
```

The tests in `tests/cli.test.mjs` spawn the real CLI against a temp `AGENT_ROOM_HOME` and a random port, and stop their server when done. Pass the file glob: Node 24's `node --test tests/` treats the directory as a module and fails.

Validate changes against an isolated state dir and port, so you never touch `~/.agent-room` or a real meeting on 7331:

```bash
export AGENT_ROOM_HOME="$(mktemp -d)" AGENT_ROOM_PORT=7399
node scripts/agent_room.mjs create --title "Test" --name Fable --user-name Tester   # prints invite with AM-XXXX
node scripts/agent_room.mjs join AM-XXXX --name Sol
node scripts/agent_room.mjs send AM-XXXX --name Fable --message "hi" --wait 10
node scripts/agent_room.mjs listen AM-XXXX --name Sol --wait 5
node scripts/agent_room.mjs close AM-XXXX --name Fable --summary "done"
node scripts/agent_room.mjs stop
```

Commands that are only reachable over HTTP: toggle addressed-only mode with `POST /api/rooms/:code/mode {"addressed_only":true}`, and post as the human with `POST /api/rooms/:code/viewer/messages {"content":"..."}`. `GET /api/health` returns the running version.

`tests/install.test.mjs` runs `install.sh` under a throwaway `HOME`. To try it by hand without touching the real skill libraries, run `HOME="$(mktemp -d)" ./install.sh`.

## Architecture (agent_room.mjs)

- **One process, two roles.** `serve` runs the HTTP server. Every other command is a client, and calls `ensureServer()` first. That spawns `serve` detached (logging to `server.log`, PID in `server.pid`) when nothing is answering on the port.
- **`VERSION` drives hot replacement.** When a client finds a running server whose `/api/health` version differs from its own `VERSION`, it SIGTERMs that server via `server.pid` and starts its own. Bump `VERSION` whenever you change server behavior, or the long-lived server keeps serving the old code.
- **State is one JSON file**, `$AGENT_ROOM_HOME/rooms.json` (default `~/.agent-room/`). The server re-reads it on every request and writes it atomically (tmp + rename). A file that fails to parse is renamed `rooms.json.corrupt-<ts>`, and the server starts empty. `migrateState()` runs at server start to backfill fields older versions lacked. Add to it when you add a per-room or per-participant field. `config.json` holds only `user_name`.
- **Unread tracking lives on the server.** Each participant carries `last_read_id`. `GET /messages?name=` returns messages after it, leaves out the caller's own messages, then advances it to the latest id. System messages (joins, mode changes) count as unread, so a `--wait` can return immediately with a join notice. Clients never pass cursors; only the browser viewer uses `?after=`.
- **Long-polling** works through an in-memory `waiters` map keyed by room code. Any write calls `notify(code)` to wake every waiter in that room. Waits are capped at 300s. The client's HTTP timeout is `wait + 5`s.
- **Addressed-only mode.** `addressedTo()` matches the participant's name, with an optional `@`, as a whole word (Unicode-aware, case-insensitive), and only in `agent` and `human` messages. The server computes `should_respond`. The CLI turns that into the "Response mode: …" guidance lines that SKILL.md tells agents to obey, so the wording of those strings is part of the agent contract.
- **Message kinds:** `system`, `agent`, `human` (browser viewer), and `summary` (written by `close`). Closing clears participants and rejects further writes with 409.
- **Browser UI** is inlined HTML/CSS/JS built by `meetingPage()`, `landingPage()`, and `notFoundPage()`. Its script is a JS template literal inside a template literal, so backticks and `${` in the client code are escaped (`\``, `\${`). The server injects room data with `<` escaped as `<`.
- `PARTICIPANT_COLORS` is duplicated in the page script's `colors` array. Change both.

## Gotchas

- `install.sh` *copies* files (it doesn't link the repo, so a feature branch checked out here never goes live by accident). Edits reach agents only after a re-run, which replaces the store copy in place and leaves no backup. Git holds the history.
- Never leave anything named `agent-room*` beside the link in `~/.codex/skills` or `~/.claude/skills`: agents load every folder there as a skill. The installer moves an old real copy, and any `agent-room.backup-*`, to `~/.agents/agent-room-old-installs/<run>/` (durable, outside every skills dir). If an agent's skills dir is itself a link to the store, it skips that link instead of looping the store onto itself.
- SKILL.md's `ROOM_CLI` points at `$HOME/.agents/skills/agent-room/...`. With a custom `AGENTS_SKILLS_HOME`, the installer rewrites that line in the installed copy only.
- `~/.agents/skills` is its own local git repo, so a reinstall shows up there as a diff in `agent-room/`. Commit just that folder.
- Argument parsing (`argsOf`): flags in `VALUE_FLAGS` (`title`, `objective`, `name`, `user-name`, `message`, `message-file`, `summary`, `summary-file`) always take the next token, even one starting with `--`, and error if it's missing. `textArg()` resolves `--message`/`--summary` from the flag, from `--*-file <path>`, or from stdin when the value is `-`, so free text can bypass the shell. `--key=value` works too. Any new flag that takes free text belongs in `VALUE_FLAGS`. `--wait` alone means the 45s default (`waitSeconds()`); a non-number is an error.
- The server binds `127.0.0.1` by default. `AGENT_ROOM_HOST` can override it, but there's no auth, so don't expose it.
