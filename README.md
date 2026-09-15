# X-Offline

Mobilna apka w stylu X (Twitter), w której **posty same lądują w pamięci urządzenia i czytasz je potem bez internetu**
— dokładnie tak, jak TikTok pozwala oglądać pobrane filmiki.

**Zero danych zastępczych.** W tej wersji nie ma już żadnego „zestawu demo” ani sztucznych postów: to, co widzisz w
zakładce *Zapisane*, naprawdę przyszło z X (albo z pliku, który sam zaimportowałeś). Pusta baza = pusta lista i
konkretna instrukcja, co zrobić, żeby ją zapełnić.

Jak z tego korzystać (to jest cały flow):

1. **Logujesz się do X normalnie** — w APK podgląd X to pełnoekranowy WebView z Twoimi ciasteczkami, więc
   sesja działa tak jak w przeglądarce (`docs/NATYWNE.md`).
2. **Nie wybierasz postów.** Apka sama zbiera to, co mija Twój wzrok, i dociąga partiami, aż uzbiera cel
   (domyślnie **200 postów offline**). Auto-scroll robi to nawet wtedy, gdy odłożysz telefon.
3. **Zakładki X są lustrzane** — to, co zapiszesz w samym X, wskakuje do offline; działa też na odwrót
   (opcjonalnie: zapis w apce = kliknięta zakładka w X).
4. **Polubienia i zakładki kliknięte offline czekają w kolejce** i lecą do X, gdy tylko złapiesz łącze.
5. **Czytasz jak w szpulce** — pionowy czytnik, „nieprzeczytane”, szukanie po treści/autorze/#tagach,
   zbiorcze oznaczanie i kasowanie, eksport do `.json` albo czytelnego `.md`.

Dwie wersje z tego samego kodu:

| Wersja                        | Jak                                     | Co potrafi                                                                                  |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| **PWA** (przeglądarka) | `npm run dev` → podgląd, build → dowolny hosting | czyta cache, instaluje się „Dodaj do ekranu”, dociąga partie postów przez **proxy**, kolejka akcji czeka na wysyłkę |
| **APK** (Android) | `npm run apk:build` albo GitHub Actions | + **logowanie do X w środku apki**, auto-zbieranie przy przewijaniu do celu, wysyłka polubień/zakładek, odbiór linków z „Udostępnij”, plik biblioteki na dysku telefonu |

```
Start (oś czasu + akcje)  ·  Na żywo (X w aplikacji, auto-zapis, pobieranie)  ·  Zapisane (offline, czytnik)  ·  Ustawienia
```

---

## Jak to działa (bez ściemy)

Oficjalne API X jest płatne, więc idziemy inną drogą — tą samą, której używają **osadzone posty i widgety** na
setkach stron:

