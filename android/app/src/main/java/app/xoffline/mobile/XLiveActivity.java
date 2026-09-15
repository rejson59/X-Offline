package app.xoffline.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import org.json.JSONObject;

/**
 * XLiveActivity — pełnoekranowy WebView na prawdziwym x.com z Twoją sesją.
 *
 * Po co osobna aktywność zamiast strony w Capacitorze? Żeby strona X działała w ORYGINALNEJ
 * domenie: ciasteczka, localStorage i service worker X zostają tam, gdzie powinny, a my tylko
 * podsłuchujemy odpowiedzi GraphQL i dokładamy własny widżet (plik assets/inject/xoffline-capture.js).
 *
 * Wszystko, co robi z WebView, leci przez wątek główny (`post`/`runOnUiThread`) — wcześniej
 * `status()` z pluginu wołał `evaluateJavascript` z wątku JavaBridge, co kończyło się
 * ostrzeżeniami, a na części telefonów wywalało proces. Dodatkowo łapiemy `onRenderProcessGone`:
 * gdy renderer Chromium padnie (typowe przy ciężkich stronach na słabym telefonie), apka
 * nie umiera razem z nim — pokazuje komunikat i pozwala spróbować ponownie.
 */
public class XLiveActivity extends Activity {

    public static volatile XLiveActivity instance;

    private static final String TAB_HOME = "https://x.com/home";
    private static final String TAB_BOOKMARKS = "https://x.com/i/bookmarks";
    private static final String INJECT_ASSET = "inject/xoffline-capture.js";

    private WebView webView;
    private FrameLayout root;
    private String startUrl = TAB_HOME;
    private boolean injected = false;
    private boolean rendererDead = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;

        applyIntent(getIntent());

        root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        createWebView();

