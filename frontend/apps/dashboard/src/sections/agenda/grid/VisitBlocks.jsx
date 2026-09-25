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

/** `itemPos(b)` = dove si disegna il blocco adesso (trascinamento compreso),
 *  `restPos(b)` = dove sta fermo (server, o spostamento in salvataggio). */
export default function VisitBlocks({
  opId, blocks, itemPos, restPos = itemPos, g0, pxm, t, lang, canWrite, dragging, openApptId, itemColor, colorOf, soakLabel,
  onItemDown, onItemResizeDown, onHover, onLeave, onSlotMenuAt,
}) {
  /* Le corsie si calcolano sulle posizioni FERME, non su quelle del
   * trascinamento. Contando il blocco trascinato i vicini cambiavano corsia a
   * ogni movimento: entrando in una colonna la si dimezzava, e staccando un
   * servizio la visita si allungava fino al puntatore, con una spina scura
   * lunga mezza giornata e chi stava in mezzo schiacciato a metà. Ora chi si
   * muove lascia la sua traccia nella corsia di partenza e viaggia sopra, a
   * tutta larghezza, nella colonna d'arrivo; le corsie cambiano solo col
   * rilascio. `now` = la posizione di adesso (durante un ridimensionamento
   * cambia la durata, e i servizi dopo slittano, nella stessa corsia). */
  const placed = laneLayout(
    blocks.filter((b) => restPos(b).opId === opId).map((b) => ({ b, pos: restPos(b) })),
  ).map((p) => ({ ...p, now: itemPos(p.b) }));
  const staying = placed.filter((p) => !p.now.dragging);
  const leaving = placed.filter((p) => p.now.dragging);
  const flying = blocks.map((b) => ({ b, pos: itemPos(b) })).filter(({ pos }) => pos.dragging && pos.opId === opId);
  /* La spina viaggia con la visita intera; un servizio staccato (`detach`)
   * esce dalla visita e non ne ha. */
  const flyingSpines = visitSpines(flying.filter(({ pos }) => !pos.detach).map((f) => ({ ...f, lane: 0, laneCount: 1 })));
  const spineStyle = (sp) => ({
    position: 'absolute', ...laneCss(sp.lane, sp.laneCount, 12),
    top: (sp.startMin - g0) * pxm + 1.5,
    height: (sp.endMin - sp.startMin) * pxm - 3,
    background: 'rgba(17,24,39,0.55)', borderRadius: '12px 0 0 12px',
    display: 'grid', placeItems: 'center', gap: 3, alignContent: 'center',
  });
  const dots = (sp) => (sp.endMin - sp.startMin) * pxm > 46 && [0, 1, 2].map((i) => (
    <span key={i} style={{ width: 3, height: 3, borderRadius: 99, background: 'rgba(255,255,255,0.75)' }} />
  ));
  return (
    <React.Fragment>
      {/* Spina della visita: una barra sul bordo sinistro che copre tutti
          i servizi dello stesso appuntamento in questa colonna. Sta qui e
          non dentro le card perché ogni servizio ha il colore della sua
          categoria — due barre diverse non legano niente — e perché i
          3 px di stacco fra le card la spezzerebbero. */}
      {visitSpines(staying.map((p) => ({ ...p, pos: p.now }))).map((sp) => {
        // La spina è anche la MANIGLIA della visita: premendo qui
        // si trascinano insieme tutti i servizi, mentre il corpo
        // di un blocco ne muove uno solo. Serve un blocco di
        // riferimento per far partire il drag: va bene il primo
        // della visita in questa colonna.
        const ref = staying.find(({ b }) => b.apptId === sp.apptId);
        return (
          <div key={'sp' + sp.apptId}
            onPointerDown={ref && canWrite ? (e) => onItemDown(e, ref.b, { whole: true }) : undefined}
            title={t(`Un'unica visita di ${sp.client}: ${sp.total} servizi · trascina qui per spostarli tutti insieme, anche in un'altra colonna`, `One visit for ${sp.client}: ${sp.total} services · drag here to move them all together, to another column too`)}
            style={{
              ...spineStyle(sp),
              pointerEvents: dragging || !canWrite ? 'none' : 'auto',
              cursor: canWrite ? 'grab' : 'default', touchAction: 'none',
              zIndex: 4,
            }}>
            {dots(sp)}
          </div>
        );
      })}
      {/* traccia di chi si muove, nella sua corsia di partenza. Con le forbici
          si muove UN servizio: gli altri della visita restano fermi davvero */}
      {leaving.map(({ b, pos, lane, laneCount }) => (
        <div key={'g' + b.item.id} className="dk-drag-ghost" style={{
          ...laneCss(lane, laneCount),
          top: (pos.startMin - g0) * pxm + 1.5,
          height: ((pos.activeMin ?? b.activeMin ?? 0) + (pos.soakMin ?? b.soakMin ?? 0)) * pxm - 3,
        }} />
      ))}
      {/* service blocks (each in its operator's column) */}
      {staying.map(({ b, now, lane, laneCount }) => (
        <ItemBlock
          key={'i' + b.item.id} block={b} startMin={now.startMin} activeMin={now.activeMin} soakMin={now.soakMin} g0={g0}
          lane={lane} laneCount={laneCount} resizing={!!now.resizing}
          dragging={false} tone="" t={t} lang={lang} canWrite={canWrite}
          highlight={b.apptId === openApptId}
          color={itemColor ? itemColor(b.item) : colorOf(b.opId)}
          soakLabel={soakLabel(b.item)} pxm={pxm}
          onDown={(e) => onItemDown(e, b)}
          onResizeDown={(e) => onItemResizeDown(e, b)}
          onHover={dragging ? null : onHover} onLeave={onLeave}
          onSlotMenu={(startMin, x, y) => onSlotMenuAt(startMin, x, y)}
        />
      ))}
      {/* chi si muove, dove arriva: sopra tutti, a tutta larghezza */}
      {flying.map(({ b, pos }) => (
        <ItemBlock
          key={'i' + b.item.id} block={b} startMin={pos.startMin} activeMin={pos.activeMin} soakMin={pos.soakMin} g0={g0}
          dragging tone={verdictTone(pos.verdict)} t={t} lang={lang} canWrite={canWrite}
          highlight={b.apptId === openApptId}
          color={itemColor ? itemColor(b.item) : colorOf(b.opId)}
          soakLabel={soakLabel(b.item)} pxm={pxm}
          onDown={(e) => onItemDown(e, b)}
          onResizeDown={(e) => onItemResizeDown(e, b)}
          onHover={null} onLeave={onLeave}
        />
      ))}
      {flyingSpines.map((sp) => (
        <div key={'fs' + sp.apptId} style={{ ...spineStyle(sp), pointerEvents: 'none', zIndex: 21 }}>{dots(sp)}</div>
      ))}
    </React.Fragment>
  );
}
