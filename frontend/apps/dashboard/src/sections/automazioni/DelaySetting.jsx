// DelaySetting.jsx — l'attesa prima dell'invio dei messaggi delle
// automazioni, in cima alla sezione (index.jsx). Si salva nelle impostazioni
// del salone (automation_delay_seconds).
import { useEffect, useState } from 'react';
import { Icon } from '@youty/shared';
import { settingsApi } from '../../api/core.js';

/* ---- attesa prima dell'invio ----------------------------------------------------
 * Il gesto e il messaggio non sono la stessa cosa. In agenda si inserisce una
 * cliente e un attimo dopo la si sposta di mezz'ora: se l'automazione partisse
 * nell'istante del primo gesto, la cliente riceverebbe due messaggi, e il primo
 * sbagliato. Con qualche secondo di attesa i due gesti diventano un messaggio
 * solo, quello giusto — e un'azione annullata con «torna indietro» non ne manda
 * nessuno. Si cambia da qui perché è qui che si ragiona sui messaggi.
 * Salva subito, senza tasti: è una scelta sola, e il titolare la vede applicata. */
const DELAY_CHOICES = [
  [0, 'Subito', 'Now'],
  [15, '15 s', '15 s'],
  [30, '30 s', '30 s'],
  [60, '1 min', '1 min'],
  [120, '2 min', '2 min'],
];

export default function DelaySetting({ t, settings, isOwner, reload, fireToast, onError }) {
  const saved = settings?.automation_delay_seconds ?? 30;
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(saved); }, [saved]);

  const pick = async (next) => {
    if (!isOwner || saving || next === value) return;
    const previous = value;
    setValue(next);           // la scelta si vede subito, il salvataggio segue
    setSaving(true);
    try {
      await settingsApi.update({ automation_delay_seconds: next });
      // Salvato: la ricarica delle impostazioni va per conto suo. Stava nello
      // stesso try e, se cadeva, la pillola tornava al valore vecchio anche se
      // il server aveva salvato il nuovo (15-19).
      reload.salon().catch(() => {});
      fireToast({
        msg: next === 0
          ? t('I messaggi partono subito', 'Messages go out immediately')
          : t(`Attesa di ${next < 60 ? next + ' secondi' : next / 60 + ' minuti'} prima dell'invio`, `${next < 60 ? next + ' seconds' : next / 60 + ' minutes'} wait before sending`),
        icon: 'check',
      });
    } catch (err) {
      setValue(previous);
      onError(err);
    } finally { setSaving(false); }
  };

  return (
    <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--hair)', background: 'var(--paper-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="clock" size={15} color="var(--muted)" />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Attesa prima dell’invio', 'Wait before sending')}</span>
      </div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>
        {t('Se l’appuntamento viene corretto (o l’azione annullata) entro questo tempo, alla cliente arriva un messaggio solo: quello giusto.',
           'If the appointment is corrected (or the action undone) within this time, the client gets a single message: the right one.')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, opacity: isOwner ? 1 : 0.6 }}>
        {/* Un valore impostato altrove (l'API accetta qualunque numero fino a
          * dieci minuti) compare come pillola in più: l'impostazione in corso
          * deve vedersi sempre, anche se non è una delle scelte rapide. */}
        {(DELAY_CHOICES.some(([v]) => v === value) ? DELAY_CHOICES : [...DELAY_CHOICES, [value, `${value} s`, `${value} s`]])
          .map(([v, it, en]) => {
          const on = value === v;
          return (
            <button key={v} onClick={() => pick(v)} disabled={!isOwner || saving}
              title={isOwner ? undefined : t('Solo il titolare può cambiarla', 'Only the owner can change this')}
              style={{ padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: isOwner && !saving ? 'pointer' : 'default', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)', transition: 'all 140ms' }}>
              {t(it, en)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
