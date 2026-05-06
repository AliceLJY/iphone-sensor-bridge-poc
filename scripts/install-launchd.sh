#!/usr/bin/env bash
set -euo pipefail

label="com.alice.iphone-sensor-bridge-poc"
repo_dir="/Users/USER/Projects/iphone-sensor-bridge-poc"
plist_src="$repo_dir/launchd/$label.plist"
plist_dst="/Users/USER/Library/LaunchAgents/$label.plist"
uid="$(id -u)"

mkdir -p "/Users/USER/Desktop/iphone-sensor-inbox-v2"
mkdir -p "/Users/USER/Library/LaunchAgents" "/Users/USER/Library/Logs"
cp "$plist_src" "$plist_dst"

launchctl bootout "gui/$uid" "$plist_dst" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$plist_dst"
launchctl enable "gui/$uid/$label"
launchctl kickstart -k "gui/$uid/$label"
launchctl print "gui/$uid/$label" | sed -n '1,80p'
