#!/bin/sh
# Fetches cmux's public sidebar SDK at the tag matching the installed cmux,
# into a gitignored .sdk/. The SDK is GPL-3.0-or-later, so it is fetched,
# never committed.
set -eu
# The tag of the cmux release this was built against (0.64.25), and the
# commit it pointed at, since a tag can be moved.
TAG=v0.64.25
COMMIT=b685a275c2e411799857155e37264daf84f7e4d6
cd "$(dirname "$0")"
if [ -f .sdk/TAG ] && [ "$(cat .sdk/TAG)" = "$TAG" ]; then exit 0; fi
rm -rf .sdk
git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" --filter=blob:none --sparse \
  https://github.com/manaflow-ai/cmux.git .sdk
# No-cone mode, so cmux's root files (its biome.json above all) stay out of
# this repo's tree.
git -C .sdk sparse-checkout set --no-cone /Packages/macOS/CmuxExtensionKit/
got=$(git -C .sdk rev-parse HEAD)
if [ "$got" != "$COMMIT" ]; then
  echo "cmux tag $TAG is at $got, expected $COMMIT; not using it." >&2
  rm -rf .sdk
  exit 1
fi
echo "$TAG" > .sdk/TAG
