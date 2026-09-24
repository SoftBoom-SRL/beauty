// GhostBlocks — l'ombra dell'appuntamento aperto nel pannello, in una colonna
// della vista giorno, mentre dal pannello si sfoglia un altro giorno: dove
// andrebbe a finire, alla sua ora e nella colonna di chi lo fa. Serve a
// inquadrare il posto con lo sguardo invece di calcolarlo. Non intercetta il
// puntatore: il clic passa sotto e apre il menu dello slot, che offre «Sposta
// qui» (dentro l'ombra: stessa ora, stesse operatrici, vedi ghostBlockAt).
// «qui» una volta sola, sul primo servizio visibile (`firstId`): scritto in
// cima a ogni colonna, anche l'ombra della piega diceva «11:00 · qui» e
// invitava a spostare la visita alle 11. Senza hook: nei test fa parte di
// DayGrid.
import { timeLabel } from '@youty/shared';
import { firstName, itemBlocks } from '../lib.js';

export default function GhostBlocks({ ghost, opId, firstId, g0, pxm, t }) {
  return itemBlocks(ghost).filter((b) => b.opId === opId).map((b) => (
    <div key={'ghost' + b.item.id} data-ghost={b.item.id === firstId ? 'first' : ''}
      style={{
        position: 'absolute', left: 4, right: 4,
        top: (b.startMin - g0) * pxm + 1.5, height: b.dur * pxm - 3,
        borderRadius: 12, border: '2px dashed var(--clay)',
        background: 'color-mix(in srgb, var(--clay) 14%, transparent)',
        pointerEvents: 'none', zIndex: 6, overflow: 'hidden',
        padding: '5px 9px', display: 'flex', flexDirection: 'column', gap: 1,
      }}>
      <span className="tabnum" style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--clay-ink)', letterSpacing: '0.04em' }}>
        {timeLabel(b.startMin)}{b.item.id === firstId ? ' · ' + t('qui', 'here') : ''}
      </span>
      {b.dur * pxm > 34 && (
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--clay-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {firstName(ghost.client?.full_name || ghost.client_name)} · {b.item.service_name}
        </span>
      )}
    </div>
  ));
}
