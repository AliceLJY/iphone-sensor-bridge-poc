#!/usr/bin/env bash
set -euo pipefail

label="com.alice.iphone-sensor-bridge-poc"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_dir="$(cd -- "$script_dir/.." && pwd -P)"
home_dir="${HOME:?HOME must be set}"
plist_src="$repo_dir/launchd/$label.plist"
launch_agents_dir="$home_dir/Library/LaunchAgents"
logs_dir="$home_dir/Library/Logs"
plist_dst="$launch_agents_dir/$label.plist"
plist_tmp="${plist_dst}.new.$$"
token_file="${BRIDGE_TOKEN_FILE:-$home_dir/.config/iphone-sensor-bridge-poc/token}"
token_dir="$(dirname "$token_file")"
token_tmp="${token_file}.new.$$"
inbox="${BRIDGE_INBOX:-$home_dir/Desktop/iphone-sensor-inbox-v2}"
stdout_log="$logs_dir/iphone-sensor-bridge-poc.log"
stderr_log="$logs_dir/iphone-sensor-bridge-poc.err.log"
node_bin="${BRIDGE_NODE_BIN:-$(command -v node || true)}"
uid="$(id -u)"
token="${BRIDGE_TOKEN:-}"
listen_hosts="${BRIDGE_LISTEN_HOSTS:-}"

cleanup() {
  local candidate destination
  mkdir -p "$HOME/.Trash"
  for candidate in "$plist_tmp" "$token_tmp"; do
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      destination="$HOME/.Trash/$(basename "$candidate").failed-$(date +%s)-$$"
      mv "$candidate" "$destination" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

if [[ -z "$token" ]]; then
  if [[ ! -t 0 ]]; then
    echo "BRIDGE_TOKEN is required for a non-interactive install." >&2
    exit 1
  fi
  printf "Enter BRIDGE_TOKEN (input hidden): " >&2
  IFS= read -r -s token
  printf "\n" >&2
fi

if [[ ${#token} -lt 32 ]]; then
  echo "BRIDGE_TOKEN must be at least 32 characters." >&2
  exit 1
fi
if [[ ! "$token" =~ ^[A-Za-z0-9._~+/-]+={0,}$ ]]; then
  echo "BRIDGE_TOKEN contains characters that cannot be used safely in a Bearer header." >&2
  exit 1
fi
if [[ "$token_file" == *$'\n'* || "$token_file" == *$'\r'* ]]; then
  echo "BRIDGE_TOKEN_FILE must not contain line breaks." >&2
  exit 1
fi
if [[ "$token_file" != /* ]]; then
  echo "BRIDGE_TOKEN_FILE must be an absolute path." >&2
  exit 1
fi
if [[ "$listen_hosts" == *$'\n'* || "$listen_hosts" == *$'\r'* ]]; then
  echo "BRIDGE_LISTEN_HOSTS must not contain line breaks." >&2
  exit 1
fi
if [[ "$inbox" != /* || "$inbox" == *$'\n'* || "$inbox" == *$'\r'* ]]; then
  echo "BRIDGE_INBOX must be an absolute path without line breaks." >&2
  exit 1
fi
if [[ "$node_bin" != /* || ! -x "$node_bin" ]]; then
  echo "BRIDGE_NODE_BIN must resolve to an executable absolute path." >&2
  exit 1
fi

mkdir -p "$inbox" "$launch_agents_dir" "$logs_dir"
if [[ -L "$token_dir" ]]; then
  echo "BRIDGE_TOKEN_FILE parent must not be a symbolic link." >&2
  exit 1
fi
mkdir -p "$token_dir"
if [[ "$(/usr/bin/stat -f '%u' "$token_dir")" != "$uid" ]]; then
  echo "BRIDGE_TOKEN_FILE parent must be owned by the current user." >&2
  exit 1
fi
chmod 700 "$token_dir"
umask 077
printf '%s' "$token" > "$token_tmp"
chmod 600 "$token_tmp"
mv "$token_tmp" "$token_file"

cp "$plist_src" "$plist_tmp"
# plutil's numeric key path inserts into arrays even with -replace, so remove
# each template slot before inserting the rendered value at the same index.
/usr/bin/plutil -remove ProgramArguments.0 "$plist_tmp"
/usr/bin/plutil -insert ProgramArguments.0 -string "$node_bin" "$plist_tmp"
/usr/bin/plutil -remove ProgramArguments.1 "$plist_tmp"
/usr/bin/plutil -insert ProgramArguments.1 -string "$repo_dir/server.js" "$plist_tmp"
/usr/bin/plutil -replace WorkingDirectory -string "$repo_dir" "$plist_tmp"
/usr/bin/plutil -replace EnvironmentVariables.INBOX -string "$inbox" "$plist_tmp"
/usr/bin/plutil -replace EnvironmentVariables.BRIDGE_TOKEN_FILE -string "$token_file" "$plist_tmp"
/usr/bin/plutil -replace StandardOutPath -string "$stdout_log" "$plist_tmp"
/usr/bin/plutil -replace StandardErrorPath -string "$stderr_log" "$plist_tmp"
if [[ -n "$listen_hosts" ]]; then
  /usr/bin/plutil -replace EnvironmentVariables.HOSTS -string "$listen_hosts" "$plist_tmp"
fi
chmod 600 "$plist_tmp"
mv "$plist_tmp" "$plist_dst"
unset token BRIDGE_TOKEN

launchctl bootout "gui/$uid" "$plist_dst" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$plist_dst"
launchctl enable "gui/$uid/$label"
launchctl kickstart -k "gui/$uid/$label"
launchctl print "gui/$uid/$label" >/dev/null
echo "Installed and started $label with a private token file; the LaunchAgent plist contains no token value."
