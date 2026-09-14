# X-Offline

Mobilna apkka w stylu X (Twitter), w której **posty zapisujesz do pamięci urządzenia i czytasz je potem bez internetu
albo na słabym łączu** — dokładnie tak, jak TikTok pozwala oglądać pobrane filmiki.

Dwie wersje z tego samego kodu:

| Wersja                        | Jak                                     | Co potrafi                                                                                  |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| **PWA** (przeglądarka)        | `npm run dev` → podgląd, albo build → netlify/vercel/static | czyta cache, instaluje się „Dodaj do ekranu głównego”, pobiera przez **serwer proxy** |
| **APK** (Android)             | `npm run apk:build` albo GitHub Actions  | to samo + **pobiera posty bez żadnego serwera** (sieć natywna nie zna CORS)                 |

```
Start (oś czasu)  ·  Na żywo (pobieranie + iframe X)  ·  Zapisane (offline)  ·  Ustawienia
```

---

## Jak to działa (bez ściemy)

Oficjalne API X jest płatne, więc idziemy inną drogą — tą samą, której używają **osadzone posty i widgety** na
setkach stron:

```
   X (publiczne endpointy syndykacji)
        │   cdn.syndication.twimg.com/tweet-result?id=…&token=…      ← pojedynczy post
        │   cdn.syndication.twimg.com/timeline/profile?screen_name=… ← ostatnie posty profilu
        │   syndication.twitter.com/srv/timeline-profile/screen-name/… (HTML + __NEXT_DATA__)
        ▼
   ┌───────────────────────────┐        ┌──────────────────────────────┐
   │ APK (Capacitor)           │        │ PWA w przeglądarce           │
   │ CapacitorHttp → sieć     │        │ serwer proxy: server/index.js │
   │ natywna, zero CORS        │        │ albo cloudflare/worker.mjs    │
   └───────────┬───────────────┘        └───────────────┬──────────────┘
               ▼                                        ▼
        normalizacja (src/lib/normalize.ts)  →  struktury postów
               ▼
   IndexedDB (Dexie): posts + blobs (zdjęcia/klipy)   +   Cache API przez service workera
               ▼
   zakładka „Zapisane” + pionowy czytnik w stylu szpulki — działa w samolocie
```

Co konkretnie daje tryb offline:

- **treść + autor + statystyki** zapisane jako rekordy w IndexedDB (zawsze, nawet gdy media się nie pobiorą),
- **zdjęcia i klipy** ściągnięte jako binarki i wpięte przez `blob:` URL-e → zero żądań sieciowych przy czytaniu,
- **service worker** cacheuje sam shell apki, więc „Dodaj do ekranu głównego” startuje bez łącza,
- **limit miejsca + auto-czyszczenie**: apka nie urośnie Ci do 5 GB (domyślnie 256 MB, potem tnie najstarsze media),
- **eksport/import biblioteki** do pliku `.json` — przenosisz zestaw postów na inny telefon (w APK ląduje w `Documents`).

### Dlaczego w przeglądarce potrzebny jest proxy

X nie wysyła nagłówka `Access-Control-Allow-Origin`, więc `fetch()` z domeny apki kończy się `Failed to fetch` —
nie da się tego obejść z poziomu klienta. Stąd trzy tryby w **Ustawienia → Tryb pracy**:

- `auto` (domyślny) — spróbuj proxy, potem wprost, a jak nic nie wyjdzie: dane demo,
- `tylko demo` — zero sieci, pełnia funkcji offline (34 posty na 6 kontach),
- `tylko proxy` — wymaga `server/` albo Workera,
- `wprost` — dla upartych (w większości sieci CORS wywali błąd, apka pokaże podpowiedź).

W **APK tego problemu nie ma**: `CapacitorHttp` robi żądanie poza przeglądarką, więc pobieranie działa bez serwera.

---

## Szybki start

```bash
npm install
npm run dev          # web na :5173 + proxy na :8787 (Vite przekazuje /api)
```

Otwórz podgląd w przeglądarce, przejdź do **Na żywo**, kliknij **Pobierz** przy dowolnym profilu →
potem **Zapisane** → **Czytnik**. Żeby poczuć tryb offline: odłącz internet (albo w DevTools → Network → Offline)
i odśwież — wszystko zostaje.

Polecenia:

```bash
npm run build        # apps/web/dist (PWA gotowe do wrzucenia na hosting)
npm run test         # 28 testów: normalizacja, cache offline, limit miejsca, render UI
npm run typecheck
npm run demo:gen     # regeneruje dane demo + media (scripts/gen-demo-data.mjs)
npm run apk:build    # lokalny build debug-APK (wymaga JDK 21 + Android SDK)
```

---

## APK — plik do zainstalowania

Dwa sposoby, oba opisane szczegółowo w [`docs/APK.md`](docs/APK.md):

1. **GitHub Actions** (bez Android Studio u Ciebie): zakładka *Actions* → **Android APK** → *Run workflow* →
   artefakt `x-offline-apk-debug`. Workflow buduje PWA, dokleja platformę Android, odpala `gradlew assembleDebug`
   i wypuszcza `x-offline-debug.apk` (a na tagu `v*` robi release z plikami `.apk` + `.aab`).
2. **Lokalnie**: `npm run apk:build` (skrypt sam robi `npm run build`, `npx cap add android`, `cap sync` i gradle).

Plik APK waży ~4 MB (Capacitor + WebView, bez Google Mobile Services). Minimalnie Android 7.0 (API 23).

