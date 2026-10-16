// ApptHoverCard — l'anteprima di un appuntamento al passaggio del mouse, la
// stessa in giorno e settimana (`hints` = i gesti che la vista permette).
// La mostra la vista che la chiede, con la posizione di hoverPlacement.
import React from 'react';
import { Avatar, Icon, fmtDur, statusMeta, timeLabel } from '@youty/shared';
import { HOVER_CARD_W, aEndMin, aStartMin, addonGroups, initialsOf } from '../lib.js';
import { creditIcon, creditLabel } from '../../fedelta/credits.js';

/** I servizi della visita in fila, ognuno con la sua ora: [{ start, item,
 *  addons }] (gli aggiuntivi col servizio durante il quale si fanno). */
function serviceRows(a) {
  const items = [...(a.items || [])].sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  let cursor = aStartMin(a);
  return addonGroups(items).map((g) => {
    const row = { start: cursor, ...g };
    cursor += (g.item.duration_min || 0) + (g.item.soak_min || 0);
    return row;
  });
}

/* ---------- appointment hover card ---------- */
export default function ApptHoverCard({ hover, t, lang, operators, colorOf, hints = 'day' }) {
  const { a, x, y, side } = hover;
  const o = operators.find((op) => op.id === a.operator_id);
  const opName = o ? o.first_name + ' ' + o.last_name : ((a.items || [])[0]?.operator_name || '');
  const col = colorOf(a.operator_id);
  const startMin = aStartMin(a), endMin = aEndMin(a);
  const sm = statusMeta(a.status, t);
  const rows = serviceRows(a);
  // il servizio indicato (una parte in settimana, un blocco in giorno)
  const focus = new Set(a.focus_item_ids || []);
  const opOf = (it) => (it.operator_name || operators.find((op) => op.id === it.operator_id)?.first_name || '').split(' ')[0];
  const manyOps = new Set(rows.map((r) => r.item.operator_id)).size > 1;
  const addonChips = (addons) => addons.map((x, k) => (
    <span key={k} style={{ marginLeft: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', borderRadius: 6, padding: '1px 6px', whiteSpace: 'nowrap' }}>
      + {x.service_name}
    </span>
  ));
  return (
    <div style={{ position: 'fixed', top: y, left: side === 'right' ? x : undefined, right: side === 'left' ? (window.innerWidth - x) : undefined, zIndex: 90, width: HOVER_CARD_W, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 14, boxShadow: 'var(--sh-pop)', padding: 16, pointerEvents: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Avatar initials={initialsOf(a.client?.full_name)} size={38} color={col} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{a.client?.full_name}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{opName}</div>
        </div>
        {/* lo stato della visita: in griglia si vede solo «arrivata» e «in corso» */}
        {a.status && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, fontSize: 11, fontWeight: 700, color: 'var(--ink-2)', background: 'var(--paper-2)', borderRadius: 99, padding: '3px 8px 3px 7px' }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: sm.color }} />{sm.label}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.length > 1 ? (
          /* Più servizi: uno per riga con la sua ora (e l'operatrice, se
             sono più d'una), quello indicato in evidenza. In fila con «+»
             non si capiva quale blocco fosse quale, né a che ora. */
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
            <Icon name="scissors" size={15} color="var(--muted-2)" style={{ marginTop: 3, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {rows.map((r, i) => {
                const on = focus.has(r.item.id);
                return (
                  <div key={i} data-focus={on ? '' : undefined} style={{ display: 'flex', alignItems: 'baseline', gap: 7, padding: '2px 6px', margin: '0 -6px', borderRadius: 7, background: on ? 'var(--clay-tint)' : 'transparent' }}>
                    <span className="tabnum" style={{ fontSize: 12, color: on ? 'var(--clay-ink)' : 'var(--muted)', fontWeight: on ? 700 : 500, flexShrink: 0 }}>{timeLabel(r.start)}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: on ? 700 : 600 }}>{r.item.service_name}{addonChips(r.addons)}</span>
                    {manyOps && <span className="t-sm" style={{ color: 'var(--muted)', flexShrink: 0 }}>{opOf(r.item)}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
            <Icon name="scissors" size={15} color="var(--muted-2)" style={{ marginTop: 1, flexShrink: 0 }} />
            {/* gli aggiuntivi come etichetta «+ Nail art» accanto al servizio
                durante il quale si fanno: non allungano l'orario qui sotto, e
                in fila con gli altri sembrerebbero un trattamento in più */}
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>
              {rows.map((r, i) => <React.Fragment key={i}>{r.item.service_name}{addonChips(r.addons)}</React.Fragment>)}
            </span>
          </div>
        )}
        {/* Il servizio è già pagato (regalo, pagato in anticipo, seduta di
            un pacchetto): al banco va saputo prima di aprire la visita. */}
        {(a.gifts || []).map((g) => (
          <div key={g.gift_card_id ?? g.code} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
            <Icon name={creditIcon(g)} size={15} color="var(--clay-ink)" style={{ marginTop: 1, flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--clay-ink)' }}>
              {g.service_name ? g.service_name + ' · ' : ''}{creditLabel(g, t)}
            </span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Icon name="clock" size={15} color="var(--muted-2)" style={{ flexShrink: 0 }} />
          <span className="tabnum" style={{ fontSize: 13.5 }}>{timeLabel(startMin)}–{timeLabel(endMin)}</span>
          <span className="t-sm" style={{ color: 'var(--muted-2)' }}>· {fmtDur(endMin - startMin, lang)}</span>
        </div>
        {a.client?.phone && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon name="phone" size={15} color="var(--muted-2)" style={{ flexShrink: 0 }} />
            <span className="tabnum" style={{ fontSize: 13.5 }}>{a.client.phone}</span>
          </div>
        )}
        {/* la permanenza: gli altri appuntamenti attaccati (lib/stay.js) */}
        {a.stay_mates?.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px 11px', background: 'color-mix(in srgb, var(--clay) 9%, transparent)', borderRadius: 10 }}>
            <Icon name="link" size={15} color="var(--clay-ink)" style={{ marginTop: 1, flexShrink: 0 }} />
            <span className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.4 }}>{t('Insieme a', 'Together with')}: {a.stay_mates.join(' · ')}</span>
          </div>
        )}
        {a.note && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 2, padding: '9px 11px', background: 'var(--warn-tint)', borderRadius: 10 }}>
            <Icon name="info" size={15} color="var(--warn)" style={{ marginTop: 1, flexShrink: 0 }} />
            <span className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.4 }}>{a.note}</span>
          </div>
        )}
        {/* In settimana non si ridimensiona: prometterlo sarebbe una bugia. */}
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2, fontSize: 11.5 }}>
          {hints !== 'week'
            ? t('Clic: dettaglio · Trascina: sposta questo servizio · Barra a sinistra: tutta la visita', 'Click: details · Drag: move this service · Left bar: the whole visit')
            : a.parts > 1
              ? t('Clic: dettaglio · Trascina: sposta questo servizio, anche su un altro giorno · Barra scura: tutta la visita', 'Click: details · Drag: move this service, to another day too · Dark bar: the whole visit')
              : t('Clic: dettaglio · Trascina: sposta, anche su un altro giorno', 'Click: details · Drag: move, to another day too')}
        </div>
      </div>
    </div>
  );
}
