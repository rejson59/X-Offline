# Budowa i instalacja APK

Dwie drogi: **CI (zero narzędzi u Ciebie)** i **lokalnie**. Obie używają tego samego `capacitor.config.ts`
(w katalogu głównym) jako źródła konfiguracji.

## 1. GitHub Actions (rekomendowane)

### Najszybsza droga: wklej workflow w przeglądarce (zero terminala)

GitHub nie pozwala integracji/botowi dodawać plików w `.github/workflows/` — więc ten jeden plik
wklejasz sam, raz. Potem APK wychodzi z dwóch kliknięć.

1. Wejdź na **`github.com/<Twój login>/X-Offline/new/main?filename=.github/workflows/android.yml`**
   ( ścieżka i nazwa pliku uzupełnią się same — nie zmieniaj ich).
2. Wklej tam dokładną zawartość [`ci/android-quick.yml`](../ci/android-quick.yml)
   (otwórz plik → ikona „Copy raw content", żeby nie przenieść numerów linii).
3. **Commit directly to the `main` branch** → zapisz.
4. Zakładka **Actions** → **Android APK** → **Run workflow** →
   `branch: arena/01a09eef-x-offline` (albo `main`, gdy PR będzie już scalony), `variant: debug` → **Run workflow**.
5. Po ~5–8 minutach: w podglądzie runa, na dole, sekcja **Artifacts** → **`x-offline-apk-debug`** → pobierz.
   W środku archiwum jest `x-offline-debug.apk` — ten plik instalujesz na telefonie (pkt 3 niżej).

Ten skrót buduje to samo co pełny `ci/android.yml`, tylko bez wysyłania na release i bez `x-offline-pwa.zip`.
Jak wolisz wersję pełną (albo chcesz, żeby `npm run ci:install` sam podmienił plik), użyj komend pod tym.

> Run padł? Otwórz run → czerwony krok → pokaż mi ostatnie ~30 linii logu (albo odpal
> `gh run view <id> --log-failed`). Typowe przyczyny są w pkt 6.


```
Repo → Actions → „Android APK” → Run workflow → variant: debug
```

albo z terminala, bez klikania (ściąga artefakt do `dist-apk/`):

```bash
npm run apk:ci          # debug;  npm run apk:ci release  — wariant z podpisem (wymaga secrets)
```

Jeśli skrypt powie, że nie ma `.github/workflows/android.yml`, to znaczy, że workflow nadal leży tylko
w `ci/` — przepnij go raz: `npm run ci:install && git add -f .github/workflows && git commit && git push`.

Co robi workflow (`.github/workflows/android.yml`):

1. `npm ci` → `npm run typecheck` → `npm run test` (nie budujemy APK z błędami),
2. `npm run build` (PWA do `apps/web/dist`),
3. `npm run verify:android` — kontrola Gradla/zasobów/kontraktu mostka, zanim odpali się właściwy build,
4. `npx cap add android` (jeśli nie ma) + `npx cap sync android` + `npm run native:sync` (skrypty wstrzykiwane),
5. `./gradlew assembleDebug` (albo `assembleRelease bundleRelease` dla wariantu `release`),
6. artefakty: `x-offline-apk-debug/…apk` oraz `x-offline-pwa.zip`.

Na tagu `v0.1.0` dodatkowo tworzy GitHub Release z `.apk` + `.aab`.

Czyli pełna ścieżka do **linku z plikiem APK** (do wysłania komuś):

```bash
npm run ci:install && git add -f .github/workflows && git commit -m "ci: pipeline" && git push
git tag v0.1.0 && git push origin v0.1.0        # Actions zbuduje release i wrzuci APK do GitHub Releases
```

### Wariant release z Twoim podpisem (żeby dało się aktualizować)

Ustaw secrets w repo, a workflow sam podpisze build:

| Secret                      | Co                                                             |
| --------------------------- | -------------------------------------------------------------- |
| `ANDROID_KEYSTORE_B64`      | `base64 -w0 keystore.jks`                                      |
| `ANDROID_KEYSTORE_PASSWORD` | hasło keystore                                                 |
| `ANDROID_KEY_ALIAS`         | alias klucza                                                    |
| `ANDROID_KEY_PASSWORD`      | hasło klucza                                                     |

Jak zrobić keystore:

```bash
keytool -genkeypair -v -keystore xoffline.jks -alias xoffline \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 xoffline.jks > xoffline.jks.b64      # zawartość → ANDROID_KEYSTORE_B64
```

## 2. Lokalnie

Wymagane: **JDK 21** i **Android SDK** (`platform-tools`, `platforms;android-35`, `build-tools;35.0.0`).

```bash
export ANDROID_HOME=$HOME/Android/Sdk      # albo Studio wskaże ścieżkę
npm run apk:build                            # scripts/build-apk.sh
# wynik: dist-apk/x-offline-debug.apk
```

Skrypt robi: `npm run build` → `npx cap add android` (jednorazowo) → `npx cap sync android` →
`./gradlew assembleDebug` → kopiowanie APK do `dist-apk/`.

Jeśli SDK jest w nietypowym miejscu, dopisz `sdk.dir=/sciezka/do/sdk` do `android/local.properties`.

### Alternatywa przez Android Studio

```bash
npm run build && npx cap sync android && npx cap open android
# Studio: Build → Build Bundle(s)/APK(s) → Build APK(s)
```

## 3. Instalacja na telefonie

```bash
adb devices
adb install -r dist-apk/x-offline-debug.apk
```

Bez kabla: wrzuć plik na telefon (plik menedżer / chmura / `python3 -m http.server`) → tapnij →
„Zezwól na nieznane źródła”. Debug i release z różnym podpisem **nie nadpiszą** się nawzajem —
najpierw odinstaluj starą wersję.

## 4. Co się zmienia między PWA a APK

|                                  | PWA                              | APK                                             |
| -------------------------------- | -------------------------------- | ----------------------------------------------- |
| pobieranie postów z X            | tylko przez proxy (CORS)         | **bez proxy** (`CapacitorHttp`)                 |
| media offline                    | IndexedDB + Cache API             | IndexedDB (WebView ma własny przydział miejsca)  |
| eksport biblioteki                | pobranie pliku                    | plik w `Documents/` + systemowe udostępnianie     |
| przycisk „wstecz”                 | —                                | zamyka czytnik / sheet, potem start, potem exit   |
| aktualizacja apki                 | service worker (prompt w nagłówku) | reinstalacja APK (dane zostają)                 |

## 5. Odbieranie udostępnionych linków w APK (opcjonalnie)

Po `npx cap add android` dodaj w `android/app/src/main/AndroidManifest.xml`, wewnątrz `<activity …>`:

```xml
<intent-filter>
  <action android:name="android.intent.action.SEND" />
  <category android:name="android.intent.category.DEFAULT" />
  <data android:mimeType="text/plain" />
</intent-filter>
<intent-filter android:autoVerify="false">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="x.com" android:pathPattern="/..*/status/..*" />
</intent-filter>
```

Intenty z `SEND` Capacitor podaje jako parametr `text` w starcie aplikacji — apka i tak je obsłuży,
bo `src/main.tsx` czyta `?import=1&text=…` i wrzuca linki do kolejki. Żeby to zadziałało natywnie,
w `MainActivity.java` wystarczy przekazać intencję do URL-a startowego (snippet w `capacitor.config.ts`
komentarzu + `docs/DANE.md`).

## 6. Rozwiązywanie problemów

- **Wolisz złapać błąd przed gradle?** → `npm run verify:android` (mówi o brakujących pluginach w `capacitor.settings.gradle`,
  źle nazwanym `@CapacitorPlugin`, niezbalansowanym XML-u i `getAssets()` wskazującym w pustkę).
- **`chrome://inspect` nie widzi apki** → tak ma być w wariancie release: `webContentsDebuggingEnabled: false`
  w `capacitor.config.ts`. Debug-APK da się podglądać always (jest `debuggable`).
- **`SDK location not found`** → `ANDROID_HOME` albo `android/local.properties`.
- **`Unsupported class file major version`** → JDK za nowy/stary dla gradle; użyj JDK 21 (`java -version`).
- **Biały ekran po instalacji** → brak `npm run build` przed `cap sync`; sprawdź `android/app/src/main/assets/public/index.html`.
- **Pusto w „Zapisane” na telefonie** → pobierz raz z WIFI (tryb `auto` użyje sieci natywnej) albo zaimportuj
  wyeksportowany `.json`.
