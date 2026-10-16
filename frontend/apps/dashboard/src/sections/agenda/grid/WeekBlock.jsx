// WeekBlock — un servizio in vista settimana, nella sotto-colonna della sua
// operatrice (anche la copia che segue il puntatore durante il
// trascinamento). Una visita con più servizi è una PARTE per servizio
// (`a.parts` > 1, lib/week.js): allora a sinistra c'è la barra scura della
// visita, che la sposta tutta, e il corpo sposta solo questo servizio. I
// servizi della stessa visita uno dopo l'altro nella stessa colonna si
// disegnano attaccati (`joinTop`/`joinBottom`), come un blocco solo.
// Senza hook: i test lo disegnano chiamandolo come una funzione.
import { Icon, statusMeta, timeLabel } from '@youty/shared';
import { DK_START, PXM, addonGroups, blockLook, initialsOf } from '../lib.js';
import { creditIcon, creditsTitle } from '../../fedelta/credits.js';

/** Da quanti px di altezza un blocco stretto scrive il nome per lungo. */
export const WEEK_TALL_PX = 44;

/* ---------- blocco appuntamento della settimana ----------
 * Sfondo nel colore del SERVIZIO (categoria), come in vista giorno: il colore
 * deve dire che lavoro è anche qui — con la tinta dell'operatrice tutti i
 * blocchi di una colonna erano identici e il tipo di trattamento si scopriva
 * solo passandoci sopra. Chi lo fa resta scritto nella striscia verticale a
 * sinistra e nell'intestazione della sotto-colonna. Indicatori caparra dovuta /
 * gift come nella vista giorno.
 *
 * Il testo si adatta allo spazio che il blocco ha davvero sullo schermo (CSS
 * .dk-wblock, container query: la larghezza dipende dalla colonna, che si
 * allarga col lavoro del giorno e con lo zoom di lato). Largo: nome,
 * cognome, ora, servizio, finché ci stanno. Stretto e alto: nome e ora per
 * lungo. Stretto e basso: le iniziali. Prima, sotto i 26 px non c'era scritto
 * niente, e sopra si leggevano «Gre…» o i puntini (il titolare, 16/10).
 * `moving` = copia che segue il puntatore durante il drag (non riceve eventi). */
