#!/usr/bin/env bash
# Build and release the userscript.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: ./release.sh <version>"
  echo "Example: ./release.sh 1.0.1"
  exit 1
fi

VERSION="$1"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Releasing v$VERSION"
npm version "$VERSION" --no-git-tag-version
npm ci
npm run check
npm run test:e2e
npm run build

git add package.json package-lock.json opencodego-dashboard.user.js
git commit -m "chore: release v$VERSION"
git push

git tag "v$VERSION"
git push origin "v$VERSION"

echo "Released v$VERSION"
echo "GitHub Actions will publish the userscript."
