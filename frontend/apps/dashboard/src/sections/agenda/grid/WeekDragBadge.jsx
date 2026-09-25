// WeekDragBadge — il badge che segue il puntatore durante un trascinamento in
// vista settimana: giorno, operatrice e orario d'arrivo, e l'aggancio al
// vicino. Senza hook: nei test fa parte di WeekView.
import { Icon, parseISO, timeLabel } from '@youty/shared';
import { DOW_EN, DOW_IT } from '../lib.js';
import { badgeSpot } from '../lib/drag.js';

/** `dg` = il trascinamento in corso, `movingObj` = il blocco già nel giorno,
 *  nell'operatrice e all'orario d'arrivo (movingBlock). */
export default function WeekDragBadge({ dg, dayData, operators, movingObj, t }) {
  const day = dayData[dg.dayIdx];
  const op = operators.find((o) => o.id === dg.nop);
  return (
    <div className="dk-drag-badge" style={badgeSpot(dg.cx, dg.cy, window)}>
      <Icon name="calendar" size={14} color="#fff" stroke={2.4} />
      {day && <span>{t(DOW_IT[dg.dayIdx], DOW_EN[dg.dayIdx])} {parseISO(day.date).getDate()}</span>}
      {op && <span>· {op.first_name}</span>}
      <span className="tabnum">· {timeLabel(movingObj.startMin)}–{timeLabel(movingObj.endMin)}</span>
      {dg.snap && <small>· {t(`attaccato a ${dg.snap.label}`, `snapped to ${dg.snap.label}`)}</small>}
    </div>
  );
}
