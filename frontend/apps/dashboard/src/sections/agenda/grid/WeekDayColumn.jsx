// WeekDayColumn — la colonna di un giorno in vista settimana, con una
// sotto-colonna per operatrice: righe orarie, riga dell'ora, traccia
// dell'origine e copia che segue il puntatore durante il trascinamento,
// l'ombra dell'appuntamento aperto e i blocchi (WeekBlock) nelle loro corsie.
// Clic e trascinamenti restano a WeekView, che passa i gestori. Senza hook:
// nei test fa parte di WeekView.
import { timeLabel } from '@youty/shared';
import { WEEK_DAY_BORDER, WEEK_TODAY_BG, opColumnTint, weekLayout } from '../lib.js';
import { weekColOf } from '../lib/week.js';
import ClosedHours from './ClosedHours.jsx';
import GridLines from './GridLines.jsx';
import NowLine from './NowLine.jsx';
import WeekBlock from './WeekBlock.jsx';

/** Dove si disegna un blocco nella sua sotto-colonna: corsia, corsie in cui
 *  si allarga (`_span`, weekLayout) e i bordi attaccati ai servizi della
 *  stessa visita sopra e sotto (`_joinTop`/`_joinBottom`). */
const lanePos = (a) => {
  const lc = a._laneCount || 1, lane = a._lane || 0, span = a._span || 1;
  return { left: `calc(${(lane / lc) * 100}% + 1px)`, width: `calc(${(span / lc) * 100}% - 2px)` };
};

/** `day` = il giorno di weekDays (lib/week.js), `index` = 0 lunedì … 6
 *  domenica; `dg` = il trascinamento in corso (drag.current), `dragging` se
 *  il blocco si è già mosso; `movingObjs` = i blocchi che seguono il
 *  puntatore (movingBlocks), già nel giorno d'arrivo: chi cade in una
 *  colonna che quel giorno non c'è si mostra a tutta larghezza;
 *  `nowMin`: l'ora attuale se il giorno è oggi, altrimenti null; `opening` =
 *  gli orari del centro quel giorno ([["09:00","19:00"]], [] se chiuso), o
 *  null se il salone non li ha impostati. */
