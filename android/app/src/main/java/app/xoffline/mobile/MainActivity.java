package app.xoffline.mobile;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — standardowe pudełko Capacitora plus:
 *  - rejestracja naszego pluginu (XLive: podgląd X z logowaniem, zbieranie postów do offline),
 *  - odbiór linków udostępnianych apce z innych aplikacji (share sheet, „otwórz w X-Offline”).
 *
 * Link z udostępniania nie ginie: czeka w `SharedIntent`, aż JS go odbierze
 * (`XLive.consumeSharedIntent()`), a gdy apka jest już otwarta — leci eventem `shareReceived`.
 */
public class MainActivity extends BridgeActivity {

    /** To, co system przekazał apce (np. „udostępnij link do X-Offline”). */
    public static final class SharedIntent {
        public final String text;
        public final String url;
        public final String subject;

        SharedIntent(String text, String url, String subject) {
            this.text = text;
            this.url = url;
            this.subject = subject;
        }

        boolean isEmpty() {
            return (text == null || text.isEmpty()) && (url == null || url.isEmpty());
        }
    }

    private static volatile SharedIntent pendingShare;

    public static SharedIntent takeSharedIntent() {
        SharedIntent shared = pendingShare;
        pendingShare = null;
        return shared;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registerPlugin trzeba wywołać PRZED super.onCreate(), żeby mostek był widoczny dla JS.
        registerPlugin(XLivePlugin.class);
        super.onCreate(savedInstanceState);
        captureSharedIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureSharedIntent(intent);
    }

    /** Wyciąga tekst/link z intencji SEND, VIEW albo PROCESS_TEXT. */
    private void captureSharedIntent(Intent intent) {
        if (intent == null) return;
        try {
            String action = intent.getAction();
            if (action == null) return;
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            String url = null;

            if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
                url = intent.getData().toString();
            } else if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
                CharSequence processed = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
                if (processed != null) text = processed.toString();
            } else if (Intent.ACTION_SEND.equals(action) && text == null) {
                return;
            } else if (!Intent.ACTION_SEND.equals(action)) {
                return;
            }

            SharedIntent shared = new SharedIntent(emptyToNull(text), emptyToNull(url), emptyToNull(subject));
            if (shared.isEmpty()) return;

            if (XLivePlugin.isReady()) {
                // Apka już żyje — nie każ użytkownikowi czekać na restart JS.
                XLivePlugin.forwardShared(shared);
            } else {
                pendingShare = shared;
            }
        } catch (Exception ignored) {
            // Udostępnianie nie może wywalić apki — najwyżej je zignorujemy.
        }
    }

    private static String emptyToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value;
    }
}
