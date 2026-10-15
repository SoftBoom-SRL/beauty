// WeekBlock — un appuntamento in vista settimana, nella sotto-colonna della
// sua operatrice (anche la copia che segue il puntatore durante il
// trascinamento), oppure una PARTE di una visita con più operatrici
// (`a.parts` > 1): allora a sinistra c'è la barra scura della visita, che la
// sposta tutta, e il corpo stacca solo questa parte. Senza hook: i test lo
// disegnano chiamandolo come una funzione.
import { Icon, timeLabel } from '@youty/shared';
import { DK_START, PXM, addonGroups, inkOn, opSegments, serviceBands } from '../lib.js';
import { creditIcon, creditsTitle } from '../../fedelta/credits.js';

/* ---------- blocco appuntamento della settimana ----------
 * Sfondo nel colore del SERVIZIO (categoria), come in vista giorno: il colore
 * deve dire che lavoro è anche qui — con la tinta dell'operatrice tutti i
 * blocchi di una colonna erano identici e il tipo di trattamento si scopriva
 * solo passandoci sopra. Chi lo fa resta scritto nella striscia verticale a
 * sinistra e nell'intestazione della sotto-colonna. Indicatori caparra dovuta /
 * gift come nella vista giorno.
 * `moving` = copia che segue il puntatore durante il drag (non riceve eventi). */