export default function WeekDayColumn({
  day, index, width, isToday, isTargetDay, dragging, dg, movingObjs = [], marks, g0, g1, pxm, nowMin, opening = null,
  ghost, ghostDate, ghostSpans, openApptId, canWrite, t, colorOf, itemColor, stays = null, linked = null,
  onDayAreaClick, onEmptyClick, onBlockDown, onHover, onLeave,
}) {
  const arriving = isTargetDay ? movingObjs : [];
  const loose = arriving.filter((m) => !day.dayOps.some((o) => o.id === weekColOf(m)));
  const looseTarget = isTargetDay && !day.dayOps.some((o) => o.id === dg.nop);
  return (
    <div data-daycol={index} className={looseTarget ? 'dk-col--target' : ''}
      onClick={(e) => { if (e.target === e.currentTarget) onDayAreaClick(e, day.date); }}
      onDoubleClick={(e) => onDayAreaClick(e, day.date)}
      style={{ flex: '1 0 ' + width + 'px', minWidth: 0, position: 'relative', borderLeft: WEEK_DAY_BORDER, background: isToday ? WEEK_TODAY_BG : 'transparent', display: 'flex', cursor: canWrite ? 'copy' : 'default' }}>
      {/* righe orarie: sotto i blocchi (z 2), sopra lo sfondo (GridLines) */}
      <GridLines marks={marks} g0={g0} pxm={pxm} />
      {/* fuori dagli orari del centro, tratteggiato come il fuori turno della
          vista giorno: la griglia copre le 24 ore, e senza il tratteggio le 3
          di notte sembravano un orario come un altro */}
      {opening && <ClosedHours windows={opening} g0={g0} g1={g1} pxm={pxm} t={t} labels={{ some: null, none: t('Chiuso', 'Closed') }} />}
      <NowLine nowMin={nowMin} g0={g0} g1={g1} pxm={pxm} variant="week" />
      {day.dayOps.map((o, k) => {
        // la colonna del disegno: col filtro «Team» può non essere la principale (weekColOf)
        const opList = day.list.filter((a) => weekColOf(a) === o.id);
        const isTarget = isTargetDay && dg.nop === o.id;
        return (
          <div
            key={o.id}
            data-subcol=""
            data-day={index}
            data-op={o.id}
            className={isTarget ? 'dk-col--target' : ''}
            onClick={(e) => onEmptyClick(e, o.id, day.date)}
            // il colore dell'operatrice, come in vista giorno; su trasparente,
            // perché sotto resti la tinta di oggi. Larga quanto il suo lavoro
            // del giorno (`weight`, subcolWeight), come la sua testata; la
            // prima non ripete il bordo del giorno
            style={{ flex: `${o.weight || 1} 1 0`, minWidth: 0, position: 'relative', borderLeft: k ? '1px solid var(--hair-2)' : 'none', background: opColumnTint(colorOf(o.id), 'transparent'), cursor: canWrite ? 'copy' : 'default', borderRadius: isTarget ? 4 : 0, transition: dragging ? 'none' : 'flex-grow 200ms var(--ease)' }}
          >
            {/* Ombra dell'appuntamento aperto nel pannello, sul giorno
                che si sta guardando: dove finirebbe, alla sua ora. Non
                intercetta il puntatore — il clic passa sotto. */}
            {ghost && day.date === ghostDate && ghostSpans.filter((g) => g.opId === o.id).map((g) => (
              <div key={'ghost' + g.key} style={{
                position: 'absolute', left: 1, right: 1,
                top: (g.startMin - g0) * pxm + 1, height: g.dur * pxm - 2,
                borderRadius: 6, border: '2px dashed var(--clay)',
                background: 'color-mix(in srgb, var(--clay) 14%, transparent)',
                pointerEvents: 'none', zIndex: 5, overflow: 'hidden', padding: '2px 4px',
              }}>
                <div className="tabnum" style={{ fontSize: 9, fontWeight: 800, color: 'var(--clay-ink)' }}>{timeLabel(g.startMin)}</div>
              </div>
            ))}
            {weekLayout(opList).map((a) => {
              /* Il blocco trascinato resta nel calcolo delle corsie e lascia
               * la sua traccia lì: tolto dal calcolo, i vicini cambiavano
               * corsia (e larghezza) appena si cominciava a trascinare. La
               * copia che segue il puntatore viaggia sopra (`moving`). */
              // la traccia: la parte trascinata, o tutte le parti se si sposta la visita
              const key = a.key ?? a.id;
              if (dragging && (key === dg.key || (dg.whole && a.id === dg.id))) {
                return <div key={key} className="dk-drag-ghost" style={{ top: (a.startMin - g0) * pxm + 1, height: (a.endMin - a.startMin) * pxm - 2, ...lanePos(a), right: 'auto', borderRadius: 6 }} />;
              }
              return (
                <WeekBlock pxm={pxm} g0={g0}
                  key={key} a={a} colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} highlight={a.id === openApptId}
                  stay={stays?.get(a.id)} linked={!!linked?.has(a.id) && a.id !== openApptId}
                  joinTop={a._joinTop} joinBottom={a._joinBottom} {...lanePos(a)}
                  onDown={(e, opts) => onBlockDown(e, a, index, opts)}
                  onHover={onHover} onLeave={onLeave}
                />
              );
            })}
            {/* chi arriva qui: sopra tutti, a tutta larghezza (almeno 56 px:
                in una colonna vuota, stretta, deve restare leggibile) */}
            {arriving.filter((m) => weekColOf(m) === o.id).map((m) => (
              <WeekBlock key={'mv' + (m.key ?? m.id)} pxm={pxm} g0={g0} a={m} moving joinTop={!!m._joinTop} joinBottom={!!m._joinBottom} colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} left={1} width="max(calc(100% - 2px), 56px)" />
            ))}
          </div>
        );
      })}
      {loose.map((m) => (
        <WeekBlock key={'mv' + (m.key ?? m.id)} pxm={pxm} g0={g0} a={m} moving colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} left={2} width="calc(100% - 4px)" />
      ))}
    </div>
  );
}
