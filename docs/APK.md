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
   `branch: arena/01a0a3ea-x-offline` (albo `main`, gdy PR będzie już scalony), `variant: debug` → **Run workflow**.
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

Na tagu `v0.2.0` (albo jakimkolwiek `v*`) dodatkowo tworzy GitHub Release z `.apk` + `.aab`.

Czyli pełna ścieżka do **linku z plikiem APK** (do wysłania komuś):

```bash
npm run ci:install && git add -f .github/workflows && git commit -m "ci: pipeline" && git push
git tag v0.2.0 && git push origin v0.2.0        # Actions zbuduje release i wrzuci APK do GitHub Releases
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
| zbieranie postów z X             | — (PWA czyta bibliotekę)         | **podgląd X** (WebView z Twoją sesją)           |
| media offline                    | IndexedDB + Cache API             | IndexedDB (WebView ma własny przydział miejsca)  |
| eksport biblioteki                | pobranie pliku                    | plik na dysku (Documents albo katalog apki) + udostępnianie systemowe |
| przycisk „wstecz”                 | —                                | zamyka czytnik / sheet, potem start, potem exit   |
| aktualizacja apki                 | service worker (prompt w nagłówku) | reinstalacja APK (dane zostają)                 |

## 5. Udostępnianie linków do apki (działa od razu)

Manifest w repo ma już wszystkie potrzebne filtry, więc po instalacji działa:

| Skąd                                                                 | Co się dzieje                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| „Udostępnij” w X / przeglądarce / dowolnej apce (tekst, `text/plain`)  | link z `/status/…` otwiera się w podglądzie X i zapisuje do offline |
| tapnięcie linku `x.com/*/status/…` („Otwórz w X-Offline”)              | to samo, bez otwierania przeglądarki                                |
| zaznaczony tekst → menu → „X-Offline” (`PROCESS_TEXT`)                | to samo, nawet gdy nie ma tam linku (apka powie, czego brakuje)      |

Wszystkie trzy ścieżki obsługuje `MainActivity.captureSharedIntent()`:

- gdy apka już żyje i JS nasłuchuje → event `shareReceived` (mostek `XLivePlugin`),
- gdy apka startuje na zimno → `SharedIntent` czeka w kolejce i `bridge.startShareListener()`
  odbiera go przez `XLive.consumeSharedIntent()`.

Nic nie ginie i nic nie trzeba dopisywać — jedyne, co warto wiedzieć, to że link bez `/status/…`
(np. sam profil) nie jest otwierany: apka mówi wprost, że to nie post.

## 6. Rozwiązywanie problemów

- **Wolisz złapać błąd przed gradle?** → `npm run verify:android` (mówi o brakujących pluginach w `capacitor.settings.gradle`,
  źle nazwanym `@CapacitorPlugin`, niezbalansowanym XML-u i `getAssets()` wskazującym w pustkę).
- **`chrome://inspect` nie widzi apki** → tak ma być w wariancie release: `webContentsDebuggingEnabled: false`
  w `capacitor.config.ts`. Debug-APK da się podglądać always (jest `debuggable`).
- **Eksport wylądował w `Android/data/…/files`, a nie w `Documents`** → tak ma być na Androidzie 11+: aplikacja
  może w publicznym `Documents` pisać tylko w plikach, które sama tam stworzyła. `saveTextFileNative` najpierw
  próbuje `Directory.Documents`, przy odmowie zapisuje w `Directory.Data`, a toast pokazuje faktyczne miejsce.
  Żeby FileProvider nie wywalił udostępniania z katalogu aplikacji, `res/xml/file_paths.xml` ma tam
  `<files-path>` i `<external-files-path>` — `npm run verify:android` pilnuje, że każdy użyty `Directory.*` ma
  swoje przykrycie (inaczej `Share` dostaje URI spoza providera i na telefonie leci `IllegalArgumentException`).
- **Udostępnianie nie otwiera okna, a plik jest zapisany** → normalne dla `content://` z nowszego
  `@capacitor/filesystem` (Share przyjmuje tylko `file://`); plik i tak leży na dysku, wyślij go menedżerem plików.
- **`SDK location not found`** → `ANDROID_HOME` albo `android/local.properties`.
- **`Unsupported class file major version`** → JDK za nowy/stary dla gradle; użyj JDK 21 (`java -version`).
- **Biały ekran po instalacji** → brak `npm run build` przed `cap sync`; sprawdź `android/app/src/main/assets/public/index.html`.
- **Pusto w „Zapisane” na telefonie** → otwórz zakładkę X, zaloguj się i przewiń trochę
  (albo zaimportuj wyeksportowany `.json`). Zbieranie działa tylko w otwartym podglądzie.