export default function WeekBlock({ a, lc = 1, left, width, colorOf, itemColor, moving = false, highlight = false, stay = null, linked = false, pxm = PXM, g0 = DK_START, canWrite, t, onDown, onHover, onLeave }) {
  const h = (a.endMin - a.startMin) * pxm;
  const parts = String(a.client_name || '').split(' ');
  const first = parts[0], last = parts.slice(1).join(' ');
  const segs = opSegments(a);
  // I servizi con tempo: gli aggiuntivi (la nail art della manicure) non sono
  // una fascia né un servizio in più nel «×2», si leggono come «+ Nail art».
  const groups = addonGroups(a.items);
  const nServices = groups.length || (a.items || []).length;
  const multi = nServices > 1;
  const addonNames = groups.flatMap((g) => g.addons.map((x) => '+ ' + (x.service_name || ''))).join(' ');
  const bands = serviceBands(a);
  const gifts = (a.gifts || []).length;   // il payload settimana può non avere `gifts`
  const depositDue = a.deposit_status === 'required';
  /* «Forzato» NON si segnala più in griglia. Da quando l'agenda non chiede più
   * conferme — si trascina e basta, si forza per conto nostro al primo rifiuto —
   * quasi ogni appuntamento nasce o passa da una forzatura: il triangolino
   * finiva su tutti i blocchi e non distingueva più niente, spaventando per
   * giornate perfettamente normali. Resta scritto nel pannello di dettaglio,
   * dove serve davvero (e dove la vista giorno lo lascia da tempo). */
  const flags = !!(depositDue || gifts);
  // una parte di una visita con più operatrici: «1/2», e la barra per spostarla tutta
  const isPart = (a.parts || 1) > 1;
  const partTitle = isPart && t(
    `Parte ${a.part} di ${a.parts} della visita di ${first}: trascina il blocco per staccarla, la barra scura per spostare tutta la visita`,
    `Part ${a.part} of ${a.parts} of ${first}'s visit: drag the block to detach it, the dark bar to move the whole visit`,
  );
  const svcColor = (it) => (it && itemColor
    ? itemColor({ service_id: it.service_id, operator_id: it.operator_id ?? it.opId ?? a.operator_id })
    : null) || colorOf(a.operator_id);
  // stessa resa della vista giorno (82%): un colore mezzo slavato qui e pieno
  // là non si riconosce come lo stesso trattamento
  const svcTint = (it) => `color-mix(in srgb, ${svcColor(it)} 82%, #FFFFFF)`;
  /* Il testo sta in cima, sul colore del primo servizio: bianco sui colori
   * scuri, come in vista giorno (lib/colors.js). Sempre scuro, sulle tinte
   * scure dei trattamenti non si leggeva. */
  const ink = inkOn(svcColor((a.items || [])[0]), 0.82);
  const textZ = { position: 'relative', zIndex: 2 };
  return (
    <div
      data-appt={a.id} className="dk-wblock"
      onPointerDown={onDown}
      onMouseEnter={(e) => onHover && onHover(a, e.currentTarget)}
      onMouseLeave={() => onLeave && onLeave()}
      style={{
        position: 'absolute', top: (a.startMin - g0) * pxm + 1, height: h - 2, left, width, boxSizing: 'border-box',
        borderRadius: 6, overflow: 'hidden', padding: '3px 5px 3px 8px',
        background: svcTint((a.items || [])[0]),
        border: moving ? '2px solid var(--ink)' : 'none',
        // `linked`: della stessa permanenza di quello aperto o indicato (lib/stay.js)
        boxShadow: moving ? 'var(--sh-pop)' : highlight ? '0 0 0 2.5px var(--ink)' : linked ? '0 0 0 2px var(--clay)' : '0 1px 2px rgba(17,24,39,0.1)',
        // niente ingrandimento sulla copia trascinata: spostava i bordi rispetto
        // all'orario d'arrivo (come in vista giorno)
        transition: moving ? 'none' : 'box-shadow 150ms',
        opacity: a.status === 'no_show' ? 0.5 : moving ? 0.92 : 1,
        cursor: canWrite ? 'grab' : 'pointer', touchAction: 'none',
        pointerEvents: moving ? 'none' : 'auto', zIndex: moving ? 20 : 2,
      }}
    >
      {/* Striscia operatrice: segmenti in proporzione alla durata dei servizi.
          Su una parte è la barra della visita: premendo qui si spostano tutte
          le parti insieme, come la spina in vista giorno. */}
      {isPart ? (
        <div title={partTitle}
          onPointerDown={canWrite && !moving ? (e) => { e.stopPropagation(); onDown && onDown(e, { whole: true }); } : undefined}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, background: 'rgba(17,24,39,0.55)', cursor: canWrite ? 'grab' : 'default', touchAction: 'none', zIndex: 4 }} />
      ) : (
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: multi ? 4 : 3, display: 'flex', flexDirection: 'column', pointerEvents: 'none', zIndex: 2 }}>
          {segs.map((s, k) => (
            <div key={k} style={{ flex: s.w, background: colorOf(s.opId), borderTop: multi && k > 0 ? '1.5px solid var(--surface)' : 'none' }} />
          ))}
        </div>
      )}
      {/* La visita divisa nei suoi servizi: in settimana è UN riquadro, e due o
          tre servizi dentro restavano un blocco unico. Ogni fascia prende il
          colore della sua categoria, in proporzione alla durata: si legge a
          colpo d'occhio che una visita è colore + piega. I nomi no: la
          sottocolonna è larga quaranta pixel e finirebbero sopra quello della
          cliente — stanno nell'anteprima al passaggio del mouse. */}
      {bands.map((b, k) => (
        <div key={k} style={{
          position: 'absolute', left: isPart ? 6 : multi ? 4 : 3, right: 0, top: `${b.fromPct}%`, height: `${b.toPct - b.fromPct}%`,
          background: svcTint(b), borderTop: k > 0 ? '1px dashed rgba(17,24,39,0.35)' : 'none',
          pointerEvents: 'none', zIndex: 1,
        }} />
      ))}
      {flags && (
        <div style={{ position: 'absolute', top: 3, right: 3, display: 'flex', alignItems: 'center', gap: 3, zIndex: 3 }}>
          {depositDue && <span title={t('Caparra da versare', 'Deposit due')} style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--warn)' }} />}
          {/* il trattamento già pagato col suo tipo: regalo, pagato in
              anticipo, pacchetto (e le sedute nel tooltip) */}
          {gifts > 0 && <span title={creditsTitle(a.gifts, t, null, { code: false })} style={{ display: 'grid' }}><Icon name={creditIcon(a.gifts[0])} size={10} color={ink.sub} stroke={2.2} /></span>}
        </div>
      )}
      <div className="dk-wblock__txt" style={{ ...textZ, fontSize: 10.5, fontWeight: 700, color: ink.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2, pointerEvents: 'none', paddingRight: flags ? 14 : 0 }}>
        {/* la permanenza: altri appuntamenti della cliente attaccati a questo */}
        {stay && (
          <span title={t(`Stessa permanenza: ${stay.size} appuntamenti di fila`, `Same stay: ${stay.size} back-to-back appointments`)}
            style={{ display: 'inline-grid', verticalAlign: 'middle', marginRight: 2, marginTop: -2, pointerEvents: 'auto' }}>
            <Icon name="link" size={10} color={ink.ink} stroke={2.4} />
          </span>
        )}
        {first}
      </div>
      {last && h > 30 && lc < 3 && <div className="dk-wblock__txt" style={{ ...textZ, fontSize: 10, fontWeight: 600, color: ink.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2, pointerEvents: 'none' }}>{last}</div>}
      {h > 44 && (
        <div className="tabnum dk-wblock__txt" style={{ ...textZ, fontSize: 9.5, color: ink.sub, marginTop: 1, pointerEvents: 'none', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span>{timeLabel(a.startMin)}{moving ? '–' + timeLabel(a.endMin) : ''}</span>
          {(isPart || multi) && (
            <span title={isPart ? partTitle : t(`${nServices} servizi in un'unica visita`, `${nServices} services in one visit`)}
              style={{ fontWeight: 800, fontSize: 9, letterSpacing: '0.02em', color: 'var(--ink-2)', background: 'rgba(255,255,255,0.72)', borderRadius: 4, padding: '0 3px' }}>
              {isPart ? `${a.part}/${a.parts}` : `×${nServices}`}
            </span>
          )}
        </div>
      )}
      {/* gli aggiuntivi, dove c'è posto: nella sottocolonna stretta restano
          nell'anteprima al passaggio del mouse */}
      {addonNames && h > 58 && lc < 3 && (
        <div className="dk-wblock__txt" title={addonNames}
          style={{ ...textZ, fontSize: 9, fontWeight: 700, color: ink.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2, marginTop: 1, pointerEvents: 'none' }}>
          {addonNames}
        </div>
      )}
      {/* blocco troppo basso per la riga dell'orario: il conteggio va comunque detto */}
      {(isPart || multi) && h <= 44 && (
        <span className="dk-wblock__txt" title={isPart ? partTitle : t(`${nServices} servizi in un'unica visita`, `${nServices} services in one visit`)}
          style={{ position: 'absolute', bottom: 2, right: 3, zIndex: 3, fontWeight: 800, fontSize: 9, color: 'var(--ink-2)', background: 'rgba(255,255,255,0.72)', borderRadius: 4, padding: '0 3px', pointerEvents: 'none' }}>
          {isPart ? `${a.part}/${a.parts}` : `×${nServices}`}
        </span>
      )}
    </div>
  );
}