```
   ——— APK: Twoja sesja w XLiveActivity ———
   x.com/home w WebView + wstrzyknięty zbieracz (assets/inject/xoffline-capture.js)
        │   podsłuch /i/api/graphql/* → pełne tweety (autor, media, favorited, bookmarked)
        │   auto-scroll do celu („200 postów”), widżet z licznikiem i pauzą
        │   odtwarzanie akcji: kliknij [data-testid=like|bookmark] w prawdziwym UI
        │   logi konsoli strony X → dziennik diagnostyczny apki (Ustawienia → Diagnostyka)
        ▼
   bridge.ts → capture.ts (polityka: co zapisywać, kiedy stanąć) → Dexie + blobs
        ▲
   ——— PWA / bez logowania ———
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
- **trwałe miejsce** — apka prosi system o `navigator.storage.persist()`, żeby Android nie wyrzucił biblioteki
  przy braku miejsca; stan widać w Ustawienia → Miejsce i offline,
- **service worker** cacheuje sam shell apki, więc „Dodaj do ekranu głównego” startuje bez łącza,
- **limit miejsca + auto-czyszczenie**: apka nie urośnie Ci do 5 GB (domyślnie 256 MB). Po przekroczeniu limitu
  **znikają media najstarszych zapisów, ale teksty zostają** — czytasz dalej, tylko bez zdjęć; brakujące media
  dociągniesz jednym przyciskiem („Dociągnij brakujące media”),
- **eksport/import biblioteki** do pliku `.json` (albo `.md` do czytania) — przenosisz zestaw postów na inny telefon.

### Dlaczego w przeglądarce potrzebny jest proxy

X nie wysyła nagłówka `Access-Control-Allow-Origin`, więc `fetch()` z domeny apki kończy się `Failed to fetch` —
nie da się tego obejść z poziomu klienta. Stąd trzy tryby w **Ustawienia → Tryb pracy**:

- `auto` (domyślny) — w APK sieć natywna, w przeglądarce proxy, a gdy nic nie odpowiada: konkretna podpowiedź,
- `tylko proxy` — wymaga `server/` albo Workera,
- `wprost` — dla upartych (w większości sieci CORS wywali błąd, apka pokaże podpowiedź).

W **APK tego problemu nie ma**: `CapacitorHttp` robi żądanie poza przeglądarką, więc pobieranie działa bez serwera.

---

## Szybki start

```bash
npm install
npm run dev          # web na :5173 + proxy na :8787 (Vite przekazuje /api)
```

Otwórz podgląd w przeglądarce, przejdź do **Na żywo**, wpisz profil i kliknij **Pobierz** →
potem **Zapisane** → **Czytnik**. Żeby poczuć tryb offline: odłącz internet (albo w DevTools → Network → Offline)
i odśwież — wszystko zostaje.

Polecenia:

```bash
npm run build        # apps/web/dist (PWA gotowe do wrzucenia na hosting)
npm run test         # 78 testów: normalizacja, cache offline, limit miejsca, kolejka akcji, UI, regresje
npm run typecheck
npm run apk:build    # lokalny build debug-APK (wymaga JDK 21 + Android SDK)
npm run apk:ci       # buduje APK na GitHub Actions i ściąga artefakt do dist-apk/ (wystarczy gh)
npm run verify:android  # kontrola projektu natywnego bez Android SDK (gradle, zasoby, kontrakt mostka)
```

---

## APK — plik do zainstalowania

Dwa sposoby, oba opisane szczegółowo w [`docs/APK.md`](docs/APK.md):

1. **GitHub Actions** (bez Android Studio u Ciebie): zakładka *Actions* → **Android APK** → *Run workflow* →
   artefakt `x-offline-apk-debug`. Workflow buduje PWA, dokleja platformę Android, odpala `gradlew assembleDebug`
   i wypuszcza `x-offline-debug.apk` (a na tagu `v*` robi release z plikami `.apk` + `.aab`).
2. **Lokalnie**: `npm run apk:build` (skrypt sam robi `npm run build`, `npx cap add android`, `cap sync` i gradle).
3. **Jedną komendą z terminala**: `npm run apk:ci` — odpala ten sam workflow przez `gh`, czeka i zapisuje
   `dist-apk/x-offline-debug.apk`.

Plik APK waży ~4 MB (Capacitor + WebView, bez Google Mobile Services). Minimalnie Android 7.0 (API 23),
docelowo API 35.

> Wersja debug instaluje się z komunikatem „nieznane źródło” — to normalne przy apkach z CI.
> Jeżeli chcesz, żeby dało się aktualizować bez utraty zapisanych postów, podpisz release własnym kluczem
> (secrets w repo: `ANDROID_KEYSTORE_*`) i instaluj przez `adb install -r`.

### Linki prosto z X do apki

APK ma intent-filtry, więc działa **„Udostępnij → X-Offline”** (tekst/link z dowolnej apki), **„Otwórz w
X-Offline”** dla linków do postów (`x.com/*/status/…`) i **„X-Offline”** w menu zaznaczonego tekstu. Link wpada
prosto do kolejki pobierania — dokładnie ta sama ścieżka obsługuje `share_target` PWA
(`/?import=1&url=…`).

---

## Testowanie bez prawdziwego X

```js
// w konsoli apki — wrzuć cokolwiek w kształcie GraphQL albo { tweets: [...] } prosto do bazy:
await window.__xoffline.ingest(JSON.stringify({ tweets: [/* … */] }));
```

W podglądzie X (APK, chrome://inspect): `window.__xofflineStatus()` pokaże, ile zebrano i dlaczego
ewentualnie stanęło; `window.__xofflineReplay('[{"id":1,"kind":"like","tweetId":"…","tweetUrl":"https://x.com/…/status/…"}]')`
odtwarza akcje ręcznie.

## Gdy apka coś wywali (diagnostyka)

Ta wersja przestała udawać, że wszystko jest zawsze w porządku:

- **ekran ratunkowy zamiast białej kartki** — jeśli jakikolwiek komponent rzuci wyjątkiem, `ErrorBoundary`
  pokazuje komunikat, przycisk „Wróć do aplikacji” i „Skopiuj raport”; zapisane posty zostają nietknięte,
- **dziennik zdarzeń** (Ustawienia → Diagnostyka) zbiera błędy JS, nieudane pobrania, logi zbieracza z APK,
  a nawet komunikaty konsoli strony X; liczbbę błędów widać jako plakietkę w nagłówku, dziennik kopiujesz jednym guzikiem,
- **odporność natywna**: jeśli renderer WebView padnie (typowe na słabym telefonie przy ciężkiej stronie),
  podgląd X pokazuje ekran „spróbuj ponownie” zamiast zabijać całą apkę; WebView jest zwalniany w bezpiecznej
  kolejności, a wszystkie wywołania z mostka idą na wątek główny.

Naprawione błędy z 0.1.x, które realnie zabijały interfejs:

| Objaw | Przyczyna | Naprawa |
| ----- | --------- | ------- |
| Wybór filtra „Z kolejki akcji” w *Zapisanych* wywalał całą apkę | `queuedIds` używane przed inicjalizacją (TDZ) → `ReferenceError` i odmontowanie Reacta | kolejność wyliczeń w `OfflineTab.tsx` + test regresyjny |
| Zapisane posty „samo się kasowało” powyżej `pruneKeepPosts` | auto-czyszczenie ustawiało `savedAt: null` (wyrzucało z biblioteki) | auto-czyszczenie zrzuca tylko media; tekst zostaje |
| `status()` podglądu X na części telefonów kończył się crashem/ostrzeżeniami WebView | `evaluateJavascript` wołane z wątku JavaBridge | wszystkie operacje WebView przez `webView.post` / `runOnUiThread` |
| Biały ekran po aktualizacji | brak obsługi błędów bazy (IndexedDB zablokowane) i brak error boundary | `dbReady()` z ekranem ratunkowym + `ErrorBoundary` |
| Starsze telefony: pobieranie wisiało w nieskończoność | `AbortSignal.timeout` nie istnieje w starych WebView | własny `timeoutSignal()` + ponowienia błędów przejściowych |

Starsze wersje wrzucały do bazy **zestaw demo**; przy pierwszym uruchomieniu tej wersji migracja Dexie (v3) czyści
te posty i konta, więc biblioteka zawiera wyłącznie prawdziwe treści.

## Struktura repo

```
apps/web/                 PWA + kod natywny (React 18, TS, Dexie, zustand, vite-plugin-pwa)
  src/lib/
    transport.ts         native | proxy | direct — jedna funkcja na wszystkie ścieżki + timeout/retry
    normalize.ts         surowe JSON-y X → PostRecord (odporność na zmiany shape'u)
    sources.ts           profile i posty po linkach (bez danych zastępczych, z podpowiedziami błędów)
    media.ts             cache binarek w IndexedDB, limit miejsca, przycinanie, trwałe miejsce
    download.ts          kolejka pobrań: postęp, anulowanie, ponowienie, współbieżność 3, historia
    posts.ts             zapis/unsave/delete, przeczytane, merge przy ponownym pobraniu, eksport/import
    capture.ts           polityka auto-zapisu (cel, priorytety, lustrzanka zakładek, dziennik zbierania)
    autosync.ts          „dociągnij do 200” dla trybu proxy + domykanie brakujących mediów
    actions.ts           kolejka polubień/zakładek: pending → sending → sent / error
    diagnostics.ts       dziennik błędów, logi z APK, zrzut do schowka/pliku
    native.ts            zapis pliku biblioteki (Documents → katalog apki), „wstecz”, cykl życia, deep linki
  bridge.ts              mostek z natywnym podglądem X (XLive) + share intent + dev-hook window.__xoffline
  src/db/db.ts           schemat Dexie (posts / blobs / accounts / jobs / meta / actions) + migracje
  src/components/        HomeTab, LiveTab, OfflineTab, SettingsTab, Reel, Sheets, PostCard, ErrorBoundary…
server/index.js          proxy node (tylko-do-czytania, allow-lista hostów, TTL cache, rate limit)
cloudflare/worker.mjs    to samo na Cloudflare Workers (darmowy deploy)
scripts/                 build APK lokalnie (build-apk.sh), apk-ci.sh (build na Actions), sync zasobów,
                         verify-android.mjs (kontrolka projektu natywnego bez Android SDK), ikony
.github/workflows/       android.yml (APK/AAB + release); definicje w ci/ czekają na skopiowanie
docs/APK.md              budowa i instalacja na telefonie
docs/DANE.md             endpointy, ograniczenia, co zrobić gdy X coś zmieni
docs/NATYWNE.md          jak działa natywny podgląd X (podsłuch GraphQL, kolejka akcji, udostępnianie)
```

## Ustawienia, które warto znać

| Ustawienie                   | Domyślnie | Po co                                                             |
| ---------------------------- | --------- | ----------------------------------------------------------------- |
| Limit offline                | 256 MB    | miękki sufit dla mediów; 0 = bez limitu                            |
| Auto-czyszczenie             | wł.       | powyżej limitu zrzuca media najstarszych zapisów (teksty zostają)  |
| Pobieraj wideo               | wł.       | klipy ważą najwięcej — wyłącz przy małym pakiecie                 |
| Trwałe miejsce na dane       | wł.       | system nie wyrzuci biblioteki przy braku miejsca                   |
| Słuchaj „oszczędzania danych”| wł.       | system zgłasza data saver → zapisujemy tekst, pomijamy media       |
| Pionowy czytnik              | wł.       | tapnięcie posta otwiera szpulkę ze swipe’em w górę/dół              |
| Otwarcie posta = przeczytany | wł.       | „Nieprzeczytane” samo się kurczy przy czytaniu                     |
| Aktualizuj przy starcie      | wył.      | przy otworzeniu apki dociąga świeże posty profili, które masz      |
| Szablon podglądu na żywo     | `…/{handle}` | własna strona w ramce (np. instancja lustrzana, której ufasz)  |
| Do ilu postów dokarmiać      | 200       | cel auto-zapisu; jak go osiągniesz, zbieranie staje                |
| Auto-zapis napotkanych postów| wł.       | każdy post minięty w podglądzie X ląduje w offline                |
| Auto-przewijanie podglądu     | wł.       | apka sama scrolluje, żeby zebrać partię (pauzuje, gdy ruszysz)     |
| Partia przy scrollu          | 8 ekranów | ile ekranów na jedną rundę zbierania                               |
| Lustrzanka zakładek X        | wł.       | to, co zapiszesz w X, trafia do offline (priorytet ponad cel)      |
| Nasze zapisy → zakładki X    | wył.      | odwrotność: zapis w apce klika zakładkę w X                         |
| Wysyłaj zaległe akcje        | wł.       | polubienia/zakładki kliknięte offline lecą, gdy wróci łącze (APK)   |
| Media tylko na Wi-Fi         | wył.      | przy mobile tylko tekst, zdjęcia i klipy doładujesz na sieci       |
| Przytnij nadmiar ponad cel   | wył.      | twardo trzyma bibliotekę w rozmiarze celu (najstarsze wypadają)     |

## Czego ta apka **nie** robi (i nie będzie)

- **w przeglądarce** nie loguje Cię do X (sesja zostaje na x.com) — logowanie z auto-zbieraniem jest w APK,
- nie czyta DM-ów i nie wchodzi w posty kont prywatnych poza tym, co sama widzisz na ekranie,
- nie zapisuje wątków i odpowiedzi (tylko główne posty), nie klika nic „w Twoim imieniu” poza kolejką,
  którą sam napełnisz (polubienia / zakładki),
- nie wstawia żadnych treści od siebie — brak internetu = brak nowych postów, nie „przykładowe” wpisy,
- nie działa z pełną gwarancją: endpointy syndykacji są **nieoficjalne**, dawkowane i mogą zniknąć — wtedy
  apka nadal czyta to, co już masz w pamięci (i to jest cały sens offline-first).

Szczegóły i plan B: [`docs/DANE.md`](docs/DANE.md), a architektura natywna: [`docs/NATYWNE.md`](docs/NATYWNE.md).

> **Uczciwie:** klikanie przycisków skryptem to automatyzacja konta, a regulamin X jej nie lubi.
> Domyślnie apka klika tylko to, co sam kliknąłeś offline (kilka–kilkadziesiąt akcji), a całość
> wyłączysz jednym suwakiem: *Ustawienia → Wysyłaj zaległe akcje przy łączu*.

---

## CI (GitHub Actions)

Definicje pipeline'ów leżą w [`ci/`](ci/) i czekają na skopiowanie do `.github/workflows/`:

```bash
npm run ci:install     # kopiuje ci/*.yml → .github/workflows/
```

Nie chcesz grzebać w terminalu? Wklej [`ci/android-quick.yml`](ci/android-quick.yml) jako
`.github/workflows/android.yml` przez edytor na GitHubie (instrukcja krok po kroku w
[`docs/APK.md`](docs/APK.md), pkt 1) — potem samo **Actions → Android APK → Run workflow** i plik APK
z sekcji *Artifacts*.

| Workflow        | kiedy                                     | efekt                                                           |
| --------------- | ----------------------------------------- | --------------------------------------------------------------- |
| **Web CI**      | push na `main`, pull request              | typecheck → testy → build PWA → smoke proxy → artefakt `web-dist` |
| **Android APK** | `workflow_dispatch` albo tag `v*`         | `x-offline-debug.apk` / `release.apk` + `.aab` + `x-offline-pwa.zip` |

**Czego tu nie da się zrobić**: skompilować APK w tym środowisku. Bez dostępu do `dl.google.com`,
`maven.google.com`, `services.gradle.org` i JDK nie ma jak odpalić Gradle — dlatego projekt natywny jest w repo,
`npm run verify:android` sprawdza wszystko, co da się sprawdzić bez narzędzi Google, a sam binarek robi Actions
(albo Twój Android Studio).

## Co dalej (kolejność, która ma sens)

1. **Prawdziwe profile**: wypal `npm run dev`, dodaj profile w *Na żywo* — jeśli proxy w Twojej sieci nie ma
   egressu, wystaw własny Worker (`cloudflare/worker.mjs`, 5 minut roboty).
2. **APK**: `npm run ci:install` → push → Actions → artefakt. Debug-APK jest w pełni używalny.
3. **Zbieranie w tle**: obecnie auto-scroll działa, dopóki podgląd X jest otwarty; kolejnym krokiem byłby
   `WorkManager` z powiadomieniem o postępie (dziś apka uczciwie mówi, że zbiera tylko na widoku).
4. **Wideo**: `video.twimg.com` zwraca MP4 — cache już je obsługuje; jeśli chcesz HLS, trzeba dodać
   `hls.js` albo natywny odtwarzacz (obecnie wyciągamy najlepsze MP4).
5. **iOS**: `npx cap add ios` + Xcode; brakuje tylko ekwiwalentu `XLiveActivity` (`WKUserScript` +
   `WKScriptMessageHandler`) — reszta jest w TypeScriptcie, patrz `docs/NATYWNE.md`.

## Licencja / zastrzeżenie

Projekt nie jest powiązany z X Corp. Treści postów należą do ich autorów; pobieranie publicznych danych
przez endpointy syndykacji jest „best effort” i robisz to na własną odpowiedzialność — apka niczego nie wysyła
poza żądaniami do X i do **Twojego** proxy.
