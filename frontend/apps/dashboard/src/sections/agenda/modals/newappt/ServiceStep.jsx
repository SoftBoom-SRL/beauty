// ServiceStep — il passo 2 di «Nuova prenotazione» e di ogni cliente della
// prenotazione di gruppo: i servizi (pillole nel colore del servizio, filtro
// oltre dieci) e, per ognuno scelto, chi lo fa («Prima disponibile» o
// un'operatrice abilitata), il trattamento già pagato che lo copre (regalo,
// pagato in anticipo, seduta di un pacchetto) e i suoi aggiuntivi (la nail art
// durante la manicure: col prezzo, senza tempo), che si aggiungono col «+»
// sotto il servizio. Gli aggiuntivi non sono fra le pillole: da soli non si
// prenotano.
// Con `categories` e più di dieci servizi, i servizi stanno in cartelle, una
// per categoria, come nel vecchio gestionale del salone: si apre la cartella e
// si sceglie; cercando col filtro si vede di nuovo l'elenco intero. La
// cartella aperta (`folder`) e «Altre…» aperto (`othersFor`) sono stato del
// pannello che la contiene. Con `allOps`, «Altre…» sotto
// un servizio mostra anche chi di solito non lo fa: il banco può affidarglielo
// a mano (il server lo accetta solo dallo staff).
// `stepRef` è la ref del passo (la checklist del piede ci porta).
import { Avatar, Icon, fmtDur, fmtEur } from '@youty/shared';
import { addonGroups, firstName, isAddonRow } from '../../lib.js';
import { creditIcon, creditLabel, creditTitle } from '../../../fedelta/credits.js';
import StepLabel from './StepLabel.jsx';
import { inkOn, pillVars } from '../../../../ui/colorTools.js';

