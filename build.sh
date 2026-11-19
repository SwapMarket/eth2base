#!/usr/bin/env bash
# Build the site into _site/: the files as they are, with the commit stamped into index.html. The deploy runs this, and so does
# check-page.sh, which rebuilds a published commit to compare it with what the site serves.
# Usage: ./build.sh [commit sha]   (without one, a local build stamped "dev"; serve _site/ to try it)
set -euo pipefail
sha=${1:-dev}

rm -rf _site
mkdir _site
cp index.html app.js style.css icon.png logo.svg sw.js _site/
sed -i "s/__COMMIT_SHORT__/${sha::7}/g; s/__COMMIT__/${sha}/g" _site/index.html
# Every placeholder filled.
! grep -q '__COMMIT' _site/index.html
