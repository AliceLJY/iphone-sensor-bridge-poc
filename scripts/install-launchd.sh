#!/usr/bin/env bash
set -euo pipefail

label="com.alice.iphone-sensor-bridge-poc"
repo_dir="/Users/USER/Projects/iphone-sensor-bridge-poc"
plist_src="$repo_dir/launchd/$label.plist"
plist_dst="/Users/USER/Library/LaunchAgents/$label.plist"
plist_tmp="${plist_dst}.new.$$"
token_file="${BRIDGE_TOKEN_FILE:-/Users/USER/.config/iphone-sensor-bridge-poc/token}"
token_dir="$(dirname "$token_file")"
token_tmp="${token_file}.new.$$"
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
if [[ "$listen_hosts" == *$'\n'* || "$listen_hosts" == *$'\r'* ]]; then
  echo "BRIDGE_LISTEN_HOSTS must not contain line breaks." >&2
  exit 1
fi

mkdir -p "/Users/USER/Desktop/iphone-sensor-inbox-v2"
mkdir -p "/Users/USER/Library/LaunchAgents" "/Users/USER/Library/Logs"
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
/usr/bin/plutil -replace EnvironmentVariables.BRIDGE_TOKEN_FILE -string "$token_file" "$plist_tmp"
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
