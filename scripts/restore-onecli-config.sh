#!/usr/bin/env bash
# Restores OneCLI config files from the repo into ~/.onecli/
# Run this after a fresh install or environment migration.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ONECLI_DIR="$HOME/.onecli"

if [ ! -d "$ONECLI_DIR" ]; then
  echo "Error: ~/.onecli does not exist. Run 'onecli init' first."
  exit 1
fi

echo "Restoring OneCLI config from $REPO_DIR/config/onecli/ ..."

cp "$REPO_DIR/config/onecli/docker-compose.override.yml" "$ONECLI_DIR/docker-compose.override.yml"

# Merge .env (add lines not already present)
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  if grep -q "^${key}=" "$ONECLI_DIR/.env" 2>/dev/null; then
    echo "  Skipping $key (already set)"
  else
    echo "$line" >> "$ONECLI_DIR/.env"
    echo "  Added $key"
  fi
done < "$REPO_DIR/config/onecli/env.conf"

echo "Done. Restart OneCLI to apply:"
echo "  docker compose -p onecli -f ~/.onecli/docker-compose.yml -f ~/.onecli/docker-compose.override.yml up -d --force-recreate"
