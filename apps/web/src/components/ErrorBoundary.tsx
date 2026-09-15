import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logDiag } from '@/lib/diagnostics';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Ostatnia linia obrony: jeśli jakikolwiek komponent rzuci wyjątkiem, apka nie umiera
 * (w APK biały ekran wygląda jak „wypadła”), tylko pokazuje ekran ratunkowy z treścią błędu.
 *
 * To jest dokładnie ta różnica, której brakowało: wcześniej np. wybór filtra „Z kolejki akcji”
 * wywalał cały interfejs, bo React odmontowywał drzewo.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logDiag('error', `błąd interfejsu: ${error.message}`, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
  }

  private copyReport = async (): Promise<void> => {
    const err = this.state.error;
    const report = [
      'X-Offline — raport błędu',
      new Date().toISOString(),
      navigator.userAgent,
      '',
      String(err?.message ?? err),
      err?.stack ?? '',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      /* brak schowka — użytkownik i tak widzi komunikat na ekranie */
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="section" style={{ paddingTop: 24 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <b>Coś się wysypało w interfejsie</b>
          <div className="small dim">
            Zapisane posty są bezpieczne — to błąd wyświetlania, nie danych. Szczegóły trafiły do dziennika w ustawieniach.
          </div>
          <pre className="tiny dim" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 160, overflow: 'auto' }}>
            {error.message}
          </pre>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn primary small" onClick={() => this.setState({ error: null })}>
              Wróć do aplikacji
            </button>
            <button className="btn quiet small" onClick={() => void this.copyReport()}>
              Skopiuj raport
            </button>
            <button className="btn quiet small" onClick={() => location.reload()}>
              Przeładuj apkę
            </button>
          </div>
        </div>
      </div>
    );
  }
}
