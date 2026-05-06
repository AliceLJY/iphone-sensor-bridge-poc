#!/usr/bin/env bash
set -euo pipefail

label="com.alice.iphone-sensor-bridge-poc"
repo_dir="/Users/anxianjingya/Projects/iphone-sensor-bridge-poc"
plist_src="$repo_dir/launchd/$label.plist"
plist_dst="/Users/anxianjingya/Library/LaunchAgents/$label.plist"
uid="$(id -u)"

mkdir -p "/Users/anxianjingya/Desktop/iphone-sensor-inbox-v2"
mkdir -p "/Users/anxianjingya/Library/LaunchAgents" "/Users/anxianjingya/Library/Logs"
cp "$plist_src" "$plist_dst"

launchctl bootout "gui/$uid" "$plist_dst" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$plist_dst"
launchctl enable "gui/$uid/$label"
launchctl kickstart -k "gui/$uid/$label"
launchctl print "gui/$uid/$label" | sed -n '1,80p'
