/*
 * X-Offline — skrypt wstrzykiwany do natywnego podglądu X (WebView w APK).
 *
 * Robi trzy rzeczy, wszystkie ostrożnie i bez ruszania Twoich danych poza kolekcję postów:
 *  1) PODSŁUCH: hookuje fetch/XHR i wyłapuje odpowiedzi `x.com/i/api/graphql/*` — to te same
 *     JSON-y, które strona X sama pobiera. Dzięki temu mamy kompletne posty (autor, media,
 *     polubienia, zakładki) bez skrobania DOM-u i bez walki z CORS (jesteśmy w domenie x.com).
 *  2) WIDOCZNY WIDŻET: licznik „zebrane N / cel”, pauza auto-zpisu, „dociągnij partię” (auto-scroll)
 *     i ✕ zamykający podgląd.
 *  3) ODTWARZANIE AKCJI: `window.__xofflineReplay(json)` klika serduszko / zakładkę w prawdziwym
 *     UI X dla postów, które polubiłeś offline (najpierw na aktualnej stronie, potem przez
 *     otwarcie linku do posta). To celowo NIE jest kombinowanie z nieudokumentowanym API —
 *     to klikanie w przyciski, które i tak byś kliknął.
 *
 * Wszystko jest defensive: jak X zmieni DOM albo ścieżki, apka dalej działa, tylko przestaje
 * zbierać — i o tym informuje widżet.
 */
