// CardMovements.jsx — nella scheda della carta (WalletTab): «Modifica saldo»
// (+/− o saldo nuovo, motivo obbligatorio, nessun incasso) e lo storico dei
// movimenti della carta: carichi, utilizzi, modifiche, annullamento.
import { useEffect, useState } from 'react';
import { Icon, fmtEurNoFree, toastApiError } from '@youty/shared';
import { giftCardsApi } from '../../../api/marketing.js';
import { adjustBody, movementLabel } from '../../fedelta/movements.js';
import { dateLabel } from '../helpers.js';

export default function CardMovements({ card, canAdjust, onAdjusted, t, lang, fireToast }) {
  const [rows, setRows] = useState(null);   // null = in caricamento · 'failed' · []
  const [form, setForm] = useState(null);   // { mode, amt, note, busy }
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let dead = false;
    giftCardsApi.movements(card.id)
      .then((res) => { if (!dead) setRows(res || []); })
      .catch(() => { if (!dead) setRows('failed'); });
    return () => { dead = true; };
  }, [card.id, card.balance, rev]);

  const save = async () => {
    const { body, error } = adjustBody(form.mode, form.amt, form.note, t);
    if (error) { fireToast({ msg: error, icon: 'alert' }); return; }
    setForm((f) => ({ ...f, busy: true }));
    try {
      const updated = await giftCardsApi.adjust(card.id, body);
      fireToast({ msg: t(`Saldo aggiornato: ${fmtEurNoFree(updated.balance, 'it')}`, `Balance updated: ${fmtEurNoFree(updated.balance, 'en')}`), icon: 'check' });
      setForm(null);
      setRev((n) => n + 1);
      onAdjusted(updated);
    } catch (err) {
      toastApiError(err, fireToast, t);
      setForm((f) => ({ ...f, busy: false }));
    }
  };

  const modes = [['add', t('Aggiungi', 'Add')], ['remove', t('Togli', 'Remove')], ['set', t('Saldo nuovo', 'New balance')]];
  const fieldCss = { border: '1px solid var(--hair)', borderRadius: 9, padding: '7px 9px', background: 'var(--surface)', fontSize: 13.5, outline: 'none' };

  return (
    <div data-card-movements style={{ borderTop: '1px solid var(--hair)', paddingTop: 14, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div className="t-meta" style={{ flex: 1 }}>{t('Movimenti', 'Movements')}</div>
        {canAdjust && !form && (
          <button type="button" className="dk-btn dk-btn--soft" style={{ height: 30, fontSize: 12.5 }} onClick={() => setForm({ mode: 'add', amt: '', note: '', busy: false })}>
            <Icon name="edit" size={14} />{t('Modifica saldo', 'Edit balance')}
          </button>
        )}
      </div>

      {form && (
        <div style={{ padding: 12, borderRadius: 12, background: 'var(--surface-2)', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {modes.map(([k, l]) => (
              <button key={k} type="button" className="dk-pill" aria-pressed={form.mode === k} onClick={() => setForm((f) => ({ ...f, mode: k }))}
                style={{ padding: '6px 11px', fontSize: 12.5, fontWeight: 700, background: form.mode === k ? 'var(--info)' : undefined, borderColor: form.mode === k ? 'var(--info)' : undefined, color: form.mode === k ? '#fff' : undefined }}>{l}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <div style={{ ...fieldCss, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--muted-2)', fontWeight: 700 }}>{form.mode === 'add' ? '+€' : form.mode === 'remove' ? '−€' : '€'}</span>
              <input type="text" inputMode="decimal" value={form.amt} placeholder="0,00" aria-label={t('Importo', 'Amount')}
                onChange={(e) => setForm((f) => ({ ...f, amt: e.target.value.replace(/[^0-9.,]/g, '') }))}
                style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13.5, width: 70 }} />
            </div>
            <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Nessun incasso in cassa', 'No cash recorded')}</span>
          </div>
          <input type="text" value={form.note} maxLength={255} placeholder={t('Motivo (obbligatorio)', 'Reason (required)')} aria-label={t('Motivo', 'Reason')}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} style={{ ...fieldCss, width: '100%', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }} disabled={form.busy} onClick={() => setForm(null)}>{t('Annulla', 'Cancel')}</button>
            <button type="button" className="dk-btn dk-btn--clay" style={{ height: 32, fontSize: 12.5 }} disabled={form.busy} onClick={save}>{t('Salva', 'Save')}</button>
          </div>
        </div>
      )}

      {rows === null ? (
        <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Caricamento…', 'Loading…')}</div>
      ) : rows === 'failed' ? (
        <div className="t-sm" style={{ color: 'var(--danger)' }}>{t('Movimenti non caricati', 'Movements not loaded')}</div>
      ) : rows.length === 0 ? (
        <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun movimento', 'No movements')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {[...rows].reverse().map((m, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 2px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{movementLabel(m, t)}</div>
                <div className="t-sm" style={{ color: 'var(--muted)' }}>
                  {dateLabel(m.at, lang)}{m.by ? ' · ' + m.by : ''}{m.note ? ' · ' + m.note : ''}
                </div>
              </div>
              {m.amount != null && (
                <span className="t-num" style={{ fontWeight: 700, fontSize: 13, color: Number(m.amount) < 0 ? 'var(--ink)' : 'var(--ok)' }}>
                  {Number(m.amount) > 0 ? '+' : Number(m.amount) < 0 ? '−' : ''}{fmtEurNoFree(Math.abs(Number(m.amount)), lang)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
