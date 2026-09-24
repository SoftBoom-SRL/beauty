// JumpTitle — il titolo della barra (mese e anno in vista giorno, il periodo
// in settimana e nel mese): il clic apre il selettore di mese e data
// (JumpPopover). In vista giorno (`compact`) è più piccolo, per lasciare
// posto alla striscia dei giorni. Non va mai a capo: la barra è una riga sola.
import { Icon } from '@youty/shared';
import JumpPopover from './JumpPopover.jsx';

/** `cur` = il giorno a video (Date); `MONTHS` = i nomi dei mesi nella lingua
 *  dell'interfaccia; `onMonth(m, y)` / `onDate(iso)` = i salti; `short` = il
 *  titolo abbreviato per la barra stretta. */
export default function JumpTitle({ label, short, compact = false, open, setOpen, t, MONTHS, cur, onMonth, onDate }) {
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} title={t('Vai a un mese o a una data', 'Go to a month or a date')}
        className="dk-agbtn dk-agbtn--quiet" style={{ gap: 5, padding: '0 8px', fontFamily: 'var(--serif)', fontSize: compact ? 16 : 17, fontWeight: 650, letterSpacing: '-0.01em' }}>
        {short ? <><span className="dk-ag-t2">{label}</span><span className="dk-ag-t2only">{short}</span></> : label}
        <Icon name="chevD" size={14} color="var(--muted)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
      </button>
      {open && <JumpPopover t={t} MONTHS={MONTHS} curM={cur.getMonth()} curY={cur.getFullYear()} onClose={() => setOpen(false)} onMonth={onMonth} onDate={onDate} />}
    </div>
  );
}
