// VisitBlocks — i servizi di una colonna in vista giorno, nelle loro corsie,
// con la spina di ogni visita. Corsie: due appuntamenti sovrapposti (un
// incastro forzato) devono stare AFFIANCATI; disegnati a tutta larghezza, il
// secondo copriva il primo e l'incastro diventava impossibile da leggere.
// Posizioni (anche durante il trascinamento) e gesti arrivano da DayGrid
// (`itemPos`, onItemDown…); `onSlotMenuAt(startMin, x, y)` = il menu dello
// slot di questa colonna. Senza hook: nei test fa parte di DayGrid.
import React from 'react';
import { laneCss, laneLayout, visitSpines } from '../lib.js';
import { verdictTone } from '../lib/drag.js';
import ItemBlock from './ItemBlock.jsx';

export default function VisitBlocks({
  opId, blocks, itemPos, g0, pxm, t, lang, canWrite, dragging, openApptId, itemColor, colorOf, soakLabel,
  onItemDown, onItemResizeDown, onHover, onLeave, onSlotMenuAt,
}) {
  const placed = laneLayout(
    blocks.filter((b) => itemPos(b).opId === opId).map((b) => ({ b, pos: itemPos(b) })),
  );
  return (
    <React.Fragment>
      {/* Spina della visita: una barra sul bordo sinistro che copre tutti
          i servizi dello stesso appuntamento in questa colonna. Sta qui e
          non dentro le card perché ogni servizio ha il colore della sua
          categoria — due barre diverse non legano niente — e perché i
          3 px di stacco fra le card la spezzerebbero. */}
      {visitSpines(placed).map((sp) => {
        // La spina è anche la MANIGLIA della visita: premendo qui
        // si trascinano insieme tutti i servizi, mentre il corpo
        // di un blocco ne muove uno solo. Serve un blocco di
        // riferimento per far partire il drag: va bene il primo
        // della visita in questa colonna.
        const ref = placed.find(({ b }) => b.apptId === sp.apptId);
        const tall = (sp.endMin - sp.startMin) * pxm > 46;
        return (
          <div key={'sp' + sp.apptId}
            onPointerDown={ref && canWrite ? (e) => onItemDown(e, ref.b, { whole: true }) : undefined}
            title={t(`Un'unica visita di ${sp.client}: ${sp.total} servizi · trascina qui per spostarli tutti insieme, anche in un'altra colonna`, `One visit for ${sp.client}: ${sp.total} services · drag here to move them all together, to another column too`)}
            style={{
              position: 'absolute', ...laneCss(sp.lane, sp.laneCount, 12),
              top: (sp.startMin - g0) * pxm + 1.5,
              height: (sp.endMin - sp.startMin) * pxm - 3,
              background: 'rgba(17,24,39,0.55)', borderRadius: '12px 0 0 12px',
              pointerEvents: dragging || !canWrite ? 'none' : 'auto',
              cursor: canWrite ? 'grab' : 'default', touchAction: 'none',
              display: 'grid', placeItems: 'center', gap: 3, alignContent: 'center',
              zIndex: 4,
            }}>
            {tall && [0, 1, 2].map((i) => (
              <span key={i} style={{ width: 3, height: 3, borderRadius: 99, background: 'rgba(255,255,255,0.75)' }} />
            ))}
          </div>
        );
      })}
      {/* service blocks (each in its operator's column) */}
      {placed.map(({ b, pos, lane, laneCount }) => (
        <ItemBlock
          key={'i' + b.item.id} block={b} startMin={pos.startMin} activeMin={pos.activeMin} soakMin={pos.soakMin} g0={g0}
          lane={lane} laneCount={laneCount}
          dragging={pos.dragging} tone={pos.dragging ? verdictTone(pos.verdict) : ''} t={t} lang={lang} canWrite={canWrite}
          highlight={b.apptId === openApptId}
          color={itemColor ? itemColor(b.item) : colorOf(b.opId)}
          soakLabel={soakLabel(b.item)} pxm={pxm}
          onDown={(e) => onItemDown(e, b)}
          onResizeDown={(e) => onItemResizeDown(e, b)}
          onHover={dragging ? null : onHover} onLeave={onLeave}
          onSlotMenu={(startMin, x, y) => onSlotMenuAt(startMin, x, y)}
        />
      ))}
    </React.Fragment>
  );
}