        if (savedInstanceState != null && savedInstanceState.getString("xoUrl") != null && !rendererDead) {
            webView.restoreState(savedInstanceState);
            if (webView.getUrl() == null) webView.loadUrl(savedInstanceState.getString("xoUrl"));
        } else {
            webView.loadUrl(startUrl);
        }
    }

    /** Czyta parametry podglądu (zakładka, profil, zapytanie, bezpośredni link). */
    private void applyIntent(Intent intent) {
        if (intent == null) return;
        String tab = safeExtra(intent, "tab");
        String handle = safeExtra(intent, "handle");
        String query = safeExtra(intent, "query");
        String direct = safeExtra(intent, "url");
        if (direct.startsWith("http")) {
            startUrl = direct;
        } else if ("bookmarks".equals(tab)) {
            startUrl = TAB_BOOKMARKS;
        } else if ("profile".equals(tab) && handle.matches("[A-Za-z0-9_]{1,15}")) {
            startUrl = "https://x.com/" + handle;
        } else if ("search".equals(tab) && !query.isEmpty()) {
            startUrl = "https://x.com/search?q=" + Uri.encode(query) + "&src=typed_query&f=live";
        }
    }

    private static String safeExtra(Intent intent, String key) {
        String value = intent.getStringExtra(key);
        return value == null ? "" : value;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Podgląd ma czytać x.com, a nie grzebać w plikach telefonu.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(true);
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new OfflineBridge(this), "AndroidXOffline");

        webView.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        Uri uri = request.getUrl();
                        String scheme = uri.getScheme();
                        if (scheme == null) return true;
                        String host = uri.getHost();
                        if (host != null && (host.endsWith("x.com") || host.endsWith("twitter.com"))) return false;
                        if ("http".equals(scheme) || "https".equals(scheme)) return false; // zostaw w WebView
                        try {
                            Intent open = new Intent(Intent.ACTION_VIEW, uri);
                            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(open);
                        } catch (Exception ignored) {
                        }
                        return true;
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        inject();
                    }

                    @Override
                    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                        if (request != null && request.isForMainFrame()) {
                            XLivePlugin.forward("captureLog", "{\"error\":\"strona X się nie wczytała\"}");
                        }
                    }

                    /** Renderer Chromium padł — zamiast wywalić apkę, pokazujemy ekran „spróbuj ponownie”. */
                    @Override
                    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                        rendererDead = true;
                        injected = false;
                        showRendererCrashScreen();
                        return true;
                    }
                });

        webView.setWebChromeClient(
                new WebChromeClient() {
                    @Override
                    public boolean onConsoleMessage(ConsoleMessage message) {
                        // Komunikaty konsoli strony X trafiają do dziennika apki — bez tego nie da
                        // się dojść, czemu zbieracz przestał działać na konkretnym telefonie.
                        if (message != null && message.message() != null) {
                            String text = message.message();
                            XLivePlugin.forward("captureLog", "{\"message\":" + OfflineBridge.quote(text) + "}");
                        }
                        return super.onConsoleMessage(message);
                    }
                });

        root.addView(
                webView,
                new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private void showRendererCrashScreen() {
        try {
            if (webView != null) {
                root.removeView(webView);
                webView.destroy();
                webView = null;
            }
            final TextView info = new TextView(this);
            info.setText("Podgląd X został zamknięty przez system (brakło pamięci na renderowanie strony).\n\nTwoje zapisane posty są bezpieczne — nic z nich nie zniknęło.\nDotknij ekranu, żeby spróbować ponownie.");
            info.setTextColor(Color.WHITE);
            info.setPadding(48, 120, 48, 48);
            info.setTextSize(15f);
            info.setOnClickListener(v -> recreate());
            root.addView(info, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            XLivePlugin.forward("captureLog", "{\"error\":\"renderer WebView padł — pokazuję ekran ratunkowy\"}");
        } catch (Exception ignored) {
        }
    }

    /** Wstrzykuje zbieracz + konfigurację. Idempotentne — skrypt sam sprawdza `window.__xofflineInjected`. */
    private void inject() {
        if (webView == null || rendererDead) return;
        final String script;
        try {
            java.io.InputStream is = getAssets().open(INJECT_ASSET);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int read;
            while ((read = is.read(buf)) > 0) out.write(buf, 0, read);
            is.close();
            script = new String(out.toByteArray(), "UTF-8");
        } catch (Exception e) {
            XLivePlugin.forward("captureLog", "{\"error\":\"brak " + INJECT_ASSET + "\"}");
            return;
        }
        final String cfg = configJson();
        webView.post(
                new Runnable() {
                    @Override
                    public void run() {
                        if (webView == null) return;
                        webView.evaluateJavascript(
                                script + "\n;window.__xofflineInjected = true;try{window.__xofflineConfigure(" + cfg + ");}catch(e){}",
                                new ValueCallback<String>() {
                                    @Override
                                    public void onReceiveValue(String value) {
                                        injected = true;
                                        try {
                                            JSONObject status = new JSONObject();
                                            status.put("open", true);
                                            status.put("url", webView == null || webView.getUrl() == null ? "" : webView.getUrl());
                                            XLivePlugin.forward("liveStatus", status.toString());
                                        } catch (Exception ignored) {
                                        }
                                    }
                                });
                    }
                });
    }

    private String configJson() {
        try {
            Intent intent = getIntent();
            JSONObject cfg = new JSONObject();
            cfg.put("enabled", intent == null || intent.getBooleanExtra("capture", true));
            cfg.put("autoScroll", intent == null || intent.getBooleanExtra("autoScroll", true));
            cfg.put("target", intent == null ? 200 : intent.getIntExtra("maxPosts", 200));
            cfg.put("batch", intent == null ? 8 : intent.getIntExtra("scrollBatch", 8));
            return cfg.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** Uruchamia odtwarzanie akcji (serduszka / zakładki) po stronie strony X. */
    public void replayActions(final String actionsJson, final Callback done) {
        if (webView == null || rendererDead) {
            if (done != null) done.onResult("[]");
            return;
        }
        if (!injected) inject();
        webView.post(
                new Runnable() {
                    @Override
                    public void run() {
                        if (webView == null) {
                            if (done != null) done.onResult("[]");
                            return;
                        }
                        webView.evaluateJavascript("window.__xofflineReplay(" + JSONObject.quote(actionsJson) + ")", new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (done != null) done.onResult(value == null ? "null" : value);
                            }
                        });
                    }
                });
    }

    /** Odczyt stanu zbieracza. Wołane z wątku pluginu — dlatego wszystko idzie przez `post`. */
    public void readStatus(final Callback done) {
        if (webView == null || rendererDead) {
            if (done != null) done.onResult("{}");
            return;
        }
        webView.post(
                new Runnable() {
                    @Override
                    public void run() {
                        if (webView == null) {
                            if (done != null) done.onResult("{}");
                            return;
                        }
                        webView.evaluateJavascript(
                                "JSON.stringify(window.__xofflineStatus ? window.__xofflineStatus() : {enabled:false})",
                                new ValueCallback<String>() {
                                    @Override
                                    public void onReceiveValue(String value) {
                                        if (done != null) done.onResult(value == null ? "{}" : value);
                                    }
                                });
                    }
                });
    }

    public void finishQuietly() {
        runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        try {
                            finish();
                        } catch (Exception ignored) {
                        }
                    }
                });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent == null || webView == null) return;
        // Powrót z „Otwórz X” z inną zakładką (np. zakładki) ma naprawdę przełączyć widok.
        String tab = safeExtra(intent, "tab");
        String direct = safeExtra(intent, "url");
        if (!tab.isEmpty() || !direct.isEmpty()) {
            applyIntent(intent);
            webView.post(
                    new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null) webView.loadUrl(startUrl);
                        }
                    });
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        try {
            if (webView != null) {
                webView.saveState(outState);
                outState.putString("xoUrl", webView.getUrl());
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {
        }
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            try {
                // Kolejność ma znaczenie: najpierw odczepiamy widok od hierarchii, potem niszczymy.
                // Bez tego WebView potrafi rzucić „destroy() called while still attached”.
                if (webView.getParent() instanceof ViewGroup) {
                    ((ViewGroup) webView.getParent()).removeView(webView);
                }
                webView.stopLoading();
                webView.setWebChromeClient(null);
                webView.setWebViewClient(new WebViewClient());
                webView.destroy();
            } catch (Exception ignored) {
            }
            webView = null;
        }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    public interface Callback {
        void onResult(String value);
    }
}
