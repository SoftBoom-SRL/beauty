// ViewPrefs — le preferenze di visualizzazione della settimana, in un
// pannellino che si apre dalla rotella nella barra: la larghezza delle
// colonne delle operatrici (dinamica, col lavoro del giorno, o fissa) e le
// scritte nei blocchi (anche per lungo, o solo orizzontali). Valgono per la
// postazione, come lo zoom: chi lavora su un monitor grande e chi su un
// portatile le vuole diverse (il titolare, 16/10).
import { useCallback, useRef, useState } from 'react';
import { Icon } from '@youty/shared';
import { useClickAway } from '../../../hooks/useClickAway.js';

const AWAY = { event: 'pointerdown', capture: true, escape: true };

/** Due scelte in fila, come i segmenti della barra; `hint` = che cosa fa
 *  quella accesa. */
function Choice({ label, value, onChange, options, hint }) {
  return (
    <div role="group" aria-label={label} style={{ marginTop: 12 }}>
      <div className="t-meta" style={{ marginBottom: 6 }}>{label}</div>
      <div className="dk-agseg" style={{ display: 'flex' }}>
        {options.map((o) => (
          <button key={String(o.value)} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} style={{ flex: 1 }}>
            {o.label}
          </button>
        ))}
      </div>
      <div className="t-sm" style={{ marginTop: 6, color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>{hint}</div>
    </div>
  );
}

/** `dynamicCols`/`setDynamicCols`, `verticalText`/`setVerticalText`: le due
 *  preferenze (useStoredFlag nella sezione). */
export default function ViewPrefs({ dynamicCols, setDynamicCols, verticalText, setVerticalText, t }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useClickAway(ref, open, close, AWAY);
  const label = t('Preferenze di visualizzazione', 'Display preferences');
  return (
    <div className="dk-agseg">
      <div ref={ref} className="dk-agseg__pop">
        <button type="button" aria-expanded={open} aria-haspopup="dialog" aria-label={label} title={label}
          onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', padding: '0 8px' }}>
          <Icon name="settings" size={15} />
        </button>
        {open && (
          <div className="dk-card dk-widthpop" role="dialog" aria-label={label} style={{ width: 300 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{label}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Vista settimana · su questa postazione', 'Week view · on this workstation')}</div>
            <Choice
              label={t('Larghezza delle colonne', 'Column width')}
              value={dynamicCols} onChange={setDynamicCols}
              options={[{ value: true, label: t('Dinamica', 'Dynamic') }, { value: false, label: t('Fissa', 'Fixed') }]}
              hint={dynamicCols
                ? t('Chi ha più appuntamenti nel giorno ha la colonna più larga; chi è libera o a riposo, più stretta.', 'Whoever has more appointments that day gets a wider column; free or resting stylists get a narrower one.')
                : t('Tutte le operatrici larghe uguali, ogni giorno, qualunque sia il lavoro.', 'All stylists equally wide, every day, whatever the workload.')}
            />
            <Choice
              label={t('Scritte nei blocchi', 'Text in the blocks')}
              value={verticalText} onChange={setVerticalText}
              options={[{ value: true, label: t('Anche verticali', 'Vertical too') }, { value: false, label: t('Solo orizzontali', 'Horizontal only') }]}
              hint={verticalText
                ? t('Nei blocchi stretti e alti nome e ora si leggono per lungo.', 'In narrow, tall blocks name and time read sideways.')
                : t('Mai per lungo: nei blocchi stretti restano le iniziali e l’ora.', 'Never sideways: narrow blocks keep initials and time.')}
            />
          </div>
        )}
      </div>
    </div>
  );
}
