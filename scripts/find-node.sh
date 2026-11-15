#!/bin/sh
# Prints the path of a node binary, for the callers that run outside a
# shell and so have the app's PATH, not yours: the helper app at tap time
# (helper/CmuxCockpit.applescript) and scripts/pr-poll.sh. Finding it each
# time, rather than baking one path in, keeps them working after a Node
# upgrade. The one list of places tried, in order:
#
#   1. node on PATH
#   2. fnm's default alias ($FNM_DIR, ~/.local/share/fnm, or
#      ~/Library/Application Support/fnm)
#   3. nvm's default alias if it names an installed version, else the
#      latest installed ($NVM_DIR, or ~/.nvm)
#   4. volta ($VOLTA_HOME, or ~/.volta)
#   5. asdf's latest installed ($ASDF_DATA_DIR, or ~/.asdf)
#   6. mise's latest installed ($MISE_DATA_DIR, or ~/.local/share/mise)
#   7. Homebrew: /opt/homebrew/bin/node, then /usr/local/bin/node
#
# With none found it appends a line to the state log and exits 1: the same
# file as scripts/state-log.ts's LOG_PATH (test/find-node.test.ts holds the
# two together) and the same shape, an ISO time then the message, though
# to the second, since sh has no portable milliseconds. CMUX_COCKPIT_FIXED_NODES
# replaces step 7's list; the tests use it, since a CI runner has node in
# /usr/local/bin.

found() {
  [ -x "$1" ] || return 1
  printf '%s\n' "$1"
  exit 0
}

# The highest version's bin/node under $1, whose entries are version
# folders with or without a leading v ("22.11.0", "v24.2.0"), taking only
# names that start with $2 when it is given. Sorted on the numbers, so
# 24.10 beats 24.9.
latest_in() {
  [ -d "$1" ] || return 1
  best=$(for dir in "$1"/"${2:-}"*; do
    name=${dir##*/}
    [ -x "$dir/bin/node" ] && printf '%s %s\n' "${name#v}" "$name"
  done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  [ -n "$best" ] || return 1
  found "$1/${best#* }/bin/node"
}

# nvm's default alias ("24", "v24.2.0", "lts/*", "node"), when it resolves
# to an installed version: an exact match first, then the latest whose
# version starts with it. "lts/*" and "node" need nvm itself to resolve,
# so they fall through to the latest installed.
nvm_default() {
  versions=$1/versions/node
  [ -r "$1/alias/default" ] || return 1
  read -r want <"$1/alias/default" || [ -n "$want" ] || return 1
  want=${want#v}
  case $want in '' | *[!0-9.]*) return 1 ;; esac
  found "$versions/v$want/bin/node"
  latest_in "$versions" "v$want."
}

on_path=$(command -v node 2>/dev/null) && found "$on_path"

for fnm in "${FNM_DIR:-}" "$HOME/.local/share/fnm" "$HOME/Library/Application Support/fnm"; do
  [ -n "$fnm" ] && found "$fnm/aliases/default/bin/node"
done

nvm=${NVM_DIR:-$HOME/.nvm}
nvm_default "$nvm"
latest_in "$nvm/versions/node"

found "${VOLTA_HOME:-$HOME/.volta}/bin/node"
latest_in "${ASDF_DATA_DIR:-$HOME/.asdf}/installs/nodejs"
latest_in "${MISE_DATA_DIR:-$HOME/.local/share/mise}/installs/node"

for fixed in ${CMUX_COCKPIT_FIXED_NODES-/opt/homebrew/bin/node /usr/local/bin/node}; do
  found "$fixed"
done

printf '%s find-node error: no node found on PATH or from fnm, nvm, volta, asdf, mise or Homebrew\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$HOME/Library/Logs/cmux-cockpit-state.log" 2>/dev/null
exit 1
