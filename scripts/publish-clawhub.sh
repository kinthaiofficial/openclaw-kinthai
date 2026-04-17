#!/bin/bash
# Publish to ClawHub with test/docs temporarily hidden.
# 发布 ClawHub 时临时隐藏 test/ 和 docs/ 目录。
#
# Rationale: ClawHub security scanner flags test files for child_process use.
# Adding them to .clawhubignore causes openclaw archive-integrity-check failures.
# Simplest workaround: move them aside for the duration of publish.
#
# Usage:
#   scripts/publish-clawhub.sh [version]   # version defaults to package.json
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-$(python3 -c "import json;print(json.load(open('package.json'))['version'])")}"
COMMIT="$(git rev-parse HEAD)"

# Hide test/ and docs/ during publish
STASH_DIR="$(mktemp -d)"
trap "mv '$STASH_DIR/test' ./test 2>/dev/null || true; mv '$STASH_DIR/docs' ./docs 2>/dev/null || true; rm -rf '$STASH_DIR'" EXIT

[ -d test ] && mv test "$STASH_DIR/test"
[ -d docs ] && mv docs "$STASH_DIR/docs"

echo "Publishing @kinthaiofficial/openclaw-kinthai@$VERSION"
clawhub package publish . \
  --family code-plugin \
  --name "@kinthaiofficial/openclaw-kinthai" \
  --display-name "KinthAI" \
  --version "$VERSION" \
  --source-repo kinthaiofficial/openclaw-kinthai \
  --source-commit "$COMMIT" \
  --source-ref main \
  --no-input
