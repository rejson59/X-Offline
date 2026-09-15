# X-Offline

Prosta apka w stylu X (Twitter): **przewijasz posty w podglądzie, a one same zapisują się
w telefonie — potem czytasz je bez internetu**, jak pobrane filmiki na TikToku.

Jedna zasada: **posty pochodzą wyłącznie z podglądu X (WebView)**. Nie ma tu żadnego API,
żadnego serwera, żadnych profili do śledzenia ani żadnych sztucznych treści. Pusta biblioteka
= pusta lista i krótka podpowiedź, co zrobić.

## Jak z tego korzystać

1. **Otwórz zakładkę X** i zaloguj się normalnie — w APK to pełnoekranowy podgląd
   z Twoimi ciasteczkami, jak przeglądarka.
2. **Przewijaj jak zwykle.** Apka zapisuje to, co mija Twój wzrok, aż uzbiera Twój cel
   (domyślnie 200 postów). Może też przewijać za Ciebie.
3. **Czytaj w „Zapisanych”** — w samolocie, w pociągu, na słabym łączu. Polubienia
   i zakładki kliknięte offline polecą do X, gdy wróci sieć.

To wszystko. Trzy zakładki: **Zapisane · X · Ustawienia**.

## Dwie wersje z tego samego kodu

| Wersja | Jak | Co potrafi |
| ------ | --- | ---------- |
| **PWA** (przeglądarka) | `npm run dev`, build na dowolny hosting | czyta bibliotekę, instaluje się („Dodaj do ekranu”), eksport/import kopii |
| **APK** (Android) | `npm run apk:build` albo GitHub Actions | + logowanie do X w podglądzie, zapis przy przewijaniu, wysyłka akcji, odbiór linków z „Udostępnij” |

## Jak to działa

```
APK: Twoja sesja w natywnym podglądzie X (WebView)
  x.com + wstrzyknięty zbieracz (public/inject/xoffline-capture.js)
    │  podsłuch odpowiedzi X → pełne posty (autor, tekst, media, polubienia, zakładki)
    │  auto-scroll do Twojego celu, z licznikiem
    │  odtwarzanie zaległych akcji w prawdziwym UI X
    ▼
  bridge.ts → capture.ts (polityka: co zapisywać, kiedy stanąć)
    ▼
  IndexedDB: posty + zdjęcia/klipy jako binarki → zero żądań sieci przy czytaniu
    ▼
  „Zapisane” + pionowy czytnik — działa w samolocie
```

Więcej: [`docs/NATYWNE.md`](docs/NATYWNE.md) (podgląd, zbieracz, kolejka akcji),
[`docs/DANE.md`](docs/DANE.md) (skąd dokładnie biorą się posty),
[`docs/APK.md`](docs/APK.md) (budowa i instalacja APK).

## Szybki start

```bash
npm install
npm run dev       # apka na :5173
```

Polecenia:

```bash
npm run build        # apps/web/dist (PWA gotowe na hosting)
npm run test         # 72 testy: zapis offline, limit celu, kolejka akcji, UI, mostek natywny
npm run typecheck
npm run apk:build    # lokalny build debug-APK (wymaga JDK 21 + Android SDK)
npm run apk:ci       # build APK na GitHub Actions, ściąga artefakt do dist-apk/ (wystarczy gh)
npm run verify:android  # kontrola projektu natywnego bez Android SDK
```

## APK — plik do zainstalowania

Szczegóły w [`docs/APK.md`](docs/APK.md). W skrócie:

1. **GitHub Actions** (bez Android Studio): Actions → **Android APK** → Run workflow →
   artefakt `x-offline-apk-debug` (na tagu `v*` powstaje release z `.apk` + `.aab`).
2. **Lokalnie**: `npm run apk:build`.
3. **Jedną komendą**: `npm run apk:ci`.

APK waży ~4 MB, bez Google Mobile Services. Minimalnie Android 7.0 (API 23).

