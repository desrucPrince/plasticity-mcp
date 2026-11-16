# Source this file (". ./env.sh") from a shell that already has Node 24 or newer on PATH.
# Set PLASTICITY_CDP_URL (http://127.0.0.1:PORT of the isolated instance) and PLASTICITY_TARGET_ID first;
# harness.ts refuses any host but 127.0.0.1.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
  echo "env.sh: Node 24 or newer must be on PATH (found: $(node --version 2>/dev/null || echo none))" >&2
  return 1 2>/dev/null || exit 1
fi
if [ -z "${PLASTICITY_CDP_URL:-}" ] || [ -z "${PLASTICITY_TARGET_ID:-}" ]; then
  echo "env.sh: set PLASTICITY_CDP_URL and PLASTICITY_TARGET_ID to the isolated Plasticity instance first" >&2
  return 1 2>/dev/null || exit 1
fi
export PLASTICITY_CDP_URL PLASTICITY_TARGET_ID PLASTICITY_AUTO_LAUNCH=0 PLASTICITY_HUD=0
