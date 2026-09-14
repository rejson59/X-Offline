# Natywny podgląd X (logowanie + auto-zapis + kolejka akcji)

To jest serce wersji APK. W przeglądarce tej ścieżki **nie ma** i nie będzie — `x.com` nie pozwala
osadzić się w ramce ani trzymać swojej sesji na innej domenie.

## Co dokładnie dostajesz

```
MainActivity (Capacitor / PWA w WebView)
   │  przycisk „Otwórz X” → Capacitor.Plugins.XLive.open({tab:'home', autoScroll, maxPosts})
   ▼
XLiveActivity  ── pełnoekranowy WebView na https://x.com/home
   │  · CookieManager + DOM storage → logujesz się normalnie, sesja przeżywa restart apki
   │  · wstrzykiwany assets/inject/xoffline-capture.js
   │        ├─ hook fetch/XHR → wyłapuje odpowiedzi /i/api/graphql/* (pełne tweety: autor, media,
   │        │   polubienia, zakładki, „favorited”, „bookmarked”)
   │        ├─ auto-scroll do limitu (cel = ustawienie „do ilu postów”), pauza gdy weźmiesz przewijanie sam
   │        ├─ widżet na dole ekranu: licznik, „dociągnij”, „pauza”, ✕
   │        └─ __xofflineReplay(json) → klika [data-testid="like"|"unlike"|"bookmark"|"removeBookmark"]
   │                 w prawdziwym UI X, dla postów polubionych/zapisanych offline
   ▼
OfflineBridge (@JavascriptInterface „AndroidXOffline”)  →  XLivePlugin.notifyListeners(…)
   ▼
apps/web/src/lib/bridge.ts → capture.ts (polityka zapisu) → IndexedDB (Dexie) + blobs (media)
```

## Dlaczego podsłuch, a nie skrobanie DOM-u

DOM X to `div`-y po generowanych klasach, które zmieniają się co kilka tygodni. Odpowiedzi GraphQL
są natomiast **dokładnie tym JSON-em**, na którym strona sama rysuje timeline — z nim da się pracować
latami (struktura `legacy`/`entities`/`mediaDetails` jest stabilniejsza niż klasy CSS). Zbieracz
i tak ma obronę: jak nic nie wyciągnie, licznik w widżecie po prostu staje i apka nie udaje, że działa.

## Kolejka akcji (polubienia i zakładki z offline)

| Stan w bazie   | Znaczenie                                                            |
| -------------- | -------------------------------------------------------------------- |
| `pending`      | kliknąłeś w czytniku offline, czeka na łącze                          |
| `sending`      | przekazane do WebView, X jeszcze nie odpowiedziało                    |
| `sent`         | przycisk faktycznie kliknięty (albo API potwierdziło)                  |
| `error`        | nie kliknąłem (zmiana UI, post usunięty, sesja wygasła) — można ponowić |

Logika: `apps/web/src/lib/actions.ts`, transport: `window.__xofflineReplay` w inject +
`XLivePlugin.replay`. Świeżo pobrany post **nie nadpisuje** Twoich lokalnych flag, jeśli dla niego
czeka akcja (patrz `upsertPosts`) — inaczej odświeżanie anuluowałoby Twoje polubienia.

## Zakładki X w dwie strony

- `mirrorBookmarks` (domyślnie wł.): wchodzisz w X w `Zakładki` → to, co tam jest, wskakuje do offline
  (skrypt oznacza źródło `bookmarks-mirror`, a `capture.ts` traktuje takie posty priorytetowo — wchodzą
  ponad limit celu, bo sam fakt zapisania w X jest Twoją intencją).
- `mirrorToBookmarks` (domyślnie wył.): zapisanie posta w X-Offline klika też zakładkę w X.
  Wyłączone, żeby nie zaśmiecać Ci konta bez pytania.

## Ryzyka — przeczytaj

1. **Automatyzacja jest contra ToS X.** Klikanie serduszek/zakładek skryptem to automatyzacja konta;
   realnie przy kilku–kilkudziesięciu akcjach dziennie ryzyko jest małe, ale jest (rate limit, timout,
   w ostateczności ograniczenia konta). Ustawienie `Wysyłaj zaległe akcje przy łączu` możesz wyłączyć
   i klikać samemu.
2. **Zmiana UI/API** → przestanie zbierać albo klikać. Naprawa to zwykle jedna linia w
   `xoffline-capture.js` (`isTweetLike`, lista `data-testid`) albo w `normalize.ts`.
3. **Prywatność**: jedyne, co apka robi z Twoją sesją, to (a) czyta to, i tak widoczne na ekranie,
   (b) klika przyciski, które kliknąłbyś. Nie wysyła nic na swoje serwery — ich nie ma.
4. **Nie ruszamy ciasteczek** ani `localStorage` X w żaden inny sposób niż domyślny WebView.

## Debugowanie na telefonie

```bash
adb forward tcp:9222 tcp:9222      # WebView ma webContentsDebuggingEnabled (capacitor.config.ts)
# Chrome na desktopie → chrome://inspect → „Inspect” przy x.com
```

W konsoli podglądu X możesz ręcznie sprawdzić mostek:

```js
window.__xofflineStatus();                                  // {collected, target, info, loggedIn}
window.__xofflineReplay('[{"id":1,"kind":"like","tweetId":"123…","tweetUrl":"https://x.com/u/status/123…"}]');
```

A w samej apce (bez WebView) wrzucić surowy JSON prosto do bazy:

```js
await window.__xoffline.ingest(JSON.stringify({ tweets: [ … ] }));
```

## Co zmienić, żeby dodać iOS

Brak `XLivePlugin` na iOS to jedyne, czego brakuje: ten sam inject + `WKUserScript` i
`contentController` z `WKScriptMessageHandler` dają to samo (`android/…/XLiveActivity.java` ma ~200 linii,
ekwiwalent w Swift podobnie). Reszta jest w TypeScriptie.
