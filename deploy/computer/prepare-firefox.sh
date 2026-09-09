#!/bin/sh
set -eu
profiles=/home/cua/workspace/.browser-profiles/firefox
mkdir -p "$profiles"
chmod 0700 "$profiles" 2>/dev/null || test -w "$profiles"
if [ -d "$HOME/.mozilla" ] && [ ! -L "$HOME/.mozilla" ] && [ -z "$(ls -A "$profiles")" ]; then
  cp -a "$HOME/.mozilla/." "$profiles/"
fi
rm -rf "$HOME/.mozilla"
ln -s "$profiles" "$HOME/.mozilla"
find "$profiles" \( -name .parentlock -o -name parent.lock -o -name lock \) -delete
