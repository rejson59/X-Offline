# Skąd apka bierze dane

Krótko: **wyłącznie z podglądu X (WebView)**. Nie ma żadnego API, serwera ani proxy.

## Jedyna droga postów

1. W APK otwierasz zakładkę **X** — to natywny WebView na prawdziwym x.com, z Twoimi
   ciasteczkami. Logujesz się tam normalnie, jak w przeglądarce.
2. Wstrzyknięty zbieracz (`apps/web/public/inject/xoffline-capture.js`, kopia w
   `android/app/src/main/assets/inject/`) podsłuchuje odpowiedzi, które X i tak wysyła
   do strony (pełne tweety: autor, tekst, media, stan polubień/zakładek).
3. Każdy wyłapany post przechodzi przez `capture.ts` (polityka: cel, priorytety) i ląduje
   w IndexedDB razem z mediami ściągniętymi jako binarki.
4. Czytanie w „Zapisanych” nie wykonuje **żadnych** żądań sieciowych — wszystko jest lokalne.

W przeglądarce (PWA) nie ma podglądu z sesją, więc nie ma też zbierania — PWA służy do
czytania biblioteki zebranej w APK (przenosisz ją eksportem/importem kopii `.json`).

## Co się dzieje z mediami

- Zdjęcia i klipy ściągamy jako pliki i trzymamy w IndexedDB (`blobs`).
- W APK pobranie idzie siecią natywną (`CapacitorHttp`), w PWA zwykłym `fetch()`.
- Gdy plik się nie pobierze, **tekst posta i tak zostaje** — media dociągniesz później
  jednym przyciskiem („Dociągnij media” w ustawieniach albo ikona przy poście).

## Ograniczenia, które trzeba zaakceptować

- **Zbieranie wymaga otwartego podglądu.** Apka zapisuje tylko to, co realnie mija Twój
  wzrok (albo co przewinie auto-scroll). Nic nie dzieje się w tle.
- **Tylko główne posty.** Odpowiedzi i wątki pomijamy — zapisujemy to, co ma samodzielną treść.
- **X może zmienić stronę.** Zbieracz czyta odpowiedzi w kilku znanych kształtach
  (GraphQL + syndykacja) i jest odporny na drobne zmiany, ale grubsza przebudowa x.com
  może wymagać aktualizacji skryptu. Testy w `inject.test.ts` pilnują kontraktu.
- **Prawo / regulamin.** Zapisujesz treści widoczne dla Ciebie, do własnego użytku,
  na własną odpowiedzialność. Nie buduj na tym serwera treści dla innych.

## Jak to przetestować bez telefonu

```js
// w konsoli apki — wrzuć posty w kształcie GraphQL prosto do bazy:
await window.__xoffline.ingest(JSON.stringify({ tweets: [/* … */] }));
```

W podglądzie X (APK, chrome://inspect): `window.__xofflineStatus()` pokaże, ile zebrano
i dlaczego ewentualnie stanęło.
