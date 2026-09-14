package app.xoffline.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import org.json.JSONObject;

/**
 * XLiveActivity — pełnoekranowy WebView na prawdziwym x.com z Twoją sesją.
 *
 * Po co osobna aktywność zamiast strony w Capacitorze? Żeby strona X działała w ORYGINALNEJ
 * domenie: ciasteczka, localStorage i service worker X zostają tam, gdzie powinny, a my tylko
 * podsłuchujemy odpowiedzi GraphQL i dokładamy własny widżet (plik assets/inject/xoffline-capture.js).
 *
 * Nic stąd nie wychodzi poza kolekcję postów: zero logowania do serwerów X-Offline (nie ma takich).
 */
public class XLiveActivity extends Activity {

    public static volatile XLiveActivity instance;

    private static final String TAB_HOME = "https://x.com/home";
    private static final String TAB_BOOKMARKS = "https://x.com/i/bookmarks";
    private static final String INJECT_ASSET = "inject/xoffline-capture.js";

    private WebView webView;
    private String startUrl = TAB_HOME;
    private boolean injected = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;

        Intent intent = getIntent();
        if (intent != null) {
            String tab = intent.getStringExtra("tab");
            String handle = intent.getStringExtra("handle");
            String query = intent.getStringExtra("query");
            String direct = intent.getStringExtra("url");
            if (direct != null && direct.startsWith("http")) {
                startUrl = direct;
            } else if ("bookmarks".equals(tab)) {
                startUrl = TAB_BOOKMARKS;
            } else if ("profile".equals(tab) && handle != null && handle.matches("[A-Za-z0-9_]{1,15}")) {
                startUrl = "https://x.com/" + handle;
            } else if ("search".equals(tab) && query != null) {
                startUrl = "https://x.com/search?q=" + Uri.encode(query) + "&src=typed_query&f=live";
            }
        }

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
                        if (uri.getHost() != null && uri.getHost().endsWith("x.com")) return false;
                        if (uri.getHost() != null && uri.getHost().endsWith("twitter.com")) return false;
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
                });

        webView.setWebChromeClient(new WebChromeClient());

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(
                webView,
                new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        webView.loadUrl(startUrl);
    }

    /** Wstrzykuje zbieracz + konfigurację. Idempotentne — skrypt sam sprawdza `window.__xofflineInjected`. */
    private void inject() {
        if (webView == null) return;
        String script;
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
        webView.evaluateJavascript(
                script + "\n;window.__xofflineInjected = true;try{window.__xofflineConfigure(" + cfg + ");}catch(e){}",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        injected = true;
                        XLivePlugin.forward("liveStatus", "{\"open\":true,\"url\":\"" + safe(webView.getUrl()) + "\"}");
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
    public void replayActions(String actionsJson, final Callback done) {
        if (webView == null) {
            if (done != null) done.onResult("[]");
            return;
        }
        if (!injected) inject();
        webView.post(
                new Runnable() {
                    @Override
                    public void run() {
                        webView.evaluateJavascript("window.__xofflineReplay(" + JSONObject.quote(actionsJson) + ")", new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (done != null) done.onResult(value == null ? "null" : value);
                            }
                        });
                    }
                });
    }

    public void readStatus(final Callback done) {
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

    public void finishQuietly() {
        finish();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    private static String safe(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "'");
    }

    public interface Callback {
        void onResult(String value);
    }
}
