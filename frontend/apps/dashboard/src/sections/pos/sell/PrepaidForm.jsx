// sell/PrepaidForm.jsx — un trattamento pagato in anticipo dalla cliente
// (check-out e banco): il servizio, quante sedute e quanto le paga. Diventa
// una sua carta «Già pagato» a sedute, che la cassa scala visita per visita.
import { Icon, NumInput } from '@youty/shared';
import { inputCss, money, svcLabel, toCents } from '../lib.js';
import { prepaidValue } from '../lines.js';

/* `services`: il listino; `form`: { serviceId, sessions, amt, edited } —
 * finché non si scrive un prezzo (`edited`) vale listino × sedute. */
export default function PrepaidForm({ services, form, setForm, onAdd, onCancel, t, lang }) {
  const active = (services || []).filter((s) => s.active !== false);
  const service = active.find((s) => String(s.id) === String(form.serviceId)) || null;
  const priced = (patch) => setForm((f) => {
    const next = { ...f, ...patch };
    const svc = active.find((s) => String(s.id) === String(next.serviceId));
    return next.edited || !svc ? next : { ...next, amt: prepaidValue(svc, next.sessions) };
  });
  const ready = service && form.sessions >= 1 && toCents(form.amt) > 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select value={form.serviceId ?? ''} onChange={(e) => priced({ serviceId: e.target.value })}
          aria-label={t('Trattamento', 'Treatment')} style={{ ...inputCss, flex: 1, minWidth: 150, cursor: 'pointer' }}>
          <option value="">{t('Scegli il trattamento…', 'Choose the treatment…')}</option>
          {active.map((s) => <option key={s.id} value={s.id}>{svcLabel(s, lang)} · {money(s.price, lang)}</option>)}
        </select>
        <div title={t('Sedute', 'Sessions')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--hair)', borderRadius: 9, padding: '7px 9px', background: 'var(--surface)' }}>
          <NumInput integer min={1} max={100} value={form.sessions} onChange={(sessions) => priced({ sessions: Math.max(1, sessions || 1) })}
            aria-label={t('Sedute', 'Sessions')}
            style={{ width: 28, textAlign: 'right', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13.5 }} />
          <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>{form.sessions === 1 ? t('seduta', 'session') : t('sedute', 'sessions')}</span>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 9, padding: '7px 9px', background: 'var(--surface)', width: 92, boxSizing: 'border-box' }}>
          <span style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
          <NumInput min={0} value={form.amt} onChange={(amt) => setForm((f) => ({ ...f, amt, edited: true }))}
            aria-label={t('Prezzo di tutte le sedute', 'Price of all sessions')}
            style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13.5, width: '100%' }} />
        </div>
        <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 11px' }} disabled={!ready} onClick={() => onAdd(service, form.sessions, form.amt)}>
          <Icon name="plus" size={13} />{t('Aggiungi', 'Add')}
        </button>
        {onCancel && <button className="dk-iconbtn" style={{ width: 30, height: 30 }} onClick={onCancel}><Icon name="x" size={14} /></button>}
      </div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>
        {t('Il prezzo è quello di tutte le sedute: ogni visita ne scala una.', 'The price covers all sessions: each visit uses one.')}
      </div>
    </div>
  );
}