export default function ServiceStep({
  stepRef, items, activeServices, filteredServices, svcQ, setSvcQ, inputCss, isSelected, toggleService, eligibleOps, svcColor, svcOf,
  svcName, giftFor, selSlot, assignedName, removeItem, setItemOp, onClose, setTab, t, lang,
  addonServices = [], addAddon = null, addonFor = null, setAddonFor = () => {},
  categories = null, allOps = [], folder = null, setFolder = () => {}, othersFor = null, setOthersFor = () => {},
}) {
  const catIds = new Set((categories || []).map((c) => c.id));
  const catOf = (s) => (catIds.has(s.category_id) ? s.category_id : 'none');
  const folders = categories && activeServices.length > 10 ? [
    ...categories.map((c) => ({ id: c.id, name: lang === 'en' && c.name_en ? c.name_en : c.name_it, color: c.color })),
    { id: 'none', name: t('Altri servizi', 'Other services'), color: null },
  ].map((f) => ({ ...f, items: activeServices.filter((s) => catOf(s) === f.id) })).filter((f) => f.items.length) : null;
  const useFolders = !!folders && !svcQ;
  const open = useFolders ? folders.find((f) => f.id === folder) : null;
  const shown = useFolders ? (open ? open.items : []) : filteredServices;
  return (
    <div ref={stepRef} style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StepLabel n={2} done={items.length > 0} t={t}>{t('Servizi', 'Services')}</StepLabel>
        {activeServices.length > 10 && (
          <input value={svcQ} onChange={(e) => setSvcQ(e.target.value)} placeholder={t('Filtra…', 'Filter…')} style={{ ...inputCss, marginLeft: 'auto', width: 130, padding: '5px 9px', fontSize: 12.5, marginBottom: 8 }} />
        )}
      </div>
      {useFolders && !open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
          {folders.map((f) => {
            const picked = f.items.filter((s) => isSelected(s.id)).length;
            const c = f.color || 'var(--clay)';
            return (
              <button key={f.id} type="button" data-folder={f.id} onClick={() => setFolder(f.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 12, cursor: 'pointer', textAlign: 'left', border: `1.5px solid color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 16%, var(--surface))` }}>
                <Icon name="archive" size={17} color="var(--ink-2)" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    {f.items.length} {t('servizi', 'services')}{picked ? ' · ' + picked + ' ' + t('scelti', 'picked') : ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {open && (
        <button type="button" onClick={() => setFolder(null)} className="dk-pill" style={{ padding: '4px 10px', fontSize: 12, marginBottom: 8 }}>
          <Icon name="chevL" size={12} />{t('Categorie', 'Categories')} · <b>{open.name}</b>
        </button>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {/* La pillola prende il colore del servizio (il suo, o della
            categoria), pieno: è lo stesso codice colore dei blocchi in
            agenda, e con il solo pallino il servizio si leggeva solo
            parola per parola. */}
        {shown.map((s) => {
          const on = isSelected(s.id);
          const noOps = !eligibleOps(s.id).length;
          const cat = svcColor(s);
          const gift = giftFor(s.id);
          // scelta, la pillola è quasi piena: sui colori scuri testo e icone bianchi
          const ink = inkOn(cat, on ? 0.7 : 0.26);
          return (
            <button key={s.id} type="button" onClick={() => toggleService(s.id)} className="dk-pill"
              title={noOps ? t('Nessuna operatrice abilitata', 'No stylist enabled')
                : [`${fmtDur(s.duration_min, lang)} · ${fmtEur(Number(s.price), lang)}`, gift ? creditLabel(gift, t) : ''].filter(Boolean).join(' · ')}
              style={{
                padding: '5px 11px', fontSize: 12.5, opacity: noOps && !on ? 0.55 : 1, color: ink.ink,
                borderWidth: 2, fontWeight: on ? 700 : 600,
                background: on ? `color-mix(in srgb, ${cat} 70%, #FFFFFF)` : `color-mix(in srgb, ${cat} 26%, var(--surface))`,
                borderColor: on ? `color-mix(in srgb, ${cat} 60%, var(--ink))` : `color-mix(in srgb, ${cat} 50%, transparent)`,
                boxShadow: on ? `0 0 0 3px color-mix(in srgb, ${cat} 32%, transparent)` : 'none',
              }}>
              {svcName(s, lang)}
              {gift && <Icon name={creditIcon(gift)} size={12} color={ink.ink === '#FFFFFF' ? ink.ink : 'var(--clay-ink)'} />}
              <Icon name={on ? 'check' : 'plus'} size={12} stroke={2.6} color={on ? ink.ink : ink.sub} />
            </button>
          );
        })}
        {!useFolders && !filteredServices.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun servizio corrisponde', 'No service matches')}</span>}
      </div>

      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {addonGroups(items, isAddonRow).map(({ item: it, addons }) => {
            const s = svcOf(it.service_id);
            if (!s) return null;
            const eligible = eligibleOps(it.service_id);
            const others = allOps.filter((o) => !eligible.some((e) => e.id === o.id));
            const chosenOther = others.find((o) => o.id === it.operator_id);
            const showOthers = othersFor === it.key || !!chosenOther;
            const assigned = it.operator_id === null && selSlot ? assignedName(it.service_id) : null;
            const picking = addonFor === it.key;
            const gift = giftFor(s.id);
            return (
              <div key={it.key} style={{ border: '1px solid var(--hair)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', background: `color-mix(in srgb, ${svcColor(s)} 16%, var(--surface))`, borderBottom: '1px solid var(--hair)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: svcColor(s), flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{svcName(s, lang)}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {fmtDur((s.duration_min || 0) + (s.soak_min || 0), lang)}{s.soak_min ? ' · ' + t('incl. posa', 'incl. soak') + ' ' + fmtDur(s.soak_min, lang) : ''}
                      {assigned && <span> · {t('farà', 'by')} <b style={{ color: 'var(--ink)' }}>{assigned}</b></span>}
                    </div>
                  </div>
                  {gift && (
                    <span title={creditTitle(gift, t, lang)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--clay) 40%, transparent)', padding: '2px 8px', borderRadius: 99, flexShrink: 0, whiteSpace: 'nowrap' }}>
                      <Icon name={creditIcon(gift)} size={11} color="var(--clay-ink)" />{creditLabel(gift, t, { from: firstName(gift.from_name || '') })}
                    </span>
                  )}
                  <span className="t-num" style={{ fontSize: 13.5, fontWeight: 700, flexShrink: 0, textDecoration: gift ? 'line-through' : 'none', color: gift ? 'var(--muted-2)' : undefined }}>{fmtEur(Number(s.price), lang)}</span>
                  <button type="button" className="dk-iconbtn" style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0 }} onClick={() => removeItem(it.key)} aria-label={t('Rimuovi', 'Remove')}><Icon name="x" size={13} /></button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 11px' }}>
                  <button type="button" onClick={() => setItemOp(it.key, null)} className={'dk-pill' + (it.operator_id === null ? ' dk-pill--on' : '')} style={{ padding: '4px 10px', fontSize: 12 }}>
                    <Icon name="sparkle" size={12} color={it.operator_id === null ? '#fff' : 'var(--muted-2)'} />{t('Prima disponibile', 'First available')}
                  </button>
                  {eligible.map((o) => {
                    const on = o.id === it.operator_id;
                    return (
                      <button key={o.id} type="button" onClick={() => setItemOp(it.key, o.id)} className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')} style={{ ...pillVars(o.color || 'var(--clay)'), padding: '3px 10px 3px 4px', fontSize: 12 }}>
                        <Avatar initials={o.initials} size={20} color={o.color || 'var(--clay)'} ring={on} />
                        <span>{o.first_name}</span>
                        {on && <Icon name="check" size={12} stroke={2.6} />}
                      </button>
                    );
                  })}
                  {showOthers && others.map((o) => {
                    const on = o.id === it.operator_id;
                    return (
                      <button key={o.id} type="button" onClick={() => setItemOp(it.key, o.id)} className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')}
                        title={t(`${o.first_name} di solito non fa questo servizio`, `${o.first_name} doesn't usually do this service`)}
                        style={{ ...pillVars(o.color || 'var(--clay)'), padding: '3px 10px 3px 4px', fontSize: 12, borderStyle: 'dashed', opacity: on ? 1 : 0.8 }}>
                        <Avatar initials={o.initials} size={20} color={o.color || 'var(--clay)'} ring={on} />
                        <span>{o.first_name}</span>
                        <Icon name={on ? 'check' : 'alert'} size={12} stroke={2.4} />
                      </button>
                    );
                  })}
                  {others.length > 0 && !showOthers && (
                    <button type="button" onClick={() => setOthersFor(it.key)} className="dk-pill" style={{ padding: '4px 10px', fontSize: 12, borderStyle: 'dashed' }}
                      title={t('Affida il servizio a chi di solito non lo fa', 'Give the service to someone who doesn’t usually do it')}>
                      {t('Altre…', 'Others…')}
                    </button>
                  )}
                  {chosenOther && (
                    <span className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600, width: '100%' }}>
                      {t(`${chosenOther.first_name} di solito non fa questo servizio: scelta a mano`, `${chosenOther.first_name} doesn't usually do this service: picked by hand`)}
                    </span>
                  )}
                  {!eligible.length && !chosenOther && (
                    <span className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Icon name="alert" size={13} color="var(--danger)" />{t('Nessuna operatrice abilitata a questo servizio', 'No stylist can perform this service')}
                      <button type="button" onClick={() => { onClose?.(); setTab('staff'); }} style={{ color: 'var(--clay-ink)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>{t('Abilita in Staff', 'Enable in Staff')}</button>
                    </span>
                  )}
                </div>
                {/* Gli aggiuntivi di questo servizio: si fanno durante lui,
                    col loro prezzo e senza allungare la durata qui sopra. */}
                {(addons.length > 0 || (addonServices.length > 0 && addAddon)) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '0 11px 9px' }}>
                    {addons.map((x) => {
                      const a = svcOf(x.service_id);
                      // già pagato anche lui: l'icona del suo tipo e il prezzo barrato, come il servizio
                      const covered = giftFor(x.service_id);
                      return (
                        <div key={x.key} data-addon-row={x.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span title={t('Aggiuntivo: si fa durante il servizio, aggiunge il prezzo e non il tempo', 'Add-on: done during the service, adds the price and not the time')}
                            style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            + {a ? svcName(a, lang) : ''}
                            {covered && <span title={creditTitle(covered, t, lang)} style={{ display: 'inline-flex', marginLeft: 5, verticalAlign: '-2px' }}><Icon name={creditIcon(covered)} size={11} color="var(--clay-ink)" /></span>}
                          </span>
                          <span className="t-num" style={{ fontSize: 12.5, fontWeight: 700, flexShrink: 0, textDecoration: covered ? 'line-through' : 'none', color: covered ? 'var(--muted-2)' : undefined }}>{fmtEur(Number(a?.price || 0), lang)}</span>
                          <button type="button" className="dk-iconbtn" style={{ width: 22, height: 22, borderRadius: 7, flexShrink: 0 }} onClick={() => removeItem(x.key)} aria-label={t('Rimuovi aggiuntivo', 'Remove add-on')}><Icon name="x" size={11} /></button>
                        </div>
                      );
                    })}
                    {addonServices.length > 0 && addAddon && (picking ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingTop: 2 }}>
                        {addonServices.map((a) => (
                          <button key={a.id} type="button" onClick={() => { addAddon(it.key, a.id); setAddonFor(null); }} className="dk-pill"
                            style={{ padding: '3px 9px', fontSize: 12, borderWidth: 1.5, borderColor: `color-mix(in srgb, ${svcColor(a)} 50%, transparent)`, background: `color-mix(in srgb, ${svcColor(a)} 20%, var(--surface))`, color: 'var(--ink)' }}>
                            + {svcName(a, lang)}<span className="t-num" style={{ color: 'var(--muted)', fontWeight: 600 }}>{fmtEur(Number(a.price), lang)}</span>
                          </button>
                        ))}
                        <button type="button" className="dk-iconbtn" style={{ width: 22, height: 22, borderRadius: 7 }} onClick={() => setAddonFor(null)} aria-label={t('Chiudi', 'Close')}><Icon name="x" size={11} /></button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setAddonFor(it.key)}
                        title={t('Un servizio che si fa durante questo: aggiunge il prezzo, non il tempo', 'A service done during this one: adds the price, not the time')}
                        style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer' }}>
                        <Icon name="plus" size={12} color="var(--clay-ink)" />{t('Aggiuntivo', 'Add-on')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
