// DkDrop.jsx — menu a tendina compatto per campi e operatori delle condizioni
// (regole caparra in Impostazioni, costruttore delle Automazioni). Era copiato
// nelle due sezioni.
import { useCallback, useRef, useState } from 'react';
import { Icon } from '@youty/shared';
import { useClickAway } from '../hooks/useClickAway.js';
import { dropCurrent } from './dropCurrent.js';

/* options = [{ value, label, title? }]. Un valore salvato che non è fra le
 * opzioni (l'etichetta rinominata o eliminata) si vede com'è, in evidenza, con
 * `missingLabel(valore)`: non la prima opzione della lista (15-07). `loose`:
 * stesso testo senza badare a maiuscole e spazi, come confronta il server.
 * Esc con il menu aperto chiude il menu e basta (preventDefault: vedi
 * ui/layers.js). */
export default function DkDrop({ value, onChange, options, narrow, missingLabel, loose }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useClickAway(ref, open, close, { escape: true });
  const cur = dropCurrent(options, value, { missingLabel, loose });
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title={cur.missing ? cur.label : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: narrow ? '0 10px' : '0 12px', border: '1px solid ' + (cur.missing ? 'var(--warn)' : 'var(--hair)'), borderRadius: 9, background: cur.missing ? 'var(--warn-tint)' : 'var(--surface)', cursor: 'pointer', fontSize: narrow ? 16 : 13.5, fontWeight: 700, color: cur.missing ? 'var(--warn)' : 'var(--ink)' }}>
        {cur.missing && <Icon name="alert" size={13} color="var(--warn)" />}{cur.label}<Icon name="chevD" size={13} color="var(--muted)" />
      </button>
      {open && (
        <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 5px)', left: 0, minWidth: narrow ? 64 : 200, padding: 5, zIndex: 30, boxShadow: 'var(--sh-pop)' }}>
          {options.map((o) => {
            const on = cur.option === o;
            return (
              <button key={String(o.value)} className="dk-row" onClick={() => { onChange(o.value); setOpen(false); }} title={o.title} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: narrow ? 15 : 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{o.label}</span>
                {on && <Icon name="check" size={14} color="var(--clay-ink)" stroke={2.4} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
