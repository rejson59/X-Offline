#!/usr/bin/env bash
# apk:ci — zbuduj APK na GitHub Actions i pobierz artefakt, bez JDK i Android SDK u siebie.
#
# Wymaga: gh (zalogowany), `.github/workflows/android.yml` w repo (npm run ci:install + push),
# oraz to, że GitHub w ogóle pozwala integracji na pliki workflow. Jeśli nie — wypiszemy
# dokładnie te komendy, które musisz wklejać sam.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/..")" && cd "$ROOT"

VARIANT="${1:-debug}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
WORKFLOW="android.yml"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"

if [ -z "$REPO" ]; then
  echo "✗ Nie wiem, które to repo — odpal to z katalogu z podpiętym githubowym remote."
  exit 1
fi

echo "→ repo: $REPO, branch: $BRANCH, wariant: $VARIANT"

# 1) czy workflow w ogóle żyje na GitHubie?
if ! gh api "repos/$REPO/contents/.github/workflows/$WORKFLOW" --jq '.path' >/dev/null 2>&1; then
  cat <<EOF
✗ Na GitHubie nie ma '.github/workflows/$WORKFLOW', więc nie ma czego odpalić.
  Token integracji nie może dodawać plików workflow — to trzeba zrobić ręcznie:

      npm run ci:install
      git add -f .github/workflows
      git commit -m "ci: pipeline APK"
      git push origin $BRANCH

  Potem: npm run apk:ci
EOF
  exit 1
fi

# 2) odpal
gh workflow run "$WORKFLOW" --ref "$BRANCH" -f variant="$VARIANT"
echo "→ wysłane zlecenie, czekam aż Actions znajdzie run…"

RUN=""
for _ in $(seq 1 30); do
  sleep 4
  RUN="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$RUN" ] && [ "$RUN" != "null" ] && break
done
if [ -z "$RUN" ] || [ "$RUN" = "null" ]; then
  echo "✗ Run się nie pojawił — zajrzyj: gh run list --workflow $WORKFLOW"
  exit 1
fi
echo "→ run: https://github.com/$REPO/actions/runs/$RUN"
gh run watch "$RUN" --exit-status || {
  echo "✗ Build padł — logi:  gh run view $RUN --log-failed"
  exit 1
}

# 3) artefakt
NAME="x-offline-apk-$VARIANT"
mkdir -p dist-apk
gh run download "$RUN" --name "$NAME" --dir dist-apk
APK="$(find dist-apk -name '*.apk' | head -1)"
if [ -z "$APK" ]; then
  echo "✗ W artefakcie '$NAME' nie ma .apk — sprawdź podgląd: gh run view $RUN"
  exit 1
fi
echo
echo "✓ APK: $APK  ($(du -h "$APK" | cut -f1))"
echo "  Wyślij na telefon i:  adb install -r $APK"
