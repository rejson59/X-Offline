import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Konfiguracja natywnego pudełka (Android / iOS) dla X-Offline.
 *
 * Kluczowa sprawa: `CapacitorHttp.enabled = true` sprawia, że pobieranie plików mediów
 * w aplikacji idzie przez sieć natywną (bez walki z CORS). Same posty przychodzą
 * wyłącznie z podglądu X (WebView z Twoją sesją) — nie ma żadnego API ani serwera.
 */
const config: CapacitorConfig = {
  appId: 'app.xoffline.mobile',
  appName: 'X-Offline',
  webDir: 'apps/web/dist',
  server: {
    androidScheme: 'https',
    // Przy debugowaniu na telefonie: zmień na adres dev serwera, np. http://192.168.1.20:5173
    // hostname: '192.168.1.20',
    // cleartext: true,
  },
  plugins: {
    CapacitorHttp: { enabled: true },
    CapacitorCookies: { enabled: true },
    Share: {
      // udostępnianie zapisanych postów do innych apek
    },
  },
  android: {
    allowMixedContent: false,
    captureInput: false,
    // Debugowanie WebView przez chrome://inspect. Zostaw wyłączone w APK, które
    // udostępniasz dalej — w tej apce jest Twoja zalogowana sesja X.
    webContentsDebuggingEnabled: false,
    backgroundColor: '#000000',
    appendUserAgent: 'XOfflineApp/0.1',
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
