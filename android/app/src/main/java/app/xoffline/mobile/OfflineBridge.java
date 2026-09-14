package app.xoffline.mobile;

import android.webkit.JavascriptInterface;

/**
 * OfflineBridge — jedyne, co wstrzyknięty skrypt strony X może wywołać.
 * Cztery metodek w jedną stronę (treści postów, status, wyniki akcji, log) i jedna
 * zamykająca podgląd. Zero sięgania do plików, bazy czy ustawień aplikacji.
 */
public class OfflineBridge {

    private final XLiveActivity host;

    public OfflineBridge(XLiveActivity host) {
        this.host = host;
    }

    @JavascriptInterface
    public void onTweets(String payload) {
        XLivePlugin.forward("tweetsCaptured", payload);
    }

    @JavascriptInterface
    public void onStatus(String payload) {
        XLivePlugin.forward("liveStatus", payload);
    }

    @JavascriptInterface
    public void onActionsResult(String payload) {
        XLivePlugin.forward("actionsDone", payload);
    }

    @JavascriptInterface
    public void onLog(String message) {
        XLivePlugin.forward("captureLog", "{\"message\":" + quote(message) + "}");
    }

    @JavascriptInterface
    public void closeHost() {
        if (host != null) host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.finishQuietly();
            }
        });
    }

    private static String quote(String s) {
        if (s == null) return "null";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }
}
