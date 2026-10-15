// BookingShell — il guscio dei due pannelli di prenotazione: «Nuova
// prenotazione» (NewApptModal) e «Prenotazione di gruppo»
// (GroupBookingDrawer). Pannello a destra senza velo, l'agenda resta
// visibile; titolo e sottotitolo, la «x» (Esc), il corpo che scorre e il piede.
// Ognuno si disegnava il suo, con misure, margini e piede diversi: due
// pannelli che fanno la stessa cosa sembravano di due programmi.
import { Icon } from '@youty/shared';

export const BOOKING_PANEL_W = 520;

/** `closeDisabled`: durante la creazione di un gruppo non si esce (13-20). */
export default function BookingShell({ title, sub, foot, onClose, closeDisabled = false, zIndex, t, children }) {
  return (
    <div role="dialog" aria-label={title} style={{ position: 'fixed', top: 'var(--top-h)', right: 0, bottom: 0, width: BOOKING_PANEL_W, maxWidth: '94vw', zIndex, background: 'var(--surface)', borderLeft: '1px solid var(--hair)', boxShadow: 'var(--sh-pop)', display: 'flex', flexDirection: 'column', animation: 'dkSlideR 280ms var(--ease-emph)' }}>
      <div className="dk-modalhead" style={{ padding: '18px 22px 12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-title" style={{ fontSize: 20, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          {sub && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{sub}</div>}
        </div>
        <button className="dk-iconbtn" style={{ flexShrink: 0, marginLeft: 12, width: 36, height: 36 }} onClick={onClose} disabled={closeDisabled} aria-label={t('Chiudi', 'Close')} title="Esc"><Icon name="x" size={17} /></button>
      </div>
      <div className="dk-modalbody" style={{ flex: 1, minHeight: 0, padding: '0 22px 22px' }}>{children}</div>
      {foot && <div style={{ padding: '12px 22px 14px', borderTop: '1px solid var(--hair)', background: 'var(--surface-2)' }}>{foot}</div>}
    </div>
  );
}

/** Il riquadro «sola lettura» dei due pannelli. */
export function ReadOnlyNote({ t }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', border: '1.5px dashed var(--line-strong)', borderRadius: 14, color: 'var(--muted)' }}>
      <Icon name="lock" size={26} color="var(--muted-2)" style={{ margin: '0 auto 10px' }} />
      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)', marginBottom: 4 }}>{t('Sola lettura', 'Read only')}</div>
      <div className="t-sm">{t('Il tuo ruolo non include il permesso “agenda”: chiedi alla titolare di abilitarlo.', 'Your role lacks the “agenda” permission: ask the owner to enable it.')}</div>
    </div>
  );
}