APK łapie też linki: **„Udostępnij → X-Offline”** z dowolnej apki otwiera post w podglądzie X,
gdzie zapisuje się do offline. To samo robi share target PWA (`/?import=1&url=…`).

## Gdy coś nie działa

- **Ekran ratunkowy zamiast białej kartki** — błąd wyświetlania nie rusza zapisanych postów.
- **Dziennik** (Ustawienia → Zaawansowane) zbiera błędy i logi zbieracza; kopiujesz go jednym guzikiem.
- **Testowanie bez X**: w konsoli apki `await window.__xoffline.ingest(JSON.stringify({ tweets: […] }))`
  wrzuca posty prosto do bazy. W podglądzie X (chrome://inspect): `window.__xofflineStatus()`.

## Struktura repo

```
apps/web/                 PWA + kod aplikacji (React 18, TS, Dexie, zustand, vite-plugin-pwa)
  src/lib/
    bridge.ts            mostek z natywnym podglądem X + share intent + dev-hook
    capture.ts           polityka zapisu: cel, priorytety, lustrzanka zakładek
    normalize.ts         surowe JSON-y X → PostRecord (odporność na zmiany kształtu)
    transport.ts         pobieranie plików mediów (sieć natywna w APK, fetch w PWA)
    media.ts             cache binarek, limit miejsca, trwałe miejsce
    posts.ts             zapis/usuwanie, przeczytane, eksport/import biblioteki
    actions.ts           kolejka polubień/zakładek: pending → sending → sent / error
    diagnostics.ts       dziennik błędów i logów
    native.ts            zapis plików, przycisk „wstecz”, cykl życia, deep linki
  src/db/db.ts           schemat Dexie (posts / blobs / actions / meta) + migracje
  src/components/        FeedTab (Zapisane), BrowseTab (X), SettingsTab, PostCard,
                         Reel (czytnik), Sheets, Icons, ErrorBoundary
  public/inject/         wstrzykiwany zbieracz (kopiowany też do android/.../assets)
android/                 projekt natywny (Capacitor + XLiveActivity + XLivePlugin)
scripts/                 build APK, sync zasobów, kontrola projektu, ikony
docs/                    APK.md, DANE.md, NATYWNE.md
```

## Ustawienia, które warto znać

| Ustawienie | Domyślnie | Po co |
| ---------- | --------- | ----- |
| Cel zbierania | 200 | ile postów trzymać w offline |
| Zapisuj przy przewijaniu | wł. | każdy minięty post ląduje w offline |
| Przewijaj za mnie | wł. | apka sama zbiera partię postów |
| Zakładki X też się zapisują | wł. | zapisane w X trafiają do offline |
| Limit offline | 256 MB | sufit dla mediów; 0 = bez limitu |
| Sprzątaj automatycznie | wł. | powyżej limitu usuwa media najstarszych (teksty zostają) |
| Pobieraj wideo | wł. | klipy ważą najwięcej — wyłącz przy małym pakiecie |
| Pełnoekranowy czytnik | wł. | stuknięcie posta otwiera widok ze swipe'em |

## Czego ta apka nie robi

- nie pobiera nic z żadnych API ani serwerów — tylko z podglądu X,
- w przeglądarce nie loguje Cię do X (sesja jest w podglądzie w APK),
- nie czyta DM-ów ani kont prywatnych poza tym, co sam widzisz na ekranie,
- nie zapisuje odpowiedzi (tylko główne posty),
- nie wstawia żadnych treści od siebie — brak nowych postów to brak nowych postów,
- nie klika nic w Twoim imieniu poza kolejką, którą sam napełniasz.

> Klikanie skryptem to automatyzacja konta, a regulamin X jej nie lubi. Apka odtwarza tylko
> to, co sam kliknąłeś offline (polubienia / zakładki), po kilka–kilkadziesiąt akcji naraz.

## Licencja / zastrzeżenie

Projekt nie jest powiązany z X Corp. Treści postów należą do ich autorów. Zapisujesz publicznie
widoczne dla Ciebie treści do własnego użytku, na własną odpowiedzialność.