export default function WeekBlock({ a, left, width, colorOf, itemColor, moving = false, highlight = false, stay = null, linked = false, joinTop = false, joinBottom = false, vertical = true, pxm = PXM, g0 = DK_START, canWrite, t, onDown, onHover, onLeave }) {
  const h = (a.endMin - a.startMin) * pxm;
  const client = String(a.client_name || '');
  const words = client.split(' ');
  const first = words[0], last = words.slice(1).join(' ');
  // il servizio di questo blocco, con gli aggiuntivi che si fanno durante
  const group = addonGroups(a.items)[0];
  const main = group?.item || (a.items || [])[0];
  const svcName = [main?.service_name || '', ...(group?.addons || []).map((x) => '+ ' + (x.service_name || ''))].filter(Boolean).join(' ');
  const isPart = (a.parts || 1) > 1;
  // attaccato al servizio prima della stessa visita: il nome è già sopra,
  // qui si legge il servizio
  const cont = joinTop;
  const time = timeLabel(a.startMin) + (moving ? '–' + timeLabel(a.endMin) : '');
  const partIds = new Set((a.items || []).map((it) => it.service_id));
  // il trattamento già pagato di QUESTO servizio (di una parte, i suoi)
  const gifts = (a.gifts || []).filter((g) => !isPart || partIds.has(g.service_id));
  // la caparra è della visita: la si segna sulla prima parte
  const depositDue = a.deposit_status === 'required' && (!isPart || a.part === 1);
  /* «Forzato» NON si segnala più in griglia. Da quando l'agenda non chiede più
   * conferme — si trascina e basta, si forza per conto nostro al primo rifiuto —
   * quasi ogni appuntamento nasce o passa da una forzatura: il triangolino
   * finiva su tutti i blocchi e non distingueva più niente, spaventando per
   * giornate perfettamente normali. Resta scritto nel pannello di dettaglio,
   * dove serve davvero (e dove la vista giorno lo lascia da tempo). */
  // conclusa: la spunta, una volta per gruppo di servizi attaccati
  const doneMark = a.status === 'closed' && !cont;
  const flags = !!(depositDue || gifts.length || doneMark);
  const sm = statusMeta(a.status, t);
  // arrivata / in corso: il pallino accanto al nome, come in vista giorno
  const showStatusDot = !cont && (a.status === 'checked_in' || a.status === 'in_progress');
  const partTitle = isPart && t(
    `${main?.service_name || ''} · servizio ${a.part} di ${a.parts} della visita di ${first}: trascina il blocco per spostare solo questo servizio, la barra scura a sinistra per spostare tutta la visita`,
    `${main?.service_name || ''} · service ${a.part} of ${a.parts} of ${first}'s visit: drag the block to move just this service, the dark bar on the left to move the whole visit`,
  );
  const color = (main && itemColor
    ? itemColor({ service_id: main.service_id, operator_id: main.operator_id ?? a.operator_id })
    : null) || colorOf(a.operator_id);
  /* Stessa resa della vista giorno (blockLook, lib/colors.js): da fare il
   * colore pieno, col testo bianco sui colori scuri (sempre scuro, sulle
   * tinte scure non si leggeva); conclusa il colore appena accennato e il
   * testo spento. */
  const { bg, ink, ring } = blockLook(color, a.status);
  const soak = Math.min(h, (a.soakMin || 0) * pxm);
  const barW = isPart ? 6 : 3;
  const badge = isPart && (
    <span title={partTitle} style={{ fontWeight: 800, fontSize: 9, letterSpacing: '0.02em', color: 'var(--ink-2)', background: 'rgba(255,255,255,0.72)', borderRadius: 4, padding: '0 3px' }}>
      {a.part}/{a.parts}
    </span>
  );
  const link = stay && !cont && (
    <span title={t(`Stessa permanenza: ${stay.size} appuntamenti di fila`, `Same stay: ${stay.size} back-to-back appointments`)} style={{ display: 'inline-grid' }}>
      <Icon name="link" size={10} color={ink.ink} stroke={2.4} />
    </span>
  );
  const line = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2 };
  // le righe che ci stanno in altezza (in larghezza decide il CSS)
  const rows = cont
    ? { time: h > 30, extra: null }
    : { last: !!last && h > 30, time: h > 44, extra: h > 58 ? svcName : null };
  return (
    <div
      data-appt={a.id} className={'dk-wblock' + (vertical && h >= WEEK_TALL_PX ? ' dk-wblock--tall' : '')}
      onPointerDown={onDown}
      onMouseEnter={(e) => onHover && onHover(a, e.currentTarget)}
      onMouseLeave={() => onLeave && onLeave()}
      style={{
        '--wb-l': barW + 'px',
        position: 'absolute', top: (a.startMin - g0) * pxm + (cont ? 0 : 1), height: h - (cont ? 0 : 1) - (joinBottom ? 0 : 1), left, width, boxSizing: 'border-box',
        borderRadius: `${cont ? 0 : 6}px ${cont ? 0 : 6}px ${joinBottom ? 0 : 6}px ${joinBottom ? 0 : 6}px`, overflow: 'hidden',
        background: bg,
        // la copia trascinata ha il bordo, ma non fra due servizi attaccati
        borderStyle: 'solid', borderColor: 'var(--ink)', borderWidth: moving ? `${cont ? 0 : 2}px 2px ${joinBottom ? 0 : 2}px` : 0,
        // `linked`: della stessa permanenza o della stessa visita di quello aperto o indicato
        boxShadow: moving ? 'var(--sh-pop)' : highlight ? '0 0 0 2.5px var(--ink)' : linked ? '0 0 0 2px var(--clay)' : ring || '0 1px 2px rgba(17,24,39,0.1)',
        // niente ingrandimento sulla copia trascinata: spostava i bordi rispetto
        // all'orario d'arrivo (come in vista giorno)
        transition: moving ? 'none' : 'box-shadow 150ms',
        opacity: a.status === 'no_show' ? 0.5 : moving ? 0.92 : 1,
        cursor: canWrite ? 'grab' : 'pointer', touchAction: 'none',
        pointerEvents: moving ? 'none' : 'auto', zIndex: moving ? 20 : 2,
      }}
    >
      {/* La barra scura della visita: premendo qui si spostano tutti i suoi
          servizi insieme, come la spina in vista giorno. Un servizio solo ha
          la striscia dell'operatrice. */}
      {isPart ? (
        <div data-bar=""
          onPointerDown={canWrite && !moving ? (e) => { e.stopPropagation(); onDown && onDown(e, { whole: true }); } : undefined}
          title={t(`Tutta la visita di ${first}: trascina qui per spostare i ${a.parts} servizi insieme`, `${first}'s whole visit: drag here to move all ${a.parts} services together`)}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: barW, background: 'rgba(17,24,39,0.55)', cursor: canWrite ? 'grab' : 'default', touchAction: 'none', zIndex: 4 }} />
      ) : (
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: barW, background: colorOf(main?.operator_id ?? a.operator_id), pointerEvents: 'none', zIndex: 2 }} />
      )}
      {/* lo stacco dal servizio prima della stessa visita */}
      {cont && <div style={{ position: 'absolute', left: barW, right: 0, top: 0, borderTop: '1px dashed rgba(17,24,39,0.35)', pointerEvents: 'none', zIndex: 2 }} />}
      {/* posa o attesa in fondo, tratteggiata come in vista giorno: in quei
          minuti l'operatrice è libera */}
      {soak > 0 && (
        <div title={t('Posa o attesa: l’operatrice è libera', 'Soak or wait: the stylist is free')}
          style={{ position: 'absolute', left: barW, right: 0, bottom: 0, height: soak, background: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.62) 0 5px, rgba(255,255,255,0.14) 5px 10px)', borderTop: '1px dashed rgba(17,24,39,0.28)', pointerEvents: 'none', zIndex: 1 }} />
      )}
      {flags && (
        <div style={{ position: 'absolute', top: 3, right: 3, display: 'flex', alignItems: 'center', gap: 3, zIndex: 3 }}>
          {doneMark && (
            <span data-done="" className="dk-wblock__done" title={t('Conclusa: conto chiuso', 'Done: bill closed')} style={{ width: 12, height: 12, borderRadius: 99, background: 'var(--ok)', display: 'grid', placeItems: 'center', boxShadow: '0 0 0 1.5px var(--surface)' }}>
              <Icon name="check" size={8} color="#FFFFFF" stroke={3.4} />
            </span>
          )}
          {depositDue && <span title={t('Caparra da versare', 'Deposit due')} style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--warn)' }} />}
          {/* il trattamento già pagato col suo tipo: regalo, pagato in
              anticipo, pacchetto (e le sedute nel tooltip) */}
          {gifts.length > 0 && <span className="dk-wblock__gift" title={creditsTitle(gifts, t, null, { code: false })} style={{ display: 'grid' }}><Icon name={creditIcon(gifts[0])} size={10} color={ink.sub} stroke={2.2} /></span>}
        </div>
      )}
      {/* largo: le righe una sotto l'altra */}
      <div className="dk-wblock__h" style={{ position: 'relative', zIndex: 2, padding: `3px ${flags ? 14 : 4}px 0 ${barW + 4}px`, color: ink.ink, pointerEvents: 'none' }}>
        <div className="dk-wblock__l1" style={{ ...line, fontSize: cont ? 10 : 10.5, fontWeight: cont ? 600 : 700 }}>
          {showStatusDot && <span title={sm.label} style={{ display: 'inline-block', verticalAlign: 'middle', width: 6, height: 6, borderRadius: 99, background: sm.color, marginRight: 3, marginTop: -2, boxShadow: '0 0 0 1.5px rgba(255,255,255,0.8)' }} />}
          {cont ? svcName : first}
        </div>
        {rows.last && <div style={{ ...line, fontSize: 10, fontWeight: 600 }}>{last}</div>}
        {rows.time && (
          <div className="tabnum" style={{ fontSize: 9.5, color: ink.sub, marginTop: 1, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>{time}</span>{link}{badge}
          </div>
        )}
        {rows.extra && <div style={{ ...line, fontSize: 9, fontWeight: 700, color: ink.sub, marginTop: 1 }}>{rows.extra}</div>}
      </div>
      {/* blocco troppo basso per la riga dell'orario: collegamento e parte si dicono comunque */}
      {!rows.time && (link || badge) && (
        <span className="dk-wblock__badges" style={{ position: 'absolute', bottom: 2, right: 3, zIndex: 3, display: 'flex', alignItems: 'center', gap: 3, pointerEvents: 'none' }}>{link}{badge}</span>
      )}
      {/* stretto e alto: nome (o servizio) e ora per lungo, se le
          preferenze lo vogliono (`vertical`, «Scritte nei blocchi») */}
      {vertical && h >= WEEK_TALL_PX && <div className="dk-wblock__v" style={{ color: ink.ink }}>{cont ? svcName : client} · {time}</div>}
      {/* stretto: le iniziali della cliente; di un servizio attaccato
          l'inizio del suo nome («Ricos»: l'ora non ci stava e restava «11:1»).
          Sotto, dove c'è posto, l'ora */}
      <div className={'dk-wblock__ini' + (cont ? ' dk-wblock__ini--svc' : '')} style={{ color: ink.ink }}>
        {cont ? main?.service_name || '' : initialsOf(client)}
        {h >= 30 && <span className="dk-wblock__ini-t tabnum">{timeLabel(a.startMin)}</span>}
      </div>
    </div>
  );
}
