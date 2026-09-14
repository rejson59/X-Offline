package app.xoffline.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — standardowe pudełko Capacitora plus rejestracja naszego pluginu
 * (XLive: podgląd X z logowaniem, zbieranie postów do offline, odtwarzanie polubień).
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registerPlugin trzeba wywołać PRZED super.onCreate(), żeby mostek był widoczny dla JS.
        registerPlugin(XLivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
