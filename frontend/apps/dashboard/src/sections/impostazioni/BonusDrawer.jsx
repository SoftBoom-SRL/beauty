// BonusDrawer.jsx — il bonus della «carta VIP» (settings.gift_card_bonus_rules):
// chi carica almeno la soglia riceve il bonus in credito in più, in cassa
// entra solo quello che paga (paga 500 €, ha 600 € da spendere). Vale per la
// vendita pagata di una carta a importo, in cassa o da Fedeltà, e per la
// ricarica. Lista vuota = nessun bonus. Solo il titolare la modifica.
import { useState } from 'react';
import { Icon, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DrawerHead from '../../ui/DrawerHead.jsx';
import { useDash } from '../../ctx.jsx';
import { inputCss, LockNote } from './lib.jsx';
import { settingsApi } from '../../api/core.js';

const num = (v) => String(v ?? '').replace(/[^0-9.,]/g, '');
const euro = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return n > 0 ? n.toFixed(2) : null;
};

export default function BonusDrawer({ onClose }) {
  const { t, session, settings, reload, fireToast } = useDash();
  const isOwner = !!session?.is_owner;
  const [rules, setRules] = useState(() => (settings?.gift_card_bonus_rules || []).map((r) => ({ min_amount: String(Number(r.min_amount)), bonus: String(Number(r.bonus)) })));
  const [saving, setSaving] = useState(false);

  const setRule = (i, patch) => setRules((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    if (saving) return;
    const clean = [];
    for (const r of rules) {
      if (!String(r.min_amount).trim() && !String(r.bonus).trim()) continue;   // riga lasciata vuota
      const min = euro(r.min_amount), bonus = euro(r.bonus);
      if (!min || !bonus) { fireToast({ msg: t('Ogni regola vuole importo minimo e bonus maggiori di zero', 'Each rule needs a minimum and a bonus above zero'), icon: 'alert' }); return; }
      clean.push({ min_amount: min, bonus });
    }
    setSaving(true);
    try {
      await settingsApi.update({ gift_card_bonus_rules: clean });
      await reload.salon();
      fireToast({ msg: t('Bonus salvato', 'Bonus saved'), icon: 'check' });
      onClose();
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally { setSaving(false); }
  };

  return (
    <DkDrawer open onClose={onClose}>
      <DrawerHead variant="modal" onClose={onClose} closeLabel={t('Chiudi', 'Close')} title={t('Bonus carta VIP', 'VIP card bonus')}
        sub={t('Chi carica almeno l’importo riceve il bonus in credito; in cassa entra solo quello che paga', 'Whoever loads at least the amount gets the bonus as credit; only what they pay goes into the register')} />
      <div className="dk-modalbody" style={{ padding: '0 22px 22px' }}>
        {!isOwner && <div style={{ marginBottom: 14 }}><LockNote t={t} msg={t('Solo il titolare può modificare il bonus.', 'Only the owner can edit the bonus.')} /></div>}
        <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)', marginBottom: 18 }}>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
            {t('Vale la soglia più alta raggiunta. Si applica vendendo una carta a importo pagata (cassa o Fedeltà) e a ogni ricarica; il bonus resta nei movimenti della carta.', 'The highest threshold reached applies. It applies when selling a paid amount card (till or Loyalty) and to every top-up; the bonus stays in the card movements.')}
          </div>
          {!rules.length && <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10 }}>{t('Nessun bonus.', 'No bonus.')}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rules.map((r, i) => (
              <div key={i} data-bonus-rule="" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="t-sm" style={{ fontWeight: 600 }}>{t('Carica da €', 'Load from €')}</span>
                <input inputMode="decimal" value={r.min_amount} disabled={!isOwner} placeholder="500" aria-label={t('Importo minimo', 'Minimum amount')}
                  onChange={(e) => setRule(i, { min_amount: num(e.target.value) })} style={{ ...inputCss, width: 90 }} />
                <span className="t-sm" style={{ fontWeight: 600 }}>{t('→ bonus €', '→ bonus €')}</span>
                <input inputMode="decimal" value={r.bonus} disabled={!isOwner} placeholder="100" aria-label={t('Bonus', 'Bonus')}
                  onChange={(e) => setRule(i, { bonus: num(e.target.value) })} style={{ ...inputCss, width: 90 }} />
                {isOwner && (
                  <button className="dk-iconbtn" onClick={() => setRules((list) => list.filter((_, j) => j !== i))} style={{ width: 28, height: 28, borderRadius: 7 }} aria-label={t('Rimuovi', 'Remove')}><Icon name="x" size={13} /></button>
                )}
              </div>
            ))}
          </div>
          {isOwner && rules.length < 10 && (
            <button className="dk-btn dk-btn--soft" style={{ marginTop: 12 }} onClick={() => setRules((list) => [...list, { min_amount: '', bonus: '' }])}>
              <Icon name="plus" size={15} />{t('Aggiungi soglia', 'Add threshold')}
            </button>
          )}
        </div>
        {isOwner && (
          <button className="dk-btn dk-btn--clay" disabled={saving} style={{ width: '100%', opacity: saving ? 0.6 : 1 }} onClick={save}>
            <Icon name="check" size={17} color="#fff" />{saving ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
          </button>
        )}
      </div>
    </DkDrawer>
  );
}
