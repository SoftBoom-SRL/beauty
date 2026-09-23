// ChunkErrorBoundary.jsx — rete di sicurezza attorno a sezioni, modali e drawer
// caricati a richiesta. Senza, un chunk che non si carica più dopo un deploy (o
// un errore di rendering qualunque) smontava l'intera dashboard: pagina bianca.
// Con un chunk mancante ricarica la pagina una volta (vedi chunkReload.js);
// altrimenti mostra un avviso al posto del pezzo rotto, e il resto resta in piedi.
import React from 'react';
import { Icon } from '@youty/shared';
import DkModal from '../ui/DkModal.jsx';
import { isChunkLoadError, reloadOnce, reloadPending } from './chunkReload.js';

export default class ChunkErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, reloading: false };
  }

  static getDerivedStateFromError(error) {
    // La ricarica può essere già partita (vite:preloadError in main.jsx).
    return { error, reloading: isChunkLoadError(error) && reloadPending() };
  }

  componentDidCatch(error) {
    if (isChunkLoadError(error) && !reloadPending() && reloadOnce()) this.setState({ reloading: true });
  }

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;
    const { t, variant = 'page', onClose } = this.props;
    const tt = t || ((it) => it);
    const chunk = isChunkLoadError(error);
    const title = reloading
      ? tt('Aggiornamento in corso…', 'Updating…')
      : chunk
        ? tt('È uscita una nuova versione', 'A new version is out')
        : tt('Questa parte non si è caricata', 'This part failed to load');
    const sub = reloading
      ? tt('La dashboard è stata aggiornata: ricarico la pagina.', 'The dashboard has been updated: reloading the page.')
      : chunk
        ? tt('Questa parte della dashboard è stata aggiornata. Ricarica la pagina per continuare.', 'This part of the dashboard has been updated. Reload the page to continue.')
        : tt('Si è verificato un errore imprevisto. Ricarica la pagina; se si ripete, avvisa l’assistenza.', 'An unexpected error occurred. Reload the page; if it happens again, contact support.');
    const reloadBtn = !reloading && (
      <button className="dk-btn dk-btn--clay" onClick={() => window.location.reload()}>
        <Icon name="refresh" size={16} color="#fff" />{tt('Ricarica la pagina', 'Reload the page')}
      </button>
    );

    if (variant === 'modal') {
      return (
        <DkModal open onClose={onClose} title={title} width={440}
          foot={<React.Fragment>
            {onClose && <button className="dk-btn dk-btn--ghost" onClick={onClose}>{tt('Chiudi', 'Close')}</button>}
            {reloadBtn}
          </React.Fragment>}>
          <div className="t-body" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>{sub}</div>
        </DkModal>
      );
    }
    return (
      <div className={variant === 'page' ? 'dk-page' : undefined} style={{ padding: variant === 'page' ? undefined : 22 }}>
        <div className="dk-card" style={{ padding: '32px 28px', textAlign: 'center', maxWidth: 460, margin: variant === 'page' ? '40px auto' : '0 auto' }}>
          <div style={{ width: 54, height: 54, borderRadius: 16, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}>
            <Icon name={reloading || chunk ? 'refresh' : 'alert'} size={24} color="var(--clay-ink)" />
          </div>
          <div className="t-title" style={{ marginBottom: 8 }}>{title}</div>
          <div className="t-body" style={{ color: 'var(--muted)', marginBottom: reloadBtn ? 18 : 0, lineHeight: 1.5 }}>{sub}</div>
          {reloadBtn}
        </div>
      </div>
    );
  }
}
