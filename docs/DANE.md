# Skąd apka bierze dane

## Czego używamy (i dlaczego)

Oficjalne API X v2 ma darmowy plan „nic poza postowaniem”, a czytanie osi czasu kosztuje krocie.
Zamiast tego apka korzysta z **publicznych endpointów syndykacji** — tych samych, które renderują
osadzone posty i widgety na tysiącach stron.

| Endpoint                                                                | Zwrot                     | Zastosowanie w apce                       |
| ----------------------------------------------------------------------- | ------------------------- | ----------------------------------------- |
| `GET https://cdn.syndication.twimg.com/tweet-result?id=…&token=…`        | JSON pojedynczego posta   | import z linków, pojedyncze zapisy         |
| `GET https://cdn.syndication.twimg.com/timeline/profile?screen_name=…`   | JSON (bywa 404)            | „pobierz N ostatnich postów” — ścieżka nr 1 |
| `GET https://syndication.twitter.com/srv/timeline-profile/screen-name/…`  | HTML z `__NEXT_DATA__`     | to samo, ścieżka nr 2 (parser w `normalize.ts`) |
| `pbs.twimg.com/media/…`, `video.twimg.com/…mp4`                           | obraz / wideo              | pliki do cache’u w IndexedDB                |
| `platform.twitter.com/embed/Tweet.html?id=…`                              | HTML (do osadzania)         | podgląd w ramce, gdy osadzone timeline padną |

`token` dla `tweet-result` wyliczamy dokładnie tak, jak widget X:

```js
((id / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')   // src/lib/normalize.ts → syndicationToken()
```

## Ograniczenia, które trzeba zaakceptować

- **Nieudokumentowane i dawkowane.** X potrafi zmienić kształt odpowiedzi albo odesłać
  „Nothing to see here - yet” (częste dla kont bez weryfikacji i dla żądań bez sesji).
  Z tego względu: normalizacja jest defensywna, a wszystko, co raz pobrane, leży lokalnie —
  **czytanie offline nie zależy od X w żadnym stopniu**.
- **CORS.** Przeglądarka nie przeczyta tych odpowiedzi wprost. Dlatego PWA używa proxy (`server/index.js`
  albo `cloudflare/worker.mjs`), a APK korzysta z `CapacitorHttp` (sieć natywna → brak limitów CORS).
- **Tylko to, co publiczne.** Zero logowania, zero DM-ów, zero kont prywatnych, zero wątków
  (zgodnie z założeniem: zapisujemy główne posty).
- **Prawo / regulamin.** Endpointy nie są w umowie deweloperskiej. Pobierasz publicznie dostępne treści
  do własnego użytku, na własną odpowiedzialność; nie sprzedawaj tego i nie buduj na tym serwera treści dla innych.

## Jak to przetestować bez apki

```bash
# zdrowie proxy + dostępność X
curl -s localhost:8787/api/health | jq

# ostatnie posty profilu (znormalizuje je apka, nie proxy)
curl -s "localhost:8787/api/timeline/nasa?count=10" | head -c 400

# pojedynczy post po linku
curl -s "localhost:8787/api/tweet/20" | jq '.text, .user.screen_name, .created_at'

# media przez proxy (przyda się, gdy pbs.twimg.com nie puści Ci CORS-u)
curl -sI "localhost:8787/api/media?url=https://pbs.twimg.com/media/XXXX.jpg" | head -5
```

## Jak dodać własne źródło (np. swoje API, plik, RSS)

Wystarczy spełnić kontrakt `sources.ts`:

```ts
// src/lib/sources.ts
export async function fetchProfile(handle: string, count: number): Promise<FetchResult>
export async function fetchPostsByLinks(links: string[], onEach?): Promise<FetchResult>
```

`FetchResult` to `{ posts: PostRecord[]; upstream: string; error?: string; hint?: string }`.
Najwygodniej: zbuduj posty przez `normalizeTweets(surowyJSON, 'syndication', { handle, count })` —
albo zmapuj swoje dane wprost na `PostRecord` (patrz `src/lib/types.ts`, a jako wzór `scripts/gen-demo-data.mjs`).
Reszta (cache mediów, limit miejsca, czytnik offline, eksport) zadziała bez zmian.

Jeśli chcesz źródło „na sztywno” bez edycji kodu: wgraj plik `.json` przez **Ustawienia → Biblioteka → Import
biblioteki**. Format to po prostu wynik **Eksport offline** (`{ app: "x-offline", version: 1, posts: [...] }`).

## Co dokładnie trafia do IndexedDB

```
posts    — treść, autor, data, statystyki, lista mediów, tagi, savedAt, sizeBytes
blobs    — binarki (zdjęcie/klip) keyed po URL-u, z MIME i rozmiarem
accounts — profile: ostatnia synchronizacja, auto-sync, licznik zapisów
jobs     — historia kolejki pobrań (status, postęp, błędy)
meta     — ustawienia użytkownika
```

Media są współdzielone między postami (klucz = hash URL-a), więc ten sam obrazek w 20 postach zajmuje jedno miejsce.
Przycinanie limitu (`pruneToCap`) usuwa **media** najstarszych zapisów, a treść posta zostaje — dalej da się go
czytać, tylko bez zdjęć (dostaje plakietkę „brak pliku”).

## Tryb demo

`npm run demo:gen` tworzy:

- 34 posty na 6 fikcyjnych kontach (`apps/web/src/fixtures/demo-posts.json`),
- 14 grafik + 3 animowane „klipy” jako SVG w `apps/web/public/demo-media/`.

Dane są w pełni lokalne i generowane deterministycznie (seed 1337), więc:

1. pokazują pełnię funkcji offline bez ani jednego żądania do X,
2. działają w sandboxie / na CI / w samolocie,
3. są sensownym fixture'em do testów (28 testów (logika + render)).

## Gdy X coś zmieni — lista kontrolna

1. `curl` health proxy → `upstream: "http-404"` albo `unreachable` → endpoint padł, nie Twoja apka.
2. Padł `timeline/profile`? Apka i tak spróbuje `timeline-profile` (HTML) — sprawdź `parseNextData()` na świeżym
   `curl` tej strony.
3. Zmienił się kształt posta? Złap jeden `tweet-result` i porównaj pola z `normalizeTweet()`.
   To jedno miejsce do poprawki — reszta apki żyje z `PostRecord`.
4. Media 403? X lubi wymagać `Referer`/`User-Agent` — to się ustawia w `server/index.js` (`UPSTREAM_UA`) i w `fetchBlob`.
5. Zawsze zostaje ścieżka manualna: wrzucasz link (albo eksport własnej kopii), apka zapisuje, czytnik działa.
