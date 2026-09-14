#!/usr/bin/env bash
# Buduje podpisany debug-APK lokalnie (potrzebuje JDK 21 i Android SDK).
# CI (GitHub Actions) robi to samo bez lokalnego narzędzia — zobacz docs/APK.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "✗ Brakuje: $1"
    echo "  Potrzebujesz JDK 21+ oraz Android SDK (ANDROID_HOME) z platform-tools + build-tools;35.0.0."
    echo "  Albo odpal workflow „Android APK” na GitHubie i pobierz artefakt."
    exit 1
  }
}

need node
need java

if [ ! -d android ]; then
  echo "→ generuję projekt android/"
  npm run build
  npx cap add android
fi

echo "→ build webu + synchronizacja"
npm run build
npx cap sync android

# kontrola natywu celowo PO syncu: wtedy widać m.in. czy assets/public i inject/ są na miejscu
echo "→ kontrola projektu natywnego"
npm run verify:android

if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  for c in "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" /opt/android-sdk /usr/lib/android-sdk; do
    if [ -d "$c" ]; then export ANDROID_HOME="$c"; break; fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ] && [ ! -f android/local.properties ]; then
  echo "✗ Nie znalazłem Android SDK (ANDROID_HOME). Ustaw go albo dodaj android/local.properties z sdk.dir=…"
  exit 1
fi

need gradle || true

echo "→ gradle assembleDebug"
pushd android >/dev/null
if [ -x ./gradlew ]; then
  ./gradlew assembleDebug --console=plain -q
else
  gradle assembleDebug --console=plain -q
fi
popd >/dev/null

OUT="dist-apk"
mkdir -p "$OUT"
SRC="android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$SRC" ]; then
  cp "$SRC" "$OUT/x-offline-debug.apk"
  SIZE=$(du -h "$OUT/x-offline-debug.apk" | cut -f1)
  echo "✓ APK: $OUT/x-offline-debug.apk ($SIZE)"
  echo "  Zainstaluj: adb install -r $OUT/x-offline-debug.apk"
else
  echo "✗ Gradle nie zwrócił APK — sprawdź widoki powyżej"
  exit 1
fi
