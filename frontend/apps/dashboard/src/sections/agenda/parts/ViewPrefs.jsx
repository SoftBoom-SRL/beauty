// ViewPrefs — le preferenze di visualizzazione della settimana, in un
// pannellino che si apre dalla rotella nella barra: chi non è in turno
// (mostrata o nascosta), i giorni di chiusura, la larghezza delle colonne
// delle operatrici (dinamica, col lavoro del giorno, o fissa) e le scritte
// nei blocchi (anche per lungo, o solo orizzontali). Valgono per la
// postazione, come lo zoom: chi lavora su un monitor grande e chi su un
// portatile le vuole diverse (il titolare, 16/10). In vista giorno la
// rotella non c'è: la barra, con la striscia dei giorni, andava a capo fino
// a 1600 px; chi non è in turno lì si sceglie dal filtro Team («Solo chi
// lavora oggi»), che è la stessa preferenza.
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

const SHOW_HIDE = (t) => [{ value: false, label: t('Mostra', 'Show') }, { value: true, label: t('Nascondi', 'Hide') }];

/** Le preferenze (useStoredFlag nella sezione), ognuna col suo setter:
 *  `hideOffShift` (la stessa di «Solo chi lavora oggi» nel filtro Team della
 *  vista giorno), `hideClosed`, `dynamicCols`, `verticalText`. */
export default function ViewPrefs({ hideOffShift, setHideOffShift, hideClosed, setHideClosed, dynamicCols, setDynamicCols, verticalText, setVerticalText, t }) {
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
              label={t('Chi non è in turno', 'Who is not on shift')}
              value={hideOffShift} onChange={setHideOffShift} options={SHOW_HIDE(t)}
              hint={hideOffShift
                ? t('Chi quel giorno è a riposo o in ferie e non ha appuntamenti non ha la colonna: più spazio a chi lavora. Vale con i turni impostati in Staff, e anche in vista giorno («Solo chi lavora oggi»).', 'Whoever is off or on holiday that day with no appointments gets no column: more room for those working. Applies with shifts set in Staff, and in the day view too («Only who works today»).')
                : t('Anche chi è a riposo o in ferie ha la sua colonna, spenta.', 'Stylists who are off or on holiday keep their column, dimmed.')}
            />
            <Choice
              label={t('Giorni di chiusura', 'Closed days')}
              value={hideClosed} onChange={setHideClosed} options={SHOW_HIDE(t)}
              hint={hideClosed
                ? t('I giorni in cui il centro è chiuso, o nessuna è in turno, spariscono se non hanno appuntamenti.', 'Days when the salon is closed, or nobody is on shift, disappear if they have no appointments.')
                : t('Tutti e sette i giorni, anche quelli di chiusura.', 'All seven days, closed ones too.')}
            />
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
