// TeamFilter — quali colonne disegna la vista giorno, dalla barra: un bottone
// con le facce del team e, aperto, l'elenco da accendere e spegnere,
// «Solo» per guardare la giornata di una persona sola e «Solo chi lavora oggi».
// Prima era una riga di chip sotto la barra, sempre aperta: 60 px d'altezza
// tolti alla griglia per una scelta che si fa una volta ogni tanto.
import { useCallback, useRef, useState } from 'react';
import { Avatar, Icon, Toggle } from '@youty/shared';
import { useClickAway } from '../../../hooks/useClickAway.js';
import { opDisplay } from '../lib.js';

const AWAY = { event: 'pointerdown', capture: true, escape: true };

/** `vis` / `toggleVis` / `setAll` / `only` = useOperatorVisibility;
 *  `onlyWorking` / `setOnlyWorking` = «Solo chi lavora oggi» (senza
 *  `setOnlyWorking`, in settimana, l'interruttore non c'è), `resting` = gli id che nasconde
 *  (restingIds); `shown` / `total` = colonne visibili e colonne del giorno
 *  (`shown` null mentre la giornata carica). */
export default function TeamFilter({ operators, vis, toggleVis, setAll, only, colorOf, onlyWorking, setOnlyWorking, resting = [], shown, total, t }) {
  const nResting = resting.length;
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useClickAway(ref, open, close, AWAY);
  const opFirsts = operators.map((o) => o.first_name);   // disambiguazione omonimie
  const on = operators.filter((o) => vis[o.id] !== false);
  const filtered = shown != null && shown < total;
  const faces = (on.length ? on : operators).slice(0, 3);
  const summary = filtered
    ? t(`${shown} di ${total} colonne in agenda`, `${shown} of ${total} columns shown`)
    : t('Tutto il team in agenda', 'Whole team shown');
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" className="dk-agbtn dk-agbtn--icon-narrow" aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)} title={summary + (nResting ? ' · ' + t(`${nResting} a riposo oggi`, `${nResting} off today`) : '')}>
        {/* le facce: un'iniziale sul colore dell'operatrice (le due lettere
            dell'Avatar a questa misura non si leggevano) */}
        <span style={{ display: 'inline-flex' }} aria-hidden="true">
          {faces.map((o, i) => (
            <span key={o.id} style={{ marginLeft: i ? -6 : 0, width: 20, height: 20, borderRadius: 99, boxShadow: '0 0 0 2px var(--surface)', background: `color-mix(in srgb, ${colorOf(o.id)} 28%, var(--surface))`, border: `1.5px solid ${colorOf(o.id)}`, boxSizing: 'border-box', display: 'grid', placeItems: 'center', fontSize: 9.5, fontWeight: 800, color: 'var(--ink)' }}>
              {(o.first_name || o.initials || '?').charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
        <span className="dk-ag-lbl">{t('Team', 'Team')}</span>
        {filtered && <span className="tabnum" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', borderRadius: 99, padding: '1px 7px' }}>{shown}/{total}</span>}
        <Icon name="chevD" size={13} color="var(--muted)" className="dk-ag-t2" />
      </button>
      {open && (
        <div className="dk-card dk-teampop" role="dialog" aria-label={t('Colonne in agenda', 'Columns in the agenda')}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px 8px' }}>
            <span className="t-meta" style={{ flex: 1 }}>{t('Colonne in agenda', 'Columns in the agenda')}</span>
            <button type="button" className="dk-agbtn dk-agbtn--quiet" style={{ height: 26, padding: '0 8px', fontSize: 12 }}
              onClick={() => setAll(on.length !== operators.length)}>
              {on.length === operators.length ? t('Nessuna', 'None') : t('Tutte', 'All')}
            </button>
          </div>
          <div style={{ maxHeight: 'min(360px, 55vh)', overflowY: 'auto' }}>
            {operators.map((o) => {
              const sel = vis[o.id] !== false;
              return (
                <div key={o.id} className="dk-teamrow">
                  <button type="button" className="dk-teamrow__main" onClick={() => toggleVis(o.id)} aria-pressed={sel}>
                    <span className={'dk-teamcheck' + (sel ? ' dk-teamcheck--on' : '')}>{sel && <Icon name="check" size={12} stroke={3} color="#fff" />}</span>
                    <Avatar initials={o.initials} size={26} color={colorOf(o.id)} ring />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{opDisplay(o.first_name, o.last_name, opFirsts)}</span>
                      {resting.includes(o.id)
                        ? <span className="t-sm" style={{ display: 'block', color: 'var(--warn)', fontSize: 11.5, fontWeight: 600 }}>{t('A riposo oggi', 'Off today')}</span>
                        : o.role_title && <span className="t-sm" style={{ display: 'block', color: 'var(--muted)', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.role_title}</span>}
                    </span>
                  </button>
                  <button type="button" className="only" onClick={() => only(o.id)} title={t(`Mostra solo ${o.first_name}`, `Show only ${o.first_name}`)}>{t('Solo', 'Only')}</button>
                </div>
              );
            })}
          </div>
          {setOnlyWorking && <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 2px 2px', padding: '10px 8px 6px', borderTop: '1px solid var(--hair)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('Solo chi lavora oggi', 'Only who works today')}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.35 }}>
                {onlyWorking && nResting
                  ? t(`${nResting} a riposo oggi, fuori dall'agenda`, `${nResting} off today, not shown`)
                  : t('Nasconde chi non ha turno né appuntamenti', 'Hides who has no shift and no bookings')}
              </div>
            </div>
            <Toggle on={onlyWorking} onChange={setOnlyWorking} />
          </div>}
        </div>
      )}
    </div>
  );
}
