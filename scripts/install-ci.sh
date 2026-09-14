#!/usr/bin/env bash
# Kopiuje definicje pipeline'ów z ci/ do .github/workflows/ (skąd czyta je GitHub).
# Potrzebne, bo token integracji nie miał prawa „workflows” — pliki są więc w ci/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/.github/workflows"
cp -v "$ROOT"/ci/*.yml "$ROOT/.github/workflows/"
echo
echo "Teraz:  git add -f .github/workflows && git commit -m 'ci: workflowy' && git push"
