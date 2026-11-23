#!/usr/bin/env bash
# Installs the skill once into the shared skills store, then links each agent's skills dir to it.
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_ROOT="${AGENTS_SKILLS_HOME:-$HOME/.agents/skills}"
SKILL_DIR="$SKILLS_ROOT/agent-room"
DEFAULT_SKILL_DIR="$HOME/.agents/skills/agent-room"
LINKS=("${CODEX_HOME:-$HOME/.codex}/skills/agent-room" "${CLAUDE_HOME:-$HOME/.claude}/skills/agent-room")
FILES=(SKILL.md agents/openai.yaml scripts/agent_room.mjs)
STAMP="$(date +%Y%m%d-%H%M%S)"

if ! command -v bun >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  echo "Agent Room requires Bun or Node.js 20+." >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$NODE_MAJOR" -lt 20 ] && ! command -v bun >/dev/null 2>&1; then
    echo "Agent Room requires Bun or Node.js 20+. Found Node.js $(node --version)." >&2
    exit 1
  fi
fi

mkdir -p "$SKILLS_ROOT"
SOURCE_REAL="$(cd "$SOURCE_DIR" && pwd -P)"
SKILL_REAL=""
[ -d "$SKILL_DIR" ] && SKILL_REAL="$(cd "$SKILL_DIR" && pwd -P)"

# 1. The one real copy lives in the shared store. Skip when the checkout itself is the store copy.
if [ "$SOURCE_REAL" != "$SKILL_REAL" ]; then
  STAGE="$(mktemp -d "$SKILLS_ROOT/.agent-room-install.XXXXXX")"
  for file in "${FILES[@]}"; do
    mkdir -p "$STAGE/$(dirname "$file")"
    cp "$SOURCE_DIR/$file" "$STAGE/$file"
  done
  chmod 755 "$STAGE"
  chmod +x "$STAGE/scripts/agent_room.mjs"
  if [ "$SKILL_DIR" != "$DEFAULT_SKILL_DIR" ]; then
    # SKILL.md tells agents where the CLI lives; point it at the custom store.
    sed -i.orig "s|^ROOM_CLI=.*|ROOM_CLI=\"$SKILL_DIR/scripts/agent_room.mjs\"|" "$STAGE/SKILL.md"
    rm "$STAGE/SKILL.md.orig"
  fi
  if [ -L "$SKILL_DIR" ]; then
    rm "$SKILL_DIR"
  elif [ -e "$SKILL_DIR" ]; then
    rm -r "$SKILL_DIR"
  fi
  mv "$STAGE" "$SKILL_DIR"
fi

# 2. Each agent's skills dir gets a link. An older install left a real copy here, so move it
#    out of the skills dir entirely: anything left beside the link would load as a second skill.
for link in "${LINKS[@]}"; do
  mkdir -p "$(dirname "$link")"
  if [ -L "$link" ]; then
    rm "$link"
  elif [ -e "$link" ]; then
    moved="${TMPDIR:-/tmp}/agent-room-old-install-$STAMP-$(basename "$(dirname "$(dirname "$link")")")"
    mv "$link" "$moved"
    echo "Moved the old copy at $link to $moved"
  fi
  ln -s "$SKILL_DIR" "$link"
done

echo
echo "Agent Room installed."
echo "Skill:  $SKILL_DIR"
for link in "${LINKS[@]}"; do echo "Link:   $link -> $SKILL_DIR"; done
echo
echo "Restart Codex and Claude Code to refresh their skill lists."
