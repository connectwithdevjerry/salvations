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

# Everywhere a dependency is NOT allowed, computed as "every package and app
# except the ones named".
#
# Written this way round deliberately. These checks used to carry hand-written
# lists of directories to search, and every package added since was silently
# outside all of them — five of them, at one point, with no invariant covering
# any. A denylist rots the moment somebody adds a package and does not think
# about it, which is exactly when an invariant has to hold.
everywhere_but() {
  local allowed=" $* " dir
  for dir in packages/*/ packages/providers/*/ apps/*/; do
    dir="${dir%/}"
    [ -d "$dir" ] || continue
    # Not a package itself, just the folder holding them.
    [ "$dir" = "packages/providers" ] && continue
    case "$allowed" in *" $dir "*) continue ;; esac
    printf '%s\n' "$dir"
  done
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
mapfile -t I4_DIRS < <(everywhere_but packages/db)
check "I4 " "mongodb imported only in packages/db" \
  "from ['\"]mongodb['\"]|require\\(['\"]mongodb['\"]\\)" \
  "${I4_DIRS[@]}"

# I5 — the MCP SDK is importable only from the two packages that speak the
#      protocol: packages/mcp is our CLIENT side, packages/servers our SERVER
#      side. Both are protocol-facing by definition, and keeping the SDK to
#      them is what makes a spec bump a two-package change.
mapfile -t I5_DIRS < <(everywhere_but packages/mcp packages/servers)
check "I5 " "@modelcontextprotocol confined to mcp + servers" \
  "from ['\"]@modelcontextprotocol/" \
  "${I5_DIRS[@]}"

# I6 — provider SDKs are importable only from their own adapter packages.
mapfile -t I6_DIRS < <(everywhere_but \
  packages/providers/anthropic packages/providers/openai packages/providers/google)
check "I6 " "provider SDKs confined to adapters" \
  "from ['\"](@anthropic-ai/sdk|openai|@google/genai)['\"]" \
  "${I6_DIRS[@]}"

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