(function () {
  'use strict';

  var HOST_OK = /(^|\.)(x\.com|twitter\.com)$/i;
  var already = window.__xofflineInjected;
  if (already) {
    if (typeof window.__xofflineConfigure === 'function') window.__xofflineConfigure(window.__xofflineConfig);
    return;
  }

  var bridge = window.AndroidXOffline || null;
  var state = {
    enabled: true,
    autoScroll: true,
    target: 200,
    batch: 8,
    collected: 0,
    seen: {},
    pausedByUser: false,
    scrolling: false,
    scrollTimer: null,
    lastInfo: 'gotowy',
    replaying: false,
  };

  function send(kind, payload) {
    if (!bridge) return;
    try {
      if (kind === 'tweets') bridge.onTweets(typeof payload === 'string' ? payload : JSON.stringify(payload));
      else if (kind === 'status') bridge.onStatus(JSON.stringify(payload));
      else if (kind === 'actions') bridge.onActionsResult(JSON.stringify(payload));
      else if (kind === 'log') bridge.onLog(String(payload));
    } catch (e) {
      /* WebView bez interfejsu — ignorujemy */
    }
  }

  // ————————————————————————————————— poszukiwanie tweetów w odpowiedziach

  function isTweetLike(o) {
    if (!o || typeof o !== 'object') return false;
    var legacy = o.legacy || o;
    var id = legacy.id_str || o.rest_id || o.id_str;
    if (!id) return false;
    return !!(legacy.full_text || legacy.text || o.text || (legacy.extended_entities && legacy.extended_entities.media));
  }

  // Payloady GraphQL potrafią być głębokie (result.legacy.core.user_results…), więc chodzimy
  // do 14 poziomów, ale z limitem odwiedzin — żeby nie męcić telefonu na 5-megabajtowym JSON-ie.
  var walkBudget = 0;

  function collectCandidates(node, out, depth) {
    if (!node || depth > 14 || out.length > 400) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) collectCandidates(node[i], out, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (isTweetLike(node)) {
      out.push(node);
      return;
    }
    if (++walkBudget > 60000) return;
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      if (v && typeof v === 'object') collectCandidates(v, out, depth + 1);
    }
  }

  function ingestFromJson(text, source) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return 0;
    }
    var found = [];
    collectCandidates(data, found, 0);
    if (!found.length) return 0;
    var fresh = [];
    for (var i = 0; i < found.length; i++) {
      var t = found[i];
      var legacy = t.legacy || t;
      var id = String(legacy.id_str || t.rest_id || t.id_str || '');
      if (!id || state.seen[id]) continue;
      if (legacy.retweeted_status_result || (legacy.retweeted_status && !legacy.full_text)) continue;
      var parent = (t.parent && t.parent.id_str) || legacy.in_reply_to_status_id_str;
      if (parent && !legacy.self_thread.id_str) continue; // tylko główne posty
      state.seen[id] = 1;
      fresh.push(t);
      state.collected++;
    }
    if (fresh.length) {
      send('tweets', JSON.stringify({ source: source, collectedAt: Date.now(), tweets: fresh }));
      render();
      if (state.collected >= state.target) {
        stopScroll();
        state.lastInfo = 'cel osiągnięty: ' + state.collected;
        render();
      }
    }
    return fresh.length;
  }

  function sourceFor(url) {
    if (/\/i\/bookmarks/.test(url)) return 'bookmarks-mirror';
    if (/graphql\//.test(url)) return 'live-scroll';
    return 'other';
  }

  function interesting(url) {
    return /x\.com\/i\/api\/graphql\//.test(url) || /twitter\.com\/i\/api\/graphql\//.test(url);
  }

  // ————————————————————————————————— hooki sieciowe

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var p = nativeFetch.apply(this, arguments);
      if (!state.enabled || state.pausedByUser || !interesting(url)) return p;
      return p.then(function (res) {
        try {
          var clone = res.clone();
          clone
            .text()
            .then(function (txt) {
              ingestFromJson(txt, sourceFor(url));
            })
            .catch(function () {});
        } catch (e) {}
        return res;
      });
    };
  }

  var open = XMLHttpRequest.prototype.open;
  var sendXhr = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xoUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (state.enabled && !state.pausedByUser && interesting(xhr.__xoUrl || '')) {
      xhr.addEventListener('load', function () {
        try {
          if ((xhr.responseText || '').length < 8_000_000) ingestFromJson(xhr.responseText, sourceFor(xhr.__xoUrl));
        } catch (e) {}
      });
    }
    return sendXhr.apply(xhr, arguments);
  };

  // ————————————————————————————————— auto-scroll

  function stopScroll() {
    state.scrolling = false;
    if (state.scrollTimer) {
      clearInterval(state.scrollTimer);
      state.scrollTimer = null;
    }
  }

  function startScroll(reason) {
    if (state.scrolling || !state.autoScroll) return;
    state.scrolling = true;
    state.lastInfo = 'przewijam (' + (reason || 'ręcznie') + ')…';
    render();
    var steps = Math.max(3, state.batch);
    var done = 0;
    state.scrollTimer = setInterval(function () {
      if (state.pausedByUser || !state.enabled) {
        stopScroll();
        render();
        return;
      }
      var h = document.documentElement;
      var before = h.scrollTop;
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      done++;
      if (state.collected >= state.target || done > steps * 4 || h.scrollTop === before) {
        stopScroll();
        state.lastInfo = 'stop: ' + state.collected + ' postów';
        render();
      }
    }, 900);
  }

  ['wheel', 'touchstart', 'keydown'].forEach(function (evt) {
    window.addEventListener(
      evt,
      function () {
        if (state.scrolling) {
          stopScroll();
          state.lastInfo = 'przewijanie przejęte przez Ciebie';
          render();
        }
      },
      { passive: true },
    );
  });

  function onVisible() {
    if (!state.enabled || state.pausedByUser || !state.autoScroll) return;
    if (state.collected < state.target) startScroll('widoczność');
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) setTimeout(onVisible, 1200);
  });

  // ————————————————————————————————— widżet

  var el = null;

  function css() {
    if (document.getElementById('xo-style')) return;
    var s = document.createElement('style');
    s.id = 'xo-style';
    s.textContent =
      '.xo-pill{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483647;' +
      'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:999px;background:rgba(0,0,0,.86);' +
      'color:#e7e9ea;font:600 12.5px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;border:1px solid rgba(231,233,234,.22);' +
      'backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.45)}' +
      '.xo-pill b{color:#1d9bf0}.xo-pill button{border:0;background:rgba(231,233,234,.12);color:#e7e9ea;' +
      'border-radius:999px;padding:5px 9px;font:inherit;cursor:pointer}.xo-pill button:active{transform:scale(.97)}' +
      '.xo-dot{width:7px;height:7px;border-radius:50%;background:#00ba7c;flex:none}.xo-dot.off{background:#71767b}';
    (document.head || document.documentElement).appendChild(s);
  }

  function render() {
    if (!document.body) return;
    css();
    if (!el) {
      el = document.createElement('div');
      el.className = 'xo-pill';
      el.innerHTML =
        '<span class="xo-dot"></span><span class="xo-text"></span>' +
        '<button class="xo-scroll">dociągnij</button>' +
        '<button class="xo-pause">pauza</button>' +
        '<button class="xo-close">✕</button>';
      document.body.appendChild(el);
      el.querySelector('.xo-scroll').addEventListener('click', function () {
        state.target = Math.max(state.collected + 1, state.target);
        startScroll('przycisk');
      });
      el.querySelector('.xo-pause').addEventListener('click', function () {
        state.pausedByUser = !state.pausedByUser;
        if (state.pausedByUser) stopScroll();
        render();
      });
      el.querySelector('.xo-close').addEventListener('click', function () {
        if (bridge && bridge.closeHost) bridge.closeHost();
        else history.back();
      });
    }
    var dot = el.querySelector('.xo-dot');
    dot.className = 'xo-dot' + (state.enabled && !state.pausedByUser ? '' : ' off');
    el.querySelector('.xo-text').innerHTML =
      'X-Offline: <b>' + state.collected + '</b>/' + state.target + ' · ' + esc(state.lastInfo);
    el.querySelector('.xo-pause').textContent = state.pausedByUser ? 'wznów' : 'pauza';
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  // ————————————————————————————————— odtwarzanie akcji (serduszko / zakładka)

  function findArticle(id) {
    var nodes = document.querySelectorAll('article[data-id]');
    for (var i = 0; i < nodes.length; i++) if (nodes[i].getAttribute('data-id') === String(id)) return nodes[i];
    var arts = document.querySelectorAll('article[data-testid="tweet"]');
    for (var j = 0; j < arts.length; j++) {
      var link = arts[j].querySelector('a[href*="/status/"]');
      if (link && link.href.indexOf('/status/' + id) > -1) return arts[j];
    }
    return null;
  }

  function clickIn(article, tests) {
    for (var i = 0; i < tests.length; i++) {
      var btn = article.querySelector('[data-testid="' + tests[i] + '"]');
      if (btn) {
        btn.click();
        return tests[i];
      }
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function applyAction(action) {
    var article = findArticle(action.tweetId);
    if (!article) return { id: action.id, ok: false, error: 'post niewidoczny' };
    var want = action.kind;
    var clicked;
    if (want === 'like') clicked = clickIn(article, ['unlike', 'like']);
    else if (want === 'unlike') clicked = clickIn(article, ['like', 'unlike']);
    else if (want === 'bookmark') clicked = clickIn(article, ['removeBookmark', 'bookmark']);
    else clicked = clickIn(article, ['bookmark', 'removeBookmark']);
    if (!clicked) return { id: action.id, ok: false, error: 'brak przycisku ' + want };
    return { id: action.id, ok: true, via: clicked };
  }

  /**
   * Akcje, których nie dało się kliknąć na bieżącym widoku, dokładamy przez otwarcie linku do posta.
   * Robimy to sekwencyjnie i spokojnie, żeby nie wyglądało to atakowo i żeby X nadążył.
   */
  async function runReplay(actions) {
    if (state.replaying) return [];
    state.replaying = true;
    var all = [];
    var backTo = location.href;
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      var res = applyAction(action);
      if (!res.ok && action.tweetUrl) {
        state.lastInfo = 'otwieram ' + action.tweetId;
        render();
        location.href = action.tweetUrl;
        var ok = false;
        for (var wait = 0; wait < 24 && !ok; wait++) {
          await sleep(500);
          var retry = applyAction(action);
          ok = retry.ok;
          if (ok) {
            retry.id = action.id;
            res = retry;
          }
        }
        if (!ok) res = { id: action.id, ok: false, error: 'nie kliknąłem (zmiana UI?)' };
        await sleep(700);
        location.href = backTo;
        await sleep(700);
      }
      all.push(res);
      send('actions', [res]);
      await sleep(400);
    }
    state.replaying = false;
    state.lastInfo = 'akcje odtworzone: ' + all.length;
    render();
    return all;
  }

  window.__xofflineReplay = function (actionsJson) {
    var actions = [];
    try {
      actions = typeof actionsJson === 'string' ? JSON.parse(actionsJson) : actionsJson;
    } catch (e) {
      return [];
    }
    if (!Array.isArray(actions) || !actions.length) return [];
    runReplay(actions).then(function (all) {
      send('actions', all);
    });
    return { started: actions.length };
  };

  // ————————————————————————————————— konfiguracja z natywnego kodu

  window.__xofflineConfigure = function (cfg) {
    if (!cfg) return;
    if (typeof cfg.enabled === 'boolean') state.enabled = cfg.enabled;
    if (typeof cfg.autoScroll === 'boolean') state.autoScroll = cfg.autoScroll;
    if (typeof cfg.target === 'number') state.target = cfg.target;
    if (typeof cfg.batch === 'number') state.batch = cfg.batch;
    render();
    if (state.enabled && state.autoScroll && state.collected < state.target) startScroll('konfiguracja');
  };

  window.__xofflineStatus = function () {
    return {
      enabled: state.enabled,
      collected: state.collected,
      target: state.target,
      scrolling: state.scrolling,
      info: state.lastInfo,
      host: location.hostname,
      loggedIn: Boolean(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')),
    };
  };

  // start tylko na x.com / twitter.com
  if (HOST_OK.test(location.hostname)) {
    send('status', { host: location.hostname, url: location.href, event: 'injected' });
    setTimeout(function () {
      render();
      if (state.enabled && state.autoScroll) startScroll('start');
    }, 900);
  }

  // diagnosticzny wgląd (devtools w apce + testy vitest) — niczemu nie przeszkadza
  window.__xofflineInternals = {
    isTweetLike: isTweetLike,
    collectCandidates: collectCandidates,
    sourceFor: sourceFor,
    interesting: interesting,
    state: state,
    ingestFromJson: ingestFromJson,
    findArticle: findArticle,
  };
})();
