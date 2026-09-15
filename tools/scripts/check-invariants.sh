#!/usr/bin/env bash
# Standing architectural invariants (ARCHITECTURE.md §7).
# These are the architecture expressed as tests. They run on every commit.
set -uo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
fail=0

# Only source files. Docs and tests may legitimately name vendors.
SRC_GLOBS=(--include='*.ts' --include='*.tsx')
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=.turbo)

check() {
  local id="$1" desc="$2" pattern="$3"; shift 3
  local dirs=("$@") hits
  local existing=()
  for d in "${dirs[@]}"; do [ -d "$d" ] && existing+=("$d"); done
  if [ ${#existing[@]} -eq 0 ]; then
    printf '  %s%s %s %s(no such dirs yet — skipped)%s\n' "$DIM" "$id" "$desc" "$DIM" "$RESET"
    return 0
  fi
  hits=$(grep -rniE "$pattern" "${SRC_GLOBS[@]}" "${EXCLUDES[@]}" "${existing[@]}" 2>/dev/null \
         | grep -v '\.test\.ts:' || true)
  if [ -n "$hits" ]; then
    printf '%s✗ %s %s%s\n' "$RED" "$id" "$desc" "$RESET"
    printf '%s\n' "$hits" | sed 's/^/    /'
    fail=1
  else
    printf '%s✓%s %s %s\n' "$GREEN" "$RESET" "$id" "$desc"
  fi
}

echo "Architectural invariants"
echo

# I1 — the runtime names no integration. (AC-11)
check "I1 " "runtime/core name no integration" \
  '\b(gmail|telegram|notion|github|slack|discord|jira|linear|salesforce)\b' \
  packages/runtime packages/core

# I2 — the runtime names no AI provider. (AC-12)
#      This is why ProviderType is an opaque string in core and the
#      enumeration lives in packages/providers/registry.
check "I2 " "runtime/core name no AI provider" \
  '\b(anthropic|openai|gemini|google|bedrock|vertex|mistral|cohere|ollama)\b' \
  packages/runtime packages/core

# I3 — nothing below the composition root knows the deployment platform. (AC-13)
check "I3 " "runtime/core/mcp/db name no platform" \
  '(@vercel/|[^a-z]vercel[^a-z]|\bvercel\b)' \
  packages/runtime packages/core packages/mcp packages/db

# I4 — the MongoDB driver is importable only from packages/db.
check "I4 " "mongodb imported only in packages/db" \
  "from ['\"]mongodb['\"]|require\\(['\"]mongodb['\"]\\)" \
  packages/core packages/runtime packages/mcp packages/crypto \
  packages/contracts packages/observability packages/channels apps

# I5 — the MCP SDK is importable only from packages/mcp.
check "I5 " "@modelcontextprotocol imported only in packages/mcp" \
  "from ['\"]@modelcontextprotocol/" \
  packages/core packages/runtime packages/db packages/crypto \
  packages/contracts packages/observability apps

# I6 — provider SDKs are importable only from their own adapter packages.
check "I6 " "provider SDKs confined to adapters" \
  "from ['\"](@anthropic-ai/sdk|openai|@google/genai)['\"]" \
  packages/core packages/runtime packages/mcp packages/db apps

# I7 — every provider adapter runs the shared conformance suite. (AC-14)
#      Without this, a fourth adapter can be added that quietly skips it, and
#      "all adapters pass the identical suite" stops being true the moment
#      nobody is looking.
if [ -d packages/providers ]; then
  missing=""
  for dir in packages/providers/*/; do
    name=$(basename "$dir")
    case "$name" in testkit|registry) continue ;; esac
    if ! grep -rqs "runConformanceSuite" "$dir"; then
      missing="$missing $name"
    fi
  done
  if [ -n "$missing" ]; then
    printf '%s✗ %s %s%s\n' "$RED" "I7 " "adapters missing the conformance suite:$missing" "$RESET"
    fail=1
  else
    printf '%s✓%s %s %s\n' "$GREEN" "$RESET" "I7 " "every provider adapter runs the conformance suite"
  fi
fi

echo
if [ "$fail" -ne 0 ]; then
  printf '%sInvariant violation — this is an architecture failure, not a lint nit.%s\n' "$RED" "$RESET"
  printf '%sSee ARCHITECTURE.md §7.%s\n' "$DIM" "$RESET"
  exit 1
fi
printf '%sAll invariants hold.%s\n' "$GREEN" "$RESET"
