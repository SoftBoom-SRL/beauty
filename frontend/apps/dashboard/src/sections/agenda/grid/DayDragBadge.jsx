// DayDragBadge — il badge che segue il puntatore durante un trascinamento in
// vista giorno: orario d'arrivo, operatrice, aggancio ed esito del rilascio;
// fuori dalla griglia, che cosa farà il rilascio. Senza hook: nei test fa
// parte di DayGrid.
import { Icon, parseISO, timeLabel } from '@youty/shared';
import { dayLabel } from '../lib.js';
import { badgeSpot, dragBadge, verdictTone } from '../lib/drag.js';

/** `d` = il trascinamento in corso (drag.current); `opName(opId)` = il nome
 *  dell'operatrice da scrivere. */
export default function DayDragBadge({ d, t, opName }) {
  const v = d.verdict;
  const tone = verdictTone(v);
  // durata, inizio e servizi che cambiano mano (uno stacco muove un servizio solo)
  const { detach, durMin, start, group, moving } = dragBadge(d);
  // Fuori dalla griglia il badge dice che cosa farà il rilascio, non un
  // orario e una colonna che non ci sono (vedi track).
  if (d.outside) {
    const dd = d.dayTarget ? parseISO(d.dayTarget) : null;
    const dayLbl = dd ? dayLabel(d.dayTarget, t) : '';
    const at = timeLabel(detach ? d.orig : start);
    return (
      <div className="dk-drag-badge" style={badgeSpot(d.cx, d.cy, window)}>
        <Icon name={dd ? 'calendar' : 'x'} size={14} color="#fff" stroke={2.6} />
        {dd
          ? <span>{detach ? t(`Stacca su ${dayLbl}, ${at}`, `Detach to ${dayLbl}, ${at}`) : t(`${dayLbl}, stesso orario (${at})`, `${dayLbl}, same time (${at})`)}</span>
          : <span>{t('Fuori dalla griglia: rilascia per annullare', 'Outside the grid: release to cancel')}</span>}
      </div>
    );
  }
  return (
    <div className={'dk-drag-badge' + (tone === 'warn' ? ' dk-drag-badge--warn' : '')} style={badgeSpot(d.cx, d.cy, window)}>
      <Icon name={tone === 'warn' ? 'alert' : 'check'} size={14} color="#fff" stroke={2.6} />
      <span className="tabnum">{timeLabel(start)}–{timeLabel(start + durMin)}</span>
      <span>· {opName(d.nop)}</span>
      {/* l'aggancio si deve vedere mentre si trascina, altrimenti sembra
          che la griglia abbia "sbagliato" lo scatto */}
      {d.snap && <small>· {t(`attaccato a ${d.snap.label}`, `snapped to ${d.snap.label}`)}</small>}
      {v && <small>· {v.label}</small>}
      {moving && d.nop !== d.origOp && <small>· {t(`${group} serviz${group === 1 ? 'io' : 'i'} di ${opName(d.origOp)}`, `${group} service${group === 1 ? '' : 's'} from ${opName(d.origOp)}`)}</small>}
    </div>
  );
}
