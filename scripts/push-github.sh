#!/bin/bash
set -euo pipefail
cd /Users/sashanksingh/Projects/hirealpha

echo "Auth check..."
gh auth status

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Creating GitHub repo and pushing..."
  gh repo create hirealpha --public --source=. --remote=origin --push \
    --description "HireAlpha — hire Friend, Coworker, or Cofounder in iMessage"
else
  echo "Remote exists. Pushing..."
  git push -u origin HEAD
fi

echo
echo "Repo URL:"
gh repo view --json url -q .url
