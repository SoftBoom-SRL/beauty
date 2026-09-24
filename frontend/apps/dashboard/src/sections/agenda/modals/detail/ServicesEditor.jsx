// ServicesEditor — i servizi modificabili della visita: per ogni riga ora di
// inizio e di fine, durata, l'attesa dopo (la posa del listino o un buco
// voluto, con «Chiudi il buco») e l'operatrice; poi «Aggiungi servizio» e il
// totale. Le righe sono la bozza del pannello (useApptCopy): `catalog` dà i
// servizi e chi li sa fare, `rows` i comandi sulle righe.
import React from 'react';
import { Avatar, Icon, NumInput, fmtEur, nameIn } from '@youty/shared';
import { fmtMoney, initialsOf } from '../../lib.js';
import { MAX_ITEM_MIN } from '../rules.js';

/* campo orario di una riga servizio: stretto, tabellare, come gli altri numeri */
const timeCellCss = {
  width: 92, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 6px',
  fontSize: 12.5, fontFamily: 'var(--mono, monospace)', fontWeight: 700, textAlign: 'center',
  outline: 'none', background: 'var(--surface)', color: 'var(--ink)',
};

export default function ServicesEditor({
  appt, editItems, spans, gaps, startMin, justAdded, addedRef, addingSvc, setAddingSvc, editTotal, itemsDirty,
  operators, opColors, t, lang, catalog, rows,
}) {
  const { svcOf, catColor, eligibleOps, svcDisplayName, catalogSoak, activeServices } = catalog;
  const {
    draftOf, setDraft, commitItemStart, commitItemEnd, setItemDuration, clampItemDuration, setItemOperator, setItemGap,
    removeServiceItem, addServiceItem,
  } = rows;
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: 14 }}>
      {/* Con più servizi la visita è una sola cosa in agenda: va detto
          qui, insieme al modo per muoverne uno solo. */}
      {(appt.items || []).length > 1 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--surface)', border: '1px dashed var(--hair)' }}>
          <Icon name="calendar" size={14} color="var(--muted)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.35 }}>
            <b>{t(`${(appt.items || []).length} servizi in un'unica visita`, `${(appt.items || []).length} services in one visit`)}</b>{' — '}
            {t('in agenda trascina un servizio per spostare solo quello, o la barra scura a sinistra per spostarli tutti insieme, anche nella colonna di un’altra operatrice.', 'in the agenda drag one service to move just that one, or the dark bar on its left to move them all together, into another stylist’s column too.')}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {editItems.map((it, i) => {
          const s = svcOf(it.service_id);
          const color = catColor(s?.category_id);
          const isNew = it.id == null;
          // L'operatrice si sceglie su OGNI riga, non solo su quelle
          // nuove: era l'unico modo per sapere su chi finiva un servizio
          // aggiunto, e per passarne uno alla collega senza trascinare.
          const eligible = eligibleOps(it.service_id);
          // Chi ha già la riga resta scritta anche se nel frattempo non
          // è più abilitata al servizio o è stata disattivata: prima
          // nessuna pillola era accesa e non si capiva chi avesse il
          // servizio (13-13).
          const holder = it.operator_id != null && !eligible.some((op) => op.id === it.operator_id)
            ? { id: it.operator_id, name: operators.find((x) => x.id === it.operator_id)?.first_name || it.operator_name || '—', active: operators.some((x) => x.id === it.operator_id) }
            : null;
          const span = spans[i];
          return (
            <div key={it.key} ref={it.key === justAdded ? addedRef : undefined}
              style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: it.key === justAdded ? '8px' : 0, margin: it.key === justAdded ? '-8px' : 0, borderRadius: 10, background: it.key === justAdded ? 'var(--clay-tint)' : 'transparent', transition: 'background 400ms' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: color, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {svcDisplayName(it)}
                  {(appt.gifts || []).some((g) => g.service_id === it.service_id) && <Icon name="gift" size={12} color="var(--clay-ink)" title={t('Coperto da gift card', 'Covered by a gift card')} style={{ marginLeft: 6, verticalAlign: '-2px' }} />}
                </span>
                <span className="t-num" style={{ fontSize: 13.5, fontWeight: 700, flexShrink: 0 }}>{fmtEur(Number(it.price), lang)}</span>
                <button className="dk-iconbtn" title={t('Rimuovi servizio', 'Remove service')} onClick={() => removeServiceItem(it.key)} style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0 }}>
                  <Icon name="x" size={14} />
                </button>
              </div>
              {/* Ora di inizio e di fine, scrivibili. Fra un servizio e
                  l'altro ci può essere un'attesa: la riga qui sotto la
                  dice e offre di chiuderla, senza imporre niente. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 16, flexWrap: 'wrap' }}>
                <input type="time" step={300} value={draftOf(it.key, 'from', span ? span.from : startMin)}
                  onChange={(e) => setDraft(it.key, 'from', e.target.value)}
                  onBlur={(e) => commitItemStart(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                  title={i === 0 ? t('Inizio della visita: cambiarlo sposta tutti i servizi', 'Start of the visit: changing it moves every service') : t('Inizio: allarga o stringe l’attesa prima di questo servizio', 'Start: widens or narrows the wait before this service')}
                  aria-label={t('Ora di inizio del servizio', 'Service start time')}
                  style={timeCellCss} />
                <span className="t-sm" style={{ color: 'var(--muted-2)' }}>→</span>
                <input type="time" step={300} value={draftOf(it.key, 'to', span ? span.to : startMin)}
                  onChange={(e) => setDraft(it.key, 'to', e.target.value)}
                  onBlur={(e) => commitItemEnd(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                  title={t('Fine del lavoro: quello che viene dopo è attesa', 'End of the work: what follows is waiting')}
                  aria-label={t('Ora di fine del servizio', 'Service end time')}
                  style={timeCellCss} />
                <NumInput integer min={5} max={MAX_ITEM_MIN} value={it.duration_min} emptyValue=""
                  onChange={(v) => setItemDuration(it.key, v)} onBlur={() => clampItemDuration(it.key)}
                  aria-label={t('Durata in minuti', 'Duration in minutes')}
                  style={{ width: 48, marginLeft: 4, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 7px', fontSize: 12.5, fontFamily: 'var(--sans)', textAlign: 'right', outline: 'none', background: 'var(--surface)', color: 'var(--ink)' }} />
                <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('min', 'min')}</span>
              </div>
              {/* Attesa dopo questo servizio: la posa del listino è
                  normale (grigia), quella in più è un buco voluto e si
                  dice in ambra — con il tasto per chiuderlo. Nessuno
                  impedisce di lasciarlo. */}
              {i < editItems.length - 1 && span && (span.gap > 0 || gaps.some((g) => g.index === i)) && (() => {
                const extra = span.gap - catalogSoak(it);
                const warn = extra > 0;
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 16, padding: '5px 9px', borderRadius: 9, background: warn ? 'var(--warn-tint)' : 'var(--surface)', border: '1px dashed ' + (warn ? 'color-mix(in srgb, var(--warn) 45%, transparent)' : 'var(--hair)') }}>
                    <Icon name={warn ? 'alert' : 'clock'} size={13} color={warn ? 'var(--warn)' : 'var(--muted-2)'} />
                    <span className="t-sm" style={{ flex: 1, minWidth: 0, color: warn ? 'var(--warn)' : 'var(--muted)', fontWeight: warn ? 600 : 500 }}>
                      {catalogSoak(it) > 0 && !warn
                        ? t(`${span.gap} minuti di posa, poi ${svcDisplayName(editItems[i + 1])}`, `${span.gap} minutes of soak, then ${svcDisplayName(editItems[i + 1])}`)
                        : t(`${span.gap} minuti di attesa prima di ${svcDisplayName(editItems[i + 1])}`, `${span.gap} minutes of waiting before ${svcDisplayName(editItems[i + 1])}`)}
                    </span>
                    {/* «Chiudi il buco» solo per l'attesa in più: la
                        posa del listino non è un buco, è il colore che
                        deve fare il suo tempo. */}
                    {warn && (
                      <button type="button" onClick={() => setItemGap(it.key, catalogSoak(it))}
                        title={t('Riporta il servizio successivo subito dopo questo', 'Bring the next service right after this one')}
                        style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
                        {t('Chiudi il buco', 'Close the gap')}
                      </button>
                    )}
                  </div>
                );
              })()}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 16, flexWrap: 'wrap' }}>
                {holder && (
                  <React.Fragment>
                    <span className="dk-pill dk-pill--tint dk-pill--on" style={{ '--pill-c': opColors[holder.id] || 'var(--muted-2)', padding: '2px 9px 2px 3px', fontSize: 11.5, cursor: 'default' }}>
                      <Avatar initials={initialsOf(holder.name)} size={18} color={opColors[holder.id] || 'var(--muted-2)'} ring />
                      <span>{holder.name}</span>
                    </span>
                    <span className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Icon name="alert" size={11} color="var(--warn)" />{holder.active ? t('non più abilitata a questo servizio', 'no longer enabled for this service') : t('non più attiva', 'no longer active')}
                    </span>
                  </React.Fragment>
                )}
                {eligible.length > 0 ? (
                  <React.Fragment>
                    {eligible.map((op) => {
                      const on = op.id === it.operator_id;
                      return (
                        <button key={op.id} type="button" onClick={() => setItemOperator(it.key, op.id)}
                          className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')}
                          style={{ '--pill-c': opColors[op.id] || 'var(--clay)', padding: '2px 9px 2px 3px', fontSize: 11.5 }}>
                          <Avatar initials={op.initials} size={18} color={opColors[op.id] || 'var(--clay)'} ring={on} />
                          <span>{op.first_name}</span>
                        </button>
                      );
                    })}
                    {isNew && (
                      <button type="button" onClick={() => setItemOperator(it.key, null)} className={'dk-pill' + (it.operator_id === null ? ' dk-pill--on' : '')} style={{ padding: '3px 9px', fontSize: 11.5 }}>
                        <Icon name="sparkle" size={11} color={it.operator_id === null ? '#fff' : 'var(--muted-2)'} />{t('Prima disponibile', 'First available')}
                      </button>
                    )}
                  </React.Fragment>
                ) : !holder && (
                  <span className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="alert" size={12} color="var(--danger)" />{t('Nessuna operatrice abilitata a questo servizio', 'No stylist can perform this service')}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* add a service */}
      <div style={{ marginTop: 10 }}>
        {!addingSvc ? (
          <button onClick={() => setAddingSvc(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', padding: 0 }}>
            <Icon name="plus" size={14} color="var(--clay-ink)" />{t('Aggiungi servizio', 'Add service')}
          </button>
        ) : (
          <div style={{ border: '1px dashed var(--line-strong)', borderRadius: 12, padding: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <span className="t-meta" style={{ margin: 0 }}>{t('Scegli un servizio', 'Choose a service')}</span>
              <button onClick={() => setAddingSvc(false)} className="dk-iconbtn" style={{ width: 24, height: 24, borderRadius: 7, marginLeft: 'auto' }}><Icon name="x" size={13} /></button>
            </div>
            {activeServices.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {/* stesso codice colore dei blocchi in agenda: la
                    pillola è tinta della sua categoria, non solo un
                    pallino accanto al nome */}
                {activeServices.map((s) => (
                  <button key={s.id} onClick={() => { addServiceItem(s.id); setAddingSvc(false); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `2px solid color-mix(in srgb, ${catColor(s.category_id)} 50%, transparent)`, background: `color-mix(in srgb, ${catColor(s.category_id)} 26%, var(--surface))`, color: 'var(--ink)' }}>
                    {nameIn(s, lang)}
                    <Icon name="plus" size={12} color="var(--ink-2)" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun servizio disponibile', 'No service available')}</div>
            )}
          </div>
        )}
      </div>

      <div className="hr" style={{ margin: '10px 0 8px' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontWeight: 700 }}>
        <span>{t('Totale', 'Total')}</span>
        <span className="t-num" style={{ fontSize: 17 }}>{fmtMoney(editTotal, lang)}</span>
      </div>
      {/* Il pulsante che salva sta nel piede del pannello, sempre in
          vista: qui resta solo il promemoria di dove guardare. */}
      {itemsDirty && (
        <div className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 600, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="chevD" size={13} color="var(--clay-ink)" />{t('Salva le modifiche col pulsante qui sotto', 'Save your changes with the button below')}
        </div>
      )}
    </div>
  );
}
