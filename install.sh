#!/usr/bin/env bash
# Installs the skill once into the shared skills store, then links each agent's skills dir to it.
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# Resolve the store to an absolute path, so ROOM_CLI and the links never depend on the cwd.
mkdir -p "${AGENTS_SKILLS_HOME:-$HOME/.agents/skills}"
SKILLS_ROOT="$(cd "${AGENTS_SKILLS_HOME:-$HOME/.agents/skills}" && pwd -P)"
SKILL_DIR="$SKILLS_ROOT/agent-room"
DEFAULT_ROOT="$(cd "$HOME/.agents/skills" 2>/dev/null && pwd -P || true)"
case "$SKILL_DIR" in
  *[\"\$\`\\]*) echo "The skills store path can't contain quotes, \$, backticks or backslashes: $SKILL_DIR" >&2; exit 1 ;;
esac

# Old copies leave the skills dirs (agents load every folder there) but stay on disk, outside them.
OLD_ROOT="$(dirname "$SKILLS_ROOT")/agent-room-old-installs"
RUN_DIR=""
move_out() {
  if [ -z "$RUN_DIR" ]; then
    mkdir -p "$OLD_ROOT"
    RUN_DIR="$(mktemp -d "$OLD_ROOT/$STAMP.XXXXXX")"
  fi
  local dest="$RUN_DIR/${1//\//_}"
  mv "$1" "$dest"
  echo "Moved $1 to $dest"
}

STAGE=""
PREVIOUS=""
cleanup() { if [ -n "$STAGE" ] && [ -e "$STAGE" ]; then rm -r "$STAGE"; fi; }
trap cleanup EXIT

SOURCE_REAL="$(cd "$SOURCE_DIR" && pwd -P)"
SKILL_REAL=""
[ -d "$SKILL_DIR" ] && SKILL_REAL="$(cd "$SKILL_DIR" && pwd -P)"

# 1. The one real copy lives in the store. Skip when the checkout itself is the store copy.
if [ "$SOURCE_REAL" != "$SKILL_REAL" ]; then
  STAGE="$(mktemp -d "$SKILLS_ROOT/.agent-room-install.XXXXXX")"
  for file in "${FILES[@]}"; do
    mkdir -p "$STAGE/$(dirname "$file")"
    cp "$SOURCE_DIR/$file" "$STAGE/$file"
  done
  chmod 755 "$STAGE"
  chmod +x "$STAGE/scripts/agent_room.mjs"
  if [ "$SKILLS_ROOT" != "$DEFAULT_ROOT" ]; then
    # SKILL.md tells agents where the CLI lives; point it at the custom store.
    replacement="$(printf '%s' "$SKILL_DIR/scripts/agent_room.mjs" | sed 's/[&|]/\\&/g')"
    sed -i.orig "s|^ROOM_CLI=.*|ROOM_CLI=\"$replacement\"|" "$STAGE/SKILL.md"
    rm "$STAGE/SKILL.md.orig"
  fi

  # Swap: set the old copy aside, move the new one in, and only then delete the old one.
  if [ -L "$SKILL_DIR" ]; then
    echo "Replaced $SKILL_DIR (was a link to $(readlink "$SKILL_DIR"))"
  fi
  if [ -e "$SKILL_DIR" ] || [ -L "$SKILL_DIR" ]; then
    PREVIOUS="$(mktemp -d "$SKILLS_ROOT/.agent-room-previous.XXXXXX")"
    mv "$SKILL_DIR" "$PREVIOUS/agent-room"
  fi
  if ! mv "$STAGE" "$SKILL_DIR"; then
    [ -n "$PREVIOUS" ] && mv "$PREVIOUS/agent-room" "$SKILL_DIR" && rmdir "$PREVIOUS"
    echo "Could not move the new copy into $SKILL_DIR; the previous install is back in place." >&2
    exit 1
  fi
  STAGE=""
  if [ -n "$PREVIOUS" ]; then
    rm -r "$PREVIOUS" || echo "Warning: could not remove the previous copy at $PREVIOUS" >&2
  fi
fi

# 2. Each agent's skills dir gets a link.
for link in "${LINKS[@]}"; do
  parent="$(dirname "$link")"
  mkdir -p "$parent"
  if [ "$(cd "$parent" && pwd -P)" = "$SKILLS_ROOT" ]; then
    echo "Skipped $link: $parent is the skills store itself."
    continue
  fi
  for stale in "$parent"/agent-room.backup-*; do
    if [ -e "$stale" ] || [ -L "$stale" ]; then move_out "$stale"; fi
  done
  if [ -L "$link" ]; then
    target="$(readlink "$link")"
    [ "$target" != "$SKILL_DIR" ] && echo "Replaced $link (was a link to $target)"
    rm "$link"
  elif [ -e "$link" ]; then
    move_out "$link"
  fi
  ln -s "$SKILL_DIR" "$link"
done

echo
echo "Agent Room installed."
echo "Skill:  $SKILL_DIR"
for link in "${LINKS[@]}"; do [ -L "$link" ] && echo "Link:   $link -> $SKILL_DIR"; done
echo
echo "Restart Codex and Claude Code to refresh their skill lists."