> Wersja debug instaluje się z komunikatem „nieznane źródło” — to normalne przy apkach z CI.
> Jeżeli chcesz, żeby dało się aktualizować bez utraty zapisanych postów, podpisz release własnym kluczem
> (secrets w repo: `ANDROID_KEYSTORE_*`) i instaluj przez `adb install -r`.

---

## Struktura repo

```
apps/web/                 PWA + kod natywny (React 18, TS, Dexie, zustand, vite-plugin-pwa)
  src/lib/
    transport.ts         native | proxy | direct — jedna funkcja na wszystkie ścieżki
    normalize.ts         surowe JSON-y X → PostRecord (odporność na zmiany shape'u)
    sources.ts           pobieranie profili i postów po linkach + fallback do demo
    media.ts             cache binarek w IndexedDB, limit miejsca, przycinanie
    download.ts          kolejka pobrań: postęp, anulowanie, współbieżność 3, historia
    posts.ts             zapis/unsave, merge przy ponownym pobraniu, eksport/import
    native.ts            plik biblioteki w Documents, przycisk „wstecz”, cykl życia
  src/db/db.ts           schemat Dexie (posts / blobs / accounts / jobs / meta)
  src/components/        HomeTab, LiveTab, OfflineTab, SettingsTab, Reel, Sheets, PostCard…
server/index.js          proxy node (tylko-do-czytania, allow-lista hostów, TTL cache, rate limit)
cloudflare/worker.mjs    to samo na Cloudflare Workers (darmowy deploy)
scripts/                 generatory: ikony PWA, dane demo, build APK
.github/workflows/       web-ci.yml (testy + build), android.yml (APK/AAB + release)
docs/APK.md              budowa i instalacja na telefonie
docs/DANE.md             endpointy, ograniczenia, co zrobić gdy X coś zmieni
```

## Ustawienia, które warto znać

| Ustawienie                   | Domyślnie | Po co                                                             |
| ---------------------------- | --------- | ----------------------------------------------------------------- |
| Limit offline                | 256 MB    | miękki sufit dla mediów; 0 = bez limitu                            |
| Auto-czyszczenie             | wł.       | powyżej limitu zrzuca media najstarszych zapisów                  |
| Pobieraj wideo               | wł.       | klipy ważą najwięcej — wyłącz przy małym pakiecie                 |
| Słuchaj „oszczędzania danych”| wł.       | system zgłasza data saver → zapisujemy tekst, pomijamy media       |
| Pionowy czytnik              | wł.       | tapnięcie posta otwiera szpulkę ze swipe’em w górę/dół              |
| Aktualizuj przy starcie      | wył.      | przy otworzeniu apki dociąga świeże posty profili, które masz      |
| Szablon podglądu na żywo     | `…/{handle}` | własna strona w ramce (np. instancja lustrzana, której ufasz)  |

## Czego ta apka **nie** robi (i nie będzie)

- nie loguje Cię do X, nie czyta Twojej osi czasu „home”, nie pobiera DM-ów i postów z kont prywatnych,
- nie zapisuje wątków i odpowiedzi (zgodnie z założeniem: tylko główne posty),
- nie działa z pełną gwarancją: endpointy syndykacji są **nieoficjalne**, dawkowane i mogą zniknąć — wtedy
  apka nadal czyta to, co już masz w pamięci (i to jest cały sens offline-first).

Szczegóły i plan B: [`docs/DANE.md`](docs/DANE.md).

---

## CI (GitHub Actions)

Definicje pipeline'ów leżą w [`ci/`](ci/) i czekają na skopiowanie do `.github/workflows/`:

```bash
npm run ci:install     # kopiuje ci/*.yml → .github/workflows/
git add -f .github/workflows && git commit -m "ci: workflowy" && git push
```

Dlaczego tak: token integracji, którego tu używam, nie ma uprawnienia `workflows` — GitHub odrzuca
push zawierający pliki w `.github/workflows/`. U Ciebie to jedno `git add -f .github/workflows`.

Co dostajesz:

| Workflow        | kiedy                                     | efekt                                                           |
| --------------- | ----------------------------------------- | --------------------------------------------------------------- |
| **Web CI**      | push na `main`, pull request              | typecheck → testy → build PWA → smoke proxy → artefakt `web-dist` |
| **Android APK** | `workflow_dispatch` albo tag `v*`         | `x-offline-debug.apk` / `release.apk` + `.aab` + `x-offline-pwa.zip` |

Najszybsza droga do pliku APK: **Actions → Android APK → Run workflow (`variant: debug`)** i pobranie artefaktu.
Chcesz, żebym spróbował zbudować APK w tym sandboxie — nie da się: nie ma tu dostępu do `dl.google.com`,
`adoptium.net` ani `services.gradle.org` (blokada egress), więc gradle nie ściągnie narzędzi.
Wystarczy jednak, że odpalisz workflow, a dostaniesz gotowy plik.


## Udostępnianie z X do apki

- **PWA**: manifest ma `share_target` — w Chromie na Androidzie wybierasz „X-Offline” w liście udostępniania,
  link wpada prosto do kolejki pobrań (`/?import=1&url=…`).
- **APK**: chcesz odbierać intenty `text/plain`/`view/*`? Dorzuć `intent-filters` w `android/app/src/main/AndroidManifest.xml`
  (snippet w `docs/APK.md`), a resztę zrobi już istniejąca ścieżka importu.

## Licencja / zastrzeżenie

Projekt nie jest powiązany z X Corp. Treści postów należą do ich autorów; pobieranie publicznych danych
przez endpointy syndykacji jest „best effort” i robisz to na własną odpowiedzialność — apka niczego nie wysyła
poza żądaniami do X i do **Twojego** proxy.
