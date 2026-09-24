// ServiceStep — il passo 2 del drawer: i servizi (pillole nel colore della
// loro categoria, filtro oltre dieci) e, per ognuno scelto, chi lo fa
// («Prima disponibile» o un'operatrice abilitata) e il regalo che lo copre.
// `stepRef` è la ref del passo (la checklist del piede ci porta).
import { Avatar, Icon, fmtDur, fmtEur } from '@youty/shared';
import { firstName } from '../../lib.js';
import { usableCode } from '../rules.js';
import StepLabel from './StepLabel.jsx';

export default function ServiceStep({
  stepRef, items, activeServices, filteredServices, svcQ, setSvcQ, inputCss, isSelected, toggleService, eligibleOps, catColor, svcOf,
  svcName, giftFor, selSlot, assignedName, removeItem, setItemOp, onClose, setTab, t, lang,
}) {
  return (
    <div ref={stepRef} style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StepLabel n={2} done={items.length > 0} t={t}>{t('Servizi', 'Services')}</StepLabel>
        {activeServices.length > 10 && (
          <input value={svcQ} onChange={(e) => setSvcQ(e.target.value)} placeholder={t('Filtra…', 'Filter…')} style={{ ...inputCss, marginLeft: 'auto', width: 130, padding: '5px 9px', fontSize: 12.5, marginBottom: 8 }} />
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {/* La pillola prende il colore della sua categoria, piena: è lo
            stesso codice colore dei blocchi in agenda, e con il solo
            pallino il servizio si leggeva solo parola per parola. */}
        {filteredServices.map((s) => {
          const on = isSelected(s.id);
          const noOps = !eligibleOps(s.id).length;
          const cat = catColor(s.category_id);
          return (
            <button key={s.id} type="button" onClick={() => toggleService(s.id)} className="dk-pill" title={noOps ? t('Nessuna operatrice abilitata', 'No stylist enabled') : `${fmtDur(s.duration_min, lang)} · ${fmtEur(Number(s.price), lang)}`}
              style={{
                padding: '5px 11px', fontSize: 12.5, opacity: noOps && !on ? 0.55 : 1, color: 'var(--ink)',
                borderWidth: 2, fontWeight: on ? 700 : 600,
                background: on ? `color-mix(in srgb, ${cat} 70%, #FFFFFF)` : `color-mix(in srgb, ${cat} 26%, var(--surface))`,
                borderColor: on ? `color-mix(in srgb, ${cat} 60%, var(--ink))` : `color-mix(in srgb, ${cat} 50%, transparent)`,
                boxShadow: on ? `0 0 0 3px color-mix(in srgb, ${cat} 32%, transparent)` : 'none',
              }}>
              {svcName(s, lang)}
              {giftFor(s.id) && <Icon name="gift" size={12} color="var(--clay-ink)" title={t('Coperto da una gift card', 'Covered by a gift card')} />}
              <Icon name={on ? 'check' : 'plus'} size={12} stroke={2.6} color={on ? 'var(--ink)' : 'var(--ink-2)'} />
            </button>
          );
        })}
        {!filteredServices.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun servizio corrisponde', 'No service matches')}</span>}
      </div>

      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {items.map((it) => {
            const s = svcOf(it.service_id);
            if (!s) return null;
            const eligible = eligibleOps(it.service_id);
            const assigned = it.operator_id === null && selSlot ? assignedName(it.service_id) : null;
            return (
              <div key={it.key} style={{ border: '1px solid var(--hair)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', background: `color-mix(in srgb, ${catColor(s.category_id)} 16%, var(--surface))`, borderBottom: '1px solid var(--hair)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: catColor(s.category_id), flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{svcName(s, lang)}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {fmtDur((s.duration_min || 0) + (s.soak_min || 0), lang)}{s.soak_min ? ' · ' + t('incl. posa', 'incl. soak') + ' ' + fmtDur(s.soak_min, lang) : ''}
                      {assigned && <span> · {t('farà', 'by')} <b style={{ color: 'var(--ink)' }}>{assigned}</b></span>}
                    </div>
                  </div>
                  {giftFor(s.id) && (
                    <span title={[t('Gift card', 'Gift card'), usableCode(giftFor(s.id).code)].filter(Boolean).join(' ')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--clay) 40%, transparent)', padding: '2px 8px', borderRadius: 99, flexShrink: 0 }}>
                      <Icon name="gift" size={11} color="var(--clay-ink)" />{t('Regalo', 'Gift')}{giftFor(s.id).buyer_name ? ' · ' + firstName(giftFor(s.id).buyer_name) : ''}
                    </span>
                  )}
                  <span className="t-num" style={{ fontSize: 13.5, fontWeight: 700, flexShrink: 0, textDecoration: giftFor(s.id) ? 'line-through' : 'none', color: giftFor(s.id) ? 'var(--muted-2)' : undefined }}>{fmtEur(Number(s.price), lang)}</span>
                  <button type="button" className="dk-iconbtn" style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0 }} onClick={() => removeItem(it.key)} aria-label={t('Rimuovi', 'Remove')}><Icon name="x" size={13} /></button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 11px' }}>
                  <button type="button" onClick={() => setItemOp(it.key, null)} className={'dk-pill' + (it.operator_id === null ? ' dk-pill--on' : '')} style={{ padding: '4px 10px', fontSize: 12 }}>
                    <Icon name="sparkle" size={12} color={it.operator_id === null ? '#fff' : 'var(--muted-2)'} />{t('Prima disponibile', 'First available')}
                  </button>
                  {eligible.map((o) => {
                    const on = o.id === it.operator_id;
                    return (
                      <button key={o.id} type="button" onClick={() => setItemOp(it.key, o.id)} className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')} style={{ '--pill-c': o.color || 'var(--clay)', padding: '3px 10px 3px 4px', fontSize: 12 }}>
                        <Avatar initials={o.initials} size={20} color={o.color || 'var(--clay)'} ring={on} />
                        <span>{o.first_name}</span>
                        {on && <Icon name="check" size={12} stroke={2.6} />}
                      </button>
                    );
                  })}
                  {!eligible.length && (
                    <span className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Icon name="alert" size={13} color="var(--danger)" />{t('Nessuna operatrice abilitata a questo servizio', 'No stylist can perform this service')}
                      <button type="button" onClick={() => { onClose?.(); setTab('staff'); }} style={{ color: 'var(--clay-ink)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>{t('Abilita in Staff', 'Enable in Staff')}</button>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
