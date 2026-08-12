#!/bin/bash
# release.sh - Quick release script

set -e

if [ -z "$1" ]; then
  echo "Usage: ./release.sh <version>"
  echo "Example: ./release.sh 0.9.8"
  exit 1
fi

VERSION=$1

echo "📦 Releasing version $VERSION..."

# Update version in userscript
sed -i "s/@version.*/@version      $VERSION/" opencodego-dashboard.user.js

# Commit and tag
git add opencodego-dashboard.user.js
git commit -m "chore: bump version to $VERSION"
git push

git tag v$VERSION
git push --tags

echo ""
echo "✅ Released v$VERSION"
echo "🔗 https://github.com/HIUEETR/OpenCodeGo-Dashboard/releases/tag/v$VERSION"
echo ""
echo "GitHub Actions will create the release automatically."
