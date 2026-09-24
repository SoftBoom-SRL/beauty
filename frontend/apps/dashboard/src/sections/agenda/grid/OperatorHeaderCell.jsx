// OperatorHeaderCell — la testata di una colonna in vista giorno: avatar col
// pallino del turno, nome (disambiguato fra omonime), appuntamenti e incasso
// del giorno, bottone e selettore del colore dell'operatrice.
// Senza hook: nei test fa parte di DayGrid (grid-harness, `expand`).
import React from 'react';
import { Avatar, Icon } from '@youty/shared';
import HexInput from '../../../ui/HexInput.jsx';
import { COLW, apptRevenue, firstName, fmtMoney, initialsOf, lastName, opDisplay } from '../lib.js';

/** `col`: il colore dell'operatrice; `isTarget`: la colonna d'arrivo del
 *  trascinamento; `picker`: l'operatrice col selettore del colore aperto. */
export default function OperatorHeaderCell({ row, col, isTarget, opFirsts, showRevenue, t, lang, picker, setPicker, setOpColor, opPalette }) {
  const o = row.operator;
  const cnt = row.appointments.length;
  const rev = apptRevenue(row.appointments);   // il no-show non entra, come nel mese
  const onShift = (row.windows || []).length > 0;
  return (
    <div title={o.name + (onShift ? ' · ' + t('turno', 'shift') + ' ' + (row.windows || []).map(([a, b]) => `${a}–${b}`).join(', ') : ' · ' + t('non in turno', 'not on shift'))} style={{ flex: '1 0 ' + COLW + 'px', padding: '10px 11px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, borderRadius: '0 0 12px 12px', background: col, position: 'relative', outline: isTarget ? '2px solid var(--ink)' : 'none', outlineOffset: -2, transition: 'outline 100ms', opacity: onShift ? 1 : 0.7 }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <Avatar initials={initialsOf(o.name)} size={34} color={col} ring />
        <span title={onShift ? t('In turno', 'On shift') : t('Non in turno', 'Off today')} style={{ position: 'absolute', bottom: -1, right: -1, width: 11, height: 11, borderRadius: 99, background: onShift ? 'var(--ok)' : 'var(--faint)', border: '2px solid #fff' }} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div title={o.name} style={{ fontWeight: 700, fontSize: 20, whiteSpace: 'nowrap', color: 'var(--ink)', letterSpacing: '-0.015em', lineHeight: 1.05, overflow: 'hidden', textOverflow: 'ellipsis' }}>{opDisplay(firstName(o.name), lastName(o.name), opFirsts)}</div>
        <div style={{ color: 'var(--ink)', opacity: 0.6, fontSize: 11.5, fontWeight: 500, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {onShift
            ? `${cnt}${showRevenue ? ' · ' + fmtMoney(rev, lang) : ''}`
            : t('Non in turno', 'Off today')}
        </div>
      </div>
      <button onClick={() => setPicker(picker === o.id ? null : o.id)} title={t('Cambia colore', 'Change colour')} style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, cursor: 'pointer', display: 'grid', placeItems: 'center', border: 'none', background: 'rgba(255,255,255,0.55)' }}>
        <Icon name="palette" size={14} color="var(--ink)" />
      </button>
      {picker === o.id && <OpColorPicker opId={o.id} col={col} t={t} setOpColor={setOpColor} setPicker={setPicker} opPalette={opPalette} />}
    </div>
  );
}

/* ---- selettore del colore: ruota dei colori, campo esadecimale, tavolozza ---- */
function OpColorPicker({ opId, col, t, setOpColor, setPicker, opPalette }) {
  return (
    <React.Fragment>
      <div onClick={() => setPicker(null)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
      <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 6, zIndex: 61, padding: 12, boxShadow: 'var(--sh-pop)', width: 250, boxSizing: 'border-box' }}>
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('Colore operatrice', 'Stylist colour')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: col }}>
            <input type="color" value={(col && col[0] === '#') ? col : '#C9B8F2'} onChange={(e) => setOpColor(opId, e.target.value)} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
          </label>
          {/* Il campo completava con zeri e salvava a ogni tasto: scrivendo
              «C9B8F2» passavano C00000, C90000… con un PATCH e un evento
              live per ogni lettera, e il campo si riempiva di zeri sotto
              le dita. HexInput scrive solo a sei cifre valide (o tre, a
              campo lasciato). */}
          <HexInput value={(col && col[0] === '#') ? col : ''} onChange={(c) => setOpColor(opId, c)} width={64} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 3 }}>
          {(opPalette || []).map((c) => {
            const on = (col || '').toLowerCase() === c.toLowerCase();
            return <button key={c} onClick={() => { setOpColor(opId, c); setPicker(null); }} title={c} style={{ width: 19, height: 19, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid transparent', outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1 }} />;
          })}
        </div>
      </div>
    </React.Fragment>
  );
}
