package app.xoffline.mobile;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * XLive — mostek JS ↔ natywny podgląd X.
 *
 *   XLive.open({ tab: 'home' | 'bookmarks' | 'profile' | 'search', handle, query, url,
 *               autoScroll, capture, maxPosts, scrollBatch })
 *   XLive.close()
 *   XLive.status()                 → { open, captured, target, loggedIn, url, scrolling, info }
 *   XLive.replay([{id,kind,tweetId,tweetUrl}]) → { queued }  (+ wynik jako event „actionsDone”)
 *   XLive.consumeSharedIntent()    → { text, url, subject } — link udostępniony apce z Androida
 *   addListener('tweetsCaptured' | 'actionsDone' | 'liveStatus' | 'captureLog' | 'shareReceived')
 */
@CapacitorPlugin(name = "XLive")
public class XLivePlugin extends Plugin {

    private static volatile XLivePlugin current;

    @Override
    public void load() {
        current = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (current == this) current = null;
    }

    /**
     * Przekazuje zdarzenie z WebView do świata JS. Bezpieczne, gdy plugin już nie żyje
     * albo mostek jest w trakcie zamykania — wcześniej wyjątek tutaj wywalał apkę.
     */
    static void forward(String event, String payloadJson) {
        XLivePlugin plugin = current;
        if (plugin == null || payloadJson == null || event == null) return;
        try {
            Object parsed = new JSONTokener(payloadJson).nextValue();
            JSObject data = new JSObject();
            if (parsed instanceof JSONObject) data.put("payload", (JSONObject) parsed);
            else if (parsed instanceof JSONArray) data.put("payload", (JSONArray) parsed);
            else data.put("payload", payloadJson);
            plugin.notifyListeners(event, data);
        } catch (Exception first) {
            try {
                JSObject data = new JSObject();
                data.put("payload", payloadJson);
                plugin.notifyListeners(event, data);
            } catch (Exception ignored) {
                // Mostek zniknął w trakcie — nie ma komu tego pokazać, nie ma czego ratować.
            }
        }
    }

    /** Czy JS jest już podłączony (wtedy można wysyłać zdarzenia bez czekania na restart). */
    static boolean isReady() {
        return current != null;
    }

    /** Udostępnienie z Androida (share sheet) → event `shareReceived` dla JS. */
    static void forwardShared(MainActivity.SharedIntent shared) {
        XLivePlugin plugin = current;
        if (plugin == null || shared == null) return;
        try {
            JSObject payload = new JSObject();
            if (shared.text != null) payload.put("text", shared.text);
            if (shared.url != null) payload.put("url", shared.url);
            if (shared.subject != null) payload.put("subject", shared.subject);
            JSObject data = new JSObject();
            data.put("payload", payload);
            plugin.notifyListeners("shareReceived", data);
        } catch (Exception ignored) {
            // Mostek w trakcie zamykania — link zostaje w kolejce natywnej.
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), XLiveActivity.class);
            intent.putExtra("tab", call.getString("tab", "home"));
            intent.putExtra("handle", call.getString("handle", null));
            intent.putExtra("query", call.getString("query", null));
            intent.putExtra("url", call.getString("url", null));
            intent.putExtra("capture", booleanOrDefault(call, "capture", true));
            intent.putExtra("autoScroll", booleanOrDefault(call, "autoScroll", true));
            intent.putExtra("maxPosts", intOrDefault(call, "maxPosts", 200));
            intent.putExtra("scrollBatch", intOrDefault(call, "scrollBatch", 8));
            intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("url", "https://x.com/home");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Nie udało się otworzyć podglądu X: " + e.getMessage());
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        try {
            XLiveActivity activity = XLiveActivity.instance;
            if (activity != null) activity.finishQuietly();
        } catch (Exception ignored) {
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void status(PluginCall call) {
        XLiveActivity activity = XLiveActivity.instance;
        if (activity == null) {
            JSObject ret = new JSObject();
            ret.put("open", false);
            ret.put("captured", 0);
            call.resolve(ret);
            return;
        }
        activity.readStatus(
                new XLiveActivity.Callback() {
                    @Override
                    public void onResult(String value) {
                        JSObject ret = new JSObject();
                        ret.put("open", true);
                        try {
                            Object parsed = new JSONTokener(unwrap(value)).nextValue();
                            if (parsed instanceof JSONObject) {
                                JSONObject obj = (JSONObject) parsed;
                                int collected = obj.optInt("collected", 0);
                                ret.put("collected", collected);
                                ret.put("captured", collected);
                                ret.put("target", obj.optInt("target", 0));
                                ret.put("scrolling", obj.optBoolean("scrolling", false));
                                ret.put("loggedIn", obj.optBoolean("loggedIn", false));
                                ret.put("enabled", obj.optBoolean("enabled", true));
                                ret.put("info", obj.optString("info", ""));
                                ret.put("url", obj.optString("host", ""));
                            }
                        } catch (Exception ignored) {
                        }
                        call.resolve(ret);
                    }
                });
    }

    @PluginMethod
    public void replay(PluginCall call) {
        XLiveActivity activity = XLiveActivity.instance;
        JSONArray actions = call.getArray("actions");
        if (actions == null) actions = new JSONArray();
        if (activity == null) {
            call.reject("Podgląd X nie jest otwarty — otwórz go, żeby wysłać akcje.");
            return;
        }
        final int count = actions.length();
        activity.replayActions(
                actions.toString(),
                new XLiveActivity.Callback() {
                    @Override
                    public void onResult(String value) {
                        JSObject ret = new JSObject();
                        ret.put("queued", count);
                        ret.put("raw", value);
                        call.resolve(ret);
                    }
                });
    }

    /** Oddaje raz to, co system wrzucił do apki (share sheet / „otwórz w…”). */
    @PluginMethod
    public void consumeSharedIntent(PluginCall call) {
        JSObject ret = new JSObject();
        MainActivity.SharedIntent shared = MainActivity.takeSharedIntent();
        if (shared != null) {
            if (shared.text != null) ret.put("text", shared.text);
            if (shared.url != null) ret.put("url", shared.url);
            if (shared.subject != null) ret.put("subject", shared.subject);
        }
        call.resolve(ret);
    }

    private static boolean booleanOrDefault(PluginCall call, String key, boolean fallback) {
        try {
            Boolean value = call.getBoolean(key);
            return value == null ? fallback : value;
        } catch (Exception e) {
            return fallback;
        }
    }

    private static int intOrDefault(PluginCall call, String key, int fallback) {
        try {
            Integer value = call.getInt(key);
            return value == null ? fallback : value;
        } catch (Exception e) {
            return fallback;
        }
    }

    /** evaluateJavascript zwraca stringa JSON-zacytowanego — trzeba go raz odwinąć. */
    private static String unwrap(String value) {
        if (value == null || value.isEmpty()) return "{}";
        try {
            Object first = new JSONTokener(value).nextValue();
            if (first instanceof String) return (String) first;
        } catch (Exception ignored) {
        }
        return value;
    }
}
