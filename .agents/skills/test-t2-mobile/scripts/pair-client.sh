#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <server-port> <base-dir> <mobile-origin> <agent-device-command> <target-args...>" >&2
  exit 2
}

[[ $# -ge 5 ]] || usage

<<<<<<< HEAD
server_port="$1"
base_dir="$2"
mobile_origin="$3"
agent_device_command="$4"
shift 4
=======
platform="$1"
device_id="$2"
server_port="$3"
base_dir="$4"
url_scheme="${5:-t2code-dev}"

case "$platform" in
  ios)
    mobile_origin="http://127.0.0.1:${server_port}"
    ;;
  android)
    mobile_origin="http://10.0.2.2:${server_port}"
    ;;
  *)
    usage
    ;;
esac
>>>>>>> 7b901800f (rebrand: move remaining @t3tools packages to the @t2code namespace)

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! pairing_output="$({
  T3CODE_PORT="$server_port" node apps/server/src/bin.ts auth pairing create \
    --base-dir "$base_dir" \
    --base-url "$mobile_origin" \
    --ttl 15m \
    --label "agent-mobile"
} 2>&1)"; then
  echo "Could not mint a mobile pairing credential." >&2
  exit 1
fi

pairing_url="$(printf '%s\n' "$pairing_output" | sed -n 's/^Pair URL: //p' | tail -n 1)"
if [[ -z "$pairing_url" ]]; then
  echo "Could not parse the mobile pairing URL." >&2
  exit 1
fi

deep_link="$(PAIRING_URL="$pairing_url" node - <<'NODE'
const query = new URLSearchParams({
  pairingUrl: process.env.PAIRING_URL,
  autoConnect: "1",
});
process.stdout.write(`t3code-dev://connections/new?${query}`);
NODE
)"

if ! "$agent_device_command" open codes.t2.mobile.dev "$deep_link" "$@" \
  >/dev/null 2>&1; then
  echo "AgentDevice could not open the pairing route. Check the Device panel and retry with a fresh credential." >&2
  exit 1
fi

echo "Opened the existing Add Environment route with a fresh pairing credential."
