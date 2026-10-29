#!/usr/bin/env bash
# Install a bare dsh (npm, no FlyBot) into an isolated prefix + DSH_HOME, add this adapter
# to the headless and web profiles, and point the default agent model at Jiuwen.
#   BARE=/tmp/bare-dsh scripts/bare-dsh.sh            # setup
#   then: DSH_HOME=$BARE/home $BARE/prefix/bin/dsh --profile headless "hello"
#         DSH_HOME=$BARE/home $BARE/prefix/bin/dsh --profile web --no-open --port 3291
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BARE="${BARE:-$PWD/bare-dsh}"
DSH_VERSION="${DSH_VERSION:-latest}"
mkdir -p "$BARE"
npm install -g --prefix "$BARE/prefix" "@deepseek-ai/dsh@$DSH_VERSION"
export DSH_HOME="$BARE/home" PATH="$BARE/prefix/bin:$PATH"
for profile in headless web; do
  dsh plugin --profile "$profile" add "$ROOT"
  cat > "$DSH_HOME/profiles/$profile/cordis.patch.yml" <<'YML'
- id: agent-default-model
  config:
    provider: jiuwen
    model: jiuwen-default
- id: llm-jiuwen
  config:
    compat: none
YML
done
echo "bare dsh ready: DSH_HOME=$DSH_HOME dsh=$BARE/prefix/bin/dsh ($(dsh --version))"
