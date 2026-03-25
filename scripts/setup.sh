#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# KinthAI Plugin Setup Script
#
# Usage:
#   bash setup-kinthai.sh <email> [agent_id]
#
#   email     — human owner's email (required)
#   agent_id  — specific agent to register (optional; if omitted, ALL agents register)
#
# Examples:
#   bash setup-kinthai.sh alice@example.com              # all agents
#   bash setup-kinthai.sh alice@example.com main          # only "main"
#   bash setup-kinthai.sh alice@example.com code-reviewer # only "code-reviewer"
#
# The script will:
#   1. Auto-detect the OpenClaw config directory and machine ID
#   2. Download & install the KinthAI channel plugin (if not already installed)
#   3. Register agent(s) and save API keys to .tokens.json
#   4. Update openclaw.json config
#   5. Signal OpenClaw to restart
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

KINTHAI_URL="${KINTHAI_URL:-https://kinthai.ai}"

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "${CYAN}==>${NC} $*"; }

# ── Args ──
if [[ $# -lt 1 ]]; then
  echo "Usage: bash setup-kinthai.sh <email> [agent_id]"
  echo "  email     — human owner email (required)"
  echo "  agent_id  — specific agent (optional; omit to register all agents)"
  exit 1
fi

EMAIL="$1"
SPECIFIC_AGENT="${2:-}"

# ── Validate email ──
if [[ ! "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  error "Invalid email: $EMAIL"
  exit 1
fi

# ── Find OpenClaw directory ──
step "Detecting OpenClaw directory..."

OPENCLAW_DIR=""
# Common locations
for candidate in \
  "$HOME/.openclaw" \
  "/home/ubuntu/.openclaw" \
  "/home/claw/.openclaw" \
  "/root/.openclaw"; do
  if [[ -f "$candidate/identity/device.json" ]]; then
    OPENCLAW_DIR="$candidate"
    break
  fi
done

# Fallback: search
if [[ -z "$OPENCLAW_DIR" ]]; then
  found=$(find / -maxdepth 5 -name "device.json" -path "*/.openclaw/identity/*" 2>/dev/null | head -1)
  if [[ -n "$found" ]]; then
    OPENCLAW_DIR="$(dirname "$(dirname "$found")")"
  fi
fi

if [[ -z "$OPENCLAW_DIR" || ! -f "$OPENCLAW_DIR/identity/device.json" ]]; then
  error "Could not find OpenClaw directory (no identity/device.json found)"
  error "Make sure OpenClaw is installed and has been initialized"
  exit 1
fi

info "OpenClaw directory: $OPENCLAW_DIR"

# ── Read machine ID ──
step "Reading machine ID..."

MACHINE_ID=$(python3 -c "import json; print(json.load(open('$OPENCLAW_DIR/identity/device.json'))['deviceId'])" 2>/dev/null || true)

if [[ -z "$MACHINE_ID" ]]; then
  # Fallback: use jq or grep
  if command -v jq &>/dev/null; then
    MACHINE_ID=$(jq -r '.deviceId' "$OPENCLAW_DIR/identity/device.json")
  else
    MACHINE_ID=$(grep -o '"deviceId"[[:space:]]*:[[:space:]]*"[^"]*"' "$OPENCLAW_DIR/identity/device.json" | head -1 | sed 's/.*"deviceId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  fi
fi

if [[ -z "$MACHINE_ID" || "$MACHINE_ID" == "null" ]]; then
  error "Could not read deviceId from $OPENCLAW_DIR/identity/device.json"
  exit 1
fi

info "Machine ID: ${MACHINE_ID:0:16}..."

# ── Collect agents to register ──
step "Collecting agents..."

AGENTS=()
if [[ -n "$SPECIFIC_AGENT" ]]; then
  AGENTS=("$SPECIFIC_AGENT")
  info "Target agent: $SPECIFIC_AGENT"
else
  AGENTS_DIR="$OPENCLAW_DIR/agents"
  if [[ -d "$AGENTS_DIR" ]]; then
    for agent_dir in "$AGENTS_DIR"/*/; do
      agent_name=$(basename "$agent_dir")
      AGENTS+=("$agent_name")
    done
  fi
  # Always include "main" if not already in the list
  if [[ ${#AGENTS[@]} -eq 0 ]]; then
    AGENTS=("main")
    warn "No agents directory found, defaulting to 'main'"
  else
    info "Found ${#AGENTS[@]} agent(s)"
  fi
fi

# ── Check/install plugin files ──
PLUGIN_DIR="$OPENCLAW_DIR/channels/kinthai"
TOKENS_FILE="$PLUGIN_DIR/.tokens.json"

step "Checking plugin installation..."

if [[ -f "$PLUGIN_DIR/index.js" ]]; then
  info "Plugin already installed at $PLUGIN_DIR"
else
  step "Downloading plugin files from $KINTHAI_URL ..."

  # Get file list
  VERSION_INFO=$(curl -fsSL "$KINTHAI_URL/api/v1/plugin/latest-version" 2>/dev/null)
  if [[ -z "$VERSION_INFO" ]]; then
    error "Could not reach $KINTHAI_URL/api/v1/plugin/latest-version"
    exit 1
  fi

  DOWNLOAD_URL=$(echo "$VERSION_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin)['download_url'])" 2>/dev/null || true)
  PLUGIN_VERSION=$(echo "$VERSION_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])" 2>/dev/null || true)

  if [[ -z "$DOWNLOAD_URL" ]]; then
    # Fallback parse
    DOWNLOAD_URL="/openclaw/channels/kinthai/"
  fi

  # Parse file list
  FILES=$(echo "$VERSION_INFO" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for f in data.get('files', []):
    print(f)
" 2>/dev/null)

  if [[ -z "$FILES" ]]; then
    error "Could not parse plugin file list"
    exit 1
  fi

  mkdir -p "$PLUGIN_DIR"

  FAIL=0
  while IFS= read -r filename; do
    [[ -z "$filename" ]] && continue
    url="${KINTHAI_URL}${DOWNLOAD_URL}${filename}"
    if curl -fsSL "$url" -o "$PLUGIN_DIR/$filename" 2>/dev/null; then
      info "  Downloaded: $filename"
    else
      error "  Failed to download: $filename"
      FAIL=1
    fi
  done <<< "$FILES"

  if [[ $FAIL -eq 1 ]]; then
    error "Some files failed to download"
    exit 1
  fi

  info "Plugin v${PLUGIN_VERSION:-unknown} installed to $PLUGIN_DIR"
fi

# ── Register agents and build tokens ──
step "Registering agents with KinthAI..."

# Load existing tokens
if [[ -f "$TOKENS_FILE" ]]; then
  TOKENS_JSON=$(cat "$TOKENS_FILE")
else
  TOKENS_JSON='{}'
fi

REGISTERED=0
SKIPPED=0
FAILED=0

for agent_id in "${AGENTS[@]}"; do
  # Check if already has a token
  existing_token=$(echo "$TOKENS_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('$agent_id', ''))
" 2>/dev/null || true)

  if [[ -n "$existing_token" && "$existing_token" != "None" ]]; then
    info "  $agent_id — already has token, skipping"
    ((SKIPPED++)) || true
    continue
  fi

  # Register via API
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$KINTHAI_URL/api/v1/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"email\": \"$EMAIL\",
      \"openclaw_machine_id\": \"$MACHINE_ID\",
      \"openclaw_agent_id\": \"$agent_id\"
    }" 2>/dev/null)

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]]; then
    API_KEY=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])" 2>/dev/null || true)
    if [[ -n "$API_KEY" && "$API_KEY" != "None" ]]; then
      # Add token to JSON
      TOKENS_JSON=$(echo "$TOKENS_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
data['$agent_id'] = '$API_KEY'
print(json.dumps(data, indent=2))
")
      info "  $agent_id — registered successfully"
      ((REGISTERED++)) || true
    else
      error "  $agent_id — registered but no api_key in response"
      ((FAILED++)) || true
    fi
  elif [[ "$HTTP_CODE" == "409" ]]; then
    warn "  $agent_id — already registered (409), no api_key available"
    warn "    If you lost the key, contact the KinthAI admin"
    ((SKIPPED++)) || true
  elif [[ "$HTTP_CODE" == "403" ]]; then
    error "  $agent_id — machine owner mismatch (403). This machine is bound to a different email."
    error "    Response: $BODY"
    ((FAILED++)) || true
  else
    error "  $agent_id — registration failed (HTTP $HTTP_CODE)"
    error "    Response: $BODY"
    ((FAILED++)) || true
  fi
done

# ── Save tokens file ──
step "Saving tokens..."

# Ensure metadata fields exist
TOKENS_JSON=$(echo "$TOKENS_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
data['_machine_id'] = '$MACHINE_ID'
data['_email'] = '$EMAIL'
data['_kinthai_url'] = '$KINTHAI_URL'
# Move metadata fields to top
ordered = {}
for k in sorted(data.keys()):
    if k.startswith('_'):
        ordered[k] = data[k]
for k in sorted(data.keys()):
    if not k.startswith('_'):
        ordered[k] = data[k]
print(json.dumps(ordered, indent=2))
")

echo "$TOKENS_JSON" > "$TOKENS_FILE"
info "Tokens saved to $TOKENS_FILE"

# ── Update openclaw.json ──
step "Updating openclaw.json..."

OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"

if [[ -f "$OPENCLAW_JSON" ]]; then
  python3 -c "
import json, sys

with open('$OPENCLAW_JSON', 'r') as f:
    cfg = json.load(f)

changed = False

# Add channels.kinthai
if 'channels' not in cfg:
    cfg['channels'] = {}
if 'kinthai' not in cfg['channels']:
    ws_url = '$KINTHAI_URL'.replace('https://', 'wss://').replace('http://', 'ws://')
    cfg['channels']['kinthai'] = {
        'url': '$KINTHAI_URL',
        'wsUrl': ws_url
    }
    changed = True

# Add plugin load path
plugin_path = '$PLUGIN_DIR'
if 'plugins' not in cfg:
    cfg['plugins'] = {}
if 'load' not in cfg['plugins']:
    cfg['plugins']['load'] = {}
if 'paths' not in cfg['plugins']['load']:
    cfg['plugins']['load']['paths'] = []

paths = cfg['plugins']['load']['paths']
if plugin_path not in paths:
    paths.append(plugin_path)
    changed = True

if changed:
    with open('$OPENCLAW_JSON', 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print('updated')
else:
    print('no_change')
" 2>/dev/null
  result=$?
  if [[ $result -eq 0 ]]; then
    info "openclaw.json updated"
  else
    error "Failed to update openclaw.json"
  fi
else
  warn "openclaw.json not found at $OPENCLAW_JSON — you may need to configure it manually"
fi

# ── Restart OpenClaw ──
step "Signaling OpenClaw to restart..."

RESTART_FILE="$OPENCLAW_DIR/workspace/.restart-openclaw"
mkdir -p "$(dirname "$RESTART_FILE")"

# Try Docker signal file first, then systemd
if echo "kinthai-setup $(date -Iseconds)" > "$RESTART_FILE" 2>/dev/null; then
  info "Restart signal written (Docker mode)"
elif systemctl is-active --quiet openclaw 2>/dev/null; then
  sudo systemctl restart openclaw 2>/dev/null && info "OpenClaw restarted (systemd)" || warn "Could not restart OpenClaw via systemctl"
elif systemctl --user is-active --quiet openclaw-gateway 2>/dev/null; then
  systemctl --user restart openclaw-gateway 2>/dev/null && info "OpenClaw restarted (user systemd)" || warn "Could not restart OpenClaw"
else
  warn "Could not auto-restart OpenClaw. Please restart it manually."
fi

# ── Summary ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e " KinthAI Plugin Setup Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e " Registered: ${GREEN}$REGISTERED${NC}  Skipped: ${YELLOW}$SKIPPED${NC}  Failed: ${RED}$FAILED${NC}"
echo -e " Total agents: ${#AGENTS[@]}"
echo -e " KinthAI URL: $KINTHAI_URL"
echo -e " Tokens file: $TOKENS_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
