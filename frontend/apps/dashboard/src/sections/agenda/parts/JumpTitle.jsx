// JumpTitle — il titolo della barra (mese e anno in vista giorno, il periodo
// in settimana e nel mese): il clic apre il selettore di mese e data
// (JumpPopover). In vista giorno (`compact`) è più piccolo e non va a capo,
// per lasciare posto alla striscia dei giorni.
import { Icon } from '@youty/shared';
import JumpPopover from './JumpPopover.jsx';

/** `cur` = il giorno a video (Date); `MONTHS` = i nomi dei mesi nella lingua
 *  dell'interfaccia; `onMonth(m, y)` / `onDate(iso)` = i salti. */
export default function JumpTitle({ label, compact = false, open, setOpen, t, MONTHS, cur, onMonth, onDate }) {
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--serif)', fontSize: compact ? 19 : 21, fontWeight: 500, color: 'var(--ink)', ...(compact ? { whiteSpace: 'nowrap' } : {}) }}>
        {label}
        <Icon name="chevD" size={compact ? 15 : 16} color="var(--muted)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
      </button>
      {open && <JumpPopover t={t} MONTHS={MONTHS} curM={cur.getMonth()} curY={cur.getFullYear()} onClose={() => setOpen(false)} onMonth={onMonth} onDate={onDate} />}
    </div>
  );
}
