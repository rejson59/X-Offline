# Budowa i instalacja APK

Dwie drogi: **CI (zero narzędzi u Ciebie)** i **lokalnie**. Obie używają tego samego `capacitor.config.ts`
(w katalogu głównym) jako źródła konfiguracji.

## 1. GitHub Actions (rekomendowane)

```
Repo → Actions → „Android APK” → Run workflow → variant: debug
```

Co robi workflow (`.github/workflows/android.yml`):

1. `npm ci` → `npm run typecheck` → `npm run test` (nie budujemy APK z błędami),
2. `npm run build` (PWA do `apps/web/dist`),
3. `npx cap add android` (jeśli nie ma) + `npx cap sync android`,
4. `./gradlew assembleDebug` (albo `assembleRelease bundleRelease` dla wariantu `release`),
5. artefakty: `x-offline-apk-debug/…apk` oraz `x-offline-pwa.zip`.

Na tagu `v0.1.0` dodatkowo tworzy GitHub Release z `.apk` + `.aab`.

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

- **`SDK location not found`** → `ANDROID_HOME` albo `android/local.properties`.
- **`Unsupported class file major version`** → JDK za nowy/stary dla gradle; użyj JDK 21 (`java -version`).
- **Biały ekran po instalacji** → brak `npm run build` przed `cap sync`; sprawdź `android/app/src/main/assets/public/index.html`.
- **Pusto w „Zapisane” na telefonie** → pobierz raz z WIFI (tryb `auto` użyje sieci natywnej) albo zaimportuj
  wyeksportowany `.json`.
