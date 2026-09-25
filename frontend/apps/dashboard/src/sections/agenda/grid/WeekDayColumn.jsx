// WeekDayColumn — la colonna di un giorno in vista settimana, con una
// sotto-colonna per operatrice: righe orarie, riga dell'ora, traccia
// dell'origine e copia che segue il puntatore durante il trascinamento,
// l'ombra dell'appuntamento aperto e i blocchi (WeekBlock) nelle loro corsie.
// Clic e trascinamenti restano a WeekView, che passa i gestori. Senza hook:
// nei test fa parte di WeekView.
import { timeLabel } from '@youty/shared';
import { WEEK_DAY_BORDER, WEEK_TODAY_BG, weekLayout } from '../lib.js';
import { weekColOf } from '../lib/week.js';
import ClosedHours from './ClosedHours.jsx';
import GridLines from './GridLines.jsx';
import NowLine from './NowLine.jsx';
import WeekBlock from './WeekBlock.jsx';

/** `day` = il giorno di weekDays (lib/week.js), `index` = 0 lunedì … 6
 *  domenica; `dg` = il trascinamento in corso (drag.current), `dragging` se
 *  il blocco si è già mosso; `looseTarget`: arrivo in un giorno senza
 *  sotto-colonna per l'operatrice (il blocco si mostra a tutta larghezza);
 *  `nowMin`: l'ora attuale se il giorno è oggi, altrimenti null; `opening` =
 *  gli orari del centro quel giorno ([["09:00","19:00"]], [] se chiuso), o
 *  null se il salone non li ha impostati. */
export default function WeekDayColumn({
  day, index, width, isToday, isTargetDay, looseTarget, dragging, dg, movingObj, marks, g0, g1, pxm, nowMin, opening = null,
  ghost, ghostDate, ghostSpans, openApptId, canWrite, t, colorOf, itemColor,
  onDayAreaClick, onEmptyClick, onBlockDown, onHover, onLeave,
}) {
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
      {day.dayOps.map((o) => {
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
            style={{ flex: 1, minWidth: 0, position: 'relative', borderLeft: '1px solid var(--hair-2)', cursor: canWrite ? 'copy' : 'default', borderRadius: isTarget ? 4 : 0 }}
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
              const lc = a._laneCount || 1, lane = a._lane || 0;
              /* Il blocco trascinato resta nel calcolo delle corsie e lascia
               * la sua traccia lì: tolto dal calcolo, i vicini cambiavano
               * corsia (e larghezza) appena si cominciava a trascinare. La
               * copia che segue il puntatore viaggia sopra (`moving`). */
              if (dragging && a.id === dg.id) {
                return <div key={a.id} className="dk-drag-ghost" style={{ top: (a.startMin - g0) * pxm + 1, height: (a.endMin - a.startMin) * pxm - 2, left: `calc(${(lane / lc) * 100}% + 1px)`, width: `calc(${100 / lc}% - 2px)`, right: 'auto', borderRadius: 6 }} />;
              }
              return (
                <WeekBlock pxm={pxm} g0={g0}
                  key={a.id} a={a} lc={lc} colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} highlight={a.id === openApptId}
                  left={`calc(${(lane / lc) * 100}% + 1px)`} width={`calc(${100 / lc}% - 2px)`}
                  onDown={(e) => onBlockDown(e, a, index)}
                  onHover={onHover} onLeave={onLeave}
                />
              );
            })}
            {isTarget && <WeekBlock pxm={pxm} g0={g0} a={movingObj} moving colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} left={1} width="calc(100% - 2px)" />}
          </div>
        );
      })}
      {looseTarget && <WeekBlock pxm={pxm} g0={g0} a={movingObj} moving colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} left={2} width="calc(100% - 4px)" />}
    </div>
  );
}
