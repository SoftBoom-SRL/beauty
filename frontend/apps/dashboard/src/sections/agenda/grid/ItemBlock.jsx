// ItemBlock — il blocco di UN servizio in vista giorno, nella colonna della
// sua operatrice: posa o attesa tratteggiate in fondo, caparra incassata,
// maniglia della durata. Lo disegna DayGrid, che gli passa la posizione
// (anche durante il trascinamento) e i gestori del puntatore.
// Senza hook: i test lo disegnano chiamandolo come una funzione.
import { Icon, statusMeta, timeLabel } from '@youty/shared';
import { DK_START, PXM, TONE_BORDER, inkOn, laneCss } from '../lib.js';

/* ---------- service block (one per AppointmentService) ---------- */
export default function ItemBlock({ block, startMin, activeMin, soakMin, g0 = DK_START, lane = 0, laneCount = 1, dragging, tone, color, highlight = false, soakLabel, pxm = PXM, t, lang, canWrite, onDown, onResizeDown, onHover, onLeave, onSlotMenu }) {
  const { item, appt, isFirst, index } = block;
  const active = activeMin ?? block.activeMin ?? 0;
  const soak = soakMin ?? block.soakMin ?? 0;
  const h = (active + soak) * pxm;
  /* Quante righe ci stanno: una sola (cliente, servizio, ora in fila) sotto i
   * 44 px, due (cliente e servizio) fino a 62, tre con l'orario. Prima la
   * terza riga compariva anche dove non c'era posto e usciva tagliata. */
  const compact = h < 44;
  const showTime = compact || h >= 62;
  // Visita con più servizi: senza un segno che li lega, in agenda si vedono
  // due riquadri identici a due appuntamenti diversi della stessa cliente, e
  // non si capisce né che sono una cosa sola né che si possono staccare.
  const total = (appt.items || []).length;
  const grouped = total > 1;
  const bg = `color-mix(in srgb, ${color} 82%, #FFFFFF)`;
  // testo scuro sui colori chiari, bianco su quelli scuri (vedi lib/colors.js)
  const ink = inkOn(color, 0.82);
  const client = appt.client?.full_name || appt.client_name || '';
  const sm = statusMeta(appt.status, t);
  const showStatusDot = appt.status === 'checked_in' || appt.status === 'in_progress';
  const textZ = { position: 'relative', zIndex: 2 };
  return (
    <div
      data-appt={appt.id}
      onPointerDown={(e) => onDown(e)}
      onContextMenu={(e) => {
        // Sopra un appuntamento il clic sinistro apre quello esistente, quindi
        // non c'era modo di dire «qui»: il tasto destro apre il menu dello slot
        // a quell'ora, da cui si incastra una cliente sopra un'altra.
        if (!onSlotMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onSlotMenu(startMin, e.clientX, e.clientY);
      }}
      title={grouped
        ? t(`Visita di ${appt.client?.full_name || ''} · servizio ${index + 1} di ${total}: trascina per spostare solo questo, o trascina la barra scura a sinistra per spostare tutta la visita, anche a un'altra operatrice`,
            `${appt.client?.full_name || ''}'s visit · service ${index + 1} of ${total}: drag to move just this one, or drag the dark bar on the left to move the whole visit, to another stylist too`)
        : undefined}
      onMouseEnter={(e) => onHover && onHover(appt, e.currentTarget)} onMouseLeave={() => onLeave && onLeave()}
      style={{
        position: 'absolute', top: (startMin - g0) * pxm + 1.5, height: h - 3,
        // Mentre si trascina il blocco torna a tutta larghezza: deve restare
        // leggibile sopra gli altri.
        ...(dragging ? { left: 4, right: 4 } : laneCss(lane, laneCount)),
        background: bg, borderRadius: 12, border: dragging ? `2px solid ${TONE_BORDER[tone] || 'var(--ink)'}` : 'none',
        boxShadow: dragging ? 'var(--sh-pop)' : highlight ? '0 0 0 2.5px var(--ink), 0 6px 18px rgba(17,24,39,0.18)' : '0 1px 3px rgba(17,24,39,0.12)',
        // Un solo zIndex: ce n'erano due nello stesso oggetto e vinceva il
        // secondo, così il blocco aperto nel pannello restava a 2 e il suo
        // contorno spariva sotto il vicino di corsia.
        zIndex: dragging ? 20 : highlight ? 3 : 2, overflow: 'hidden',
        // I quattro lati uno per uno: con `padding` breve accanto a
        // `paddingLeft`, a ogni cambio d'altezza (zoom, durata) React
        // riscriveva solo il breve e il rientro della spina tornava a 9 px,
        // col nome sotto la spina. La spina (12 px a sinistra) non copre il
        // testo, e il bollino della caparra non copre l'ora nei blocchi bassi.
        paddingTop: compact ? 3 : 6, paddingBottom: compact ? 3 : 6,
        paddingLeft: grouped ? 21 : compact ? 9 : 10,
        paddingRight: compact && isFirst && appt.deposit_status === 'paid' ? 30 : compact ? 9 : 10,
        cursor: canWrite ? 'grab' : 'pointer', touchAction: 'none', transform: dragging ? 'scale(1.03)' : 'none',
        opacity: appt.status === 'no_show' ? 0.5 : dragging ? 0.92 : 1, transition: dragging ? 'none' : 'box-shadow 150ms',
        display: 'flex', flexDirection: compact ? 'row' : 'column', alignItems: compact ? 'baseline' : 'stretch', gap: compact ? 6 : 0,
      }}
    >
      {/* fase di posa: parte inferiore tratteggiata/più chiara — operatrice NON impegnata */}
      {soak > 0 && (
        <div title={soakLabel === t('ATTESA', 'WAIT') ? t('Attesa prima del trattamento successivo: l’operatrice è libera', 'Wait before the next treatment: the stylist is free') : t('Fase di posa', 'Soak phase')} style={{ position: 'absolute', left: 0, right: 0, top: active * pxm, bottom: 0, background: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.62) 0 6px, rgba(255,255,255,0.14) 6px 12px)', borderTop: '1px dashed rgba(17,24,39,0.28)', borderRadius: '0 0 12px 12px', pointerEvents: 'none', display: 'grid', placeItems: 'center', zIndex: 1 }}>
          {soak * pxm > 20 && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--ink-2)', opacity: 0.7 }}>{soakLabel || t('POSA', 'SOAK')}</span>}
        </div>
      )}
      {isFirst && appt.deposit_status === 'paid' && (
        <div title={t('Caparra incassata', 'Deposit collected')} style={{ position: 'absolute', top: 5, right: 5, width: 22, height: 22, borderRadius: 7, background: 'var(--surface)', border: '1.5px solid var(--ok)', display: 'grid', placeItems: 'center', boxShadow: '0 1px 2px rgba(17,24,39,0.12)', zIndex: 3 }}>
          <Icon name="wallet" size={13} color="var(--ok)" stroke={2} />
        </div>
      )}
      {/* Chi, poi cosa, poi quando: in reception la prima domanda davanti a un
          blocco è «chi arriva?». Prima il nome della cliente era la riga più
          piccola e più chiara, sotto servizio e orario. Nei blocchi bassi
          tutto su una riga: cliente, servizio, ora. */}
      <div style={{ ...textZ, fontWeight: 700, fontSize: 12.5, color: ink.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.25, flex: compact ? '0 1 auto' : 'none', minWidth: 0, paddingRight: !compact && isFirst && appt.deposit_status === 'paid' ? 24 : 0 }}>
        {/* arrivata / in corso: il pallino accanto al nome, visibile in ogni altezza */}
        {showStatusDot && <span title={sm.label} style={{ display: 'inline-block', verticalAlign: 'middle', width: 7, height: 7, borderRadius: 99, background: sm.color, marginRight: 5, marginTop: -2, boxShadow: '0 0 0 1.5px rgba(255,255,255,0.8)' }} />}
        {client || item.service_name}
      </div>
      {client && (
        <div style={{ ...textZ, fontSize: 11.5, fontWeight: 500, color: ink.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.25, flex: compact ? 1 : 'none', minWidth: 0, marginTop: compact ? 0 : 1 }}>
          {item.service_name}
        </div>
      )}
      {showTime && <div style={{ ...textZ, display: 'flex', alignItems: 'center', gap: 5, marginTop: compact ? 0 : 2, flexShrink: 0 }}>
        <span className="tabnum" style={{ fontSize: 11, fontWeight: 600, color: ink.sub, whiteSpace: 'nowrap' }}>{timeLabel(startMin)}{dragging || !compact ? '–' + timeLabel(startMin + active + soak) : ''}</span>
        {grouped && (
          <span className="tabnum" style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.02em', color: ink.ink, background: ink.chip, borderRadius: 5, padding: '1px 4px', flexShrink: 0 }}>{index + 1}/{total}</span>
        )}
      </div>}
      {canWrite && !dragging && (
        <div className="dk-resize-handle" onPointerDown={onResizeDown} title={t('Trascina per cambiare il tempo attivo', 'Drag to change the active time')} style={{ position: 'absolute', left: 0, right: 0, top: soak > 0 ? active * pxm - 5 : undefined, bottom: soak > 0 ? undefined : 0, height: 9, cursor: 'ns-resize', display: 'grid', placeItems: 'center', touchAction: 'none', zIndex: 3 }}>
          <div style={{ width: 26, height: 3, borderRadius: 99, background: 'rgba(17,24,39,0.35)' }} />
        </div>
      )}
    </div>
  );
}
