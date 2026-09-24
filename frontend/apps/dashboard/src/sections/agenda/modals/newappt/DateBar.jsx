// DateBar — in cima al drawer: il giorno (frecce e calendario, mai nel
// passato) e, se la prenotazione è partita da un clic in agenda,
// l'operatrice e l'ora richieste, con la «x» per toglierle.
import { Avatar, Icon, timeLabel, todayStr } from '@youty/shared';

export default function DateBar({ date, dateLabel, shiftDate, setDate, choose, req, reqOp, setReq, setShowAll, setItems, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
      <button type="button" className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={() => shiftDate(-1)} disabled={date <= todayStr()} aria-label={t('Giorno precedente', 'Previous day')}><Icon name="chevL" size={15} /></button>
      <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
        <span className="t-meta" style={{ fontSize: 9.5 }}>{t('Data', 'Date')}</span>
        <span style={{ fontWeight: 700, fontSize: 14, textTransform: 'capitalize', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dateLabel}</span>
        <input type="date" value={date} min={todayStr()} onChange={(e) => { if (e.target.value) { setDate(e.target.value); choose(null, null, false); } }} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      </label>
      <button type="button" className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={() => shiftDate(1)} aria-label={t('Giorno successivo', 'Next day')}><Icon name="chevR" size={15} /></button>
      {req && (req.startMin != null || reqOp) && (
        <span className="dk-pill dk-pill--on" style={{ gap: 6, padding: '5px 8px 5px 6px', cursor: 'default' }} title={t('Richiesta dall’agenda', 'Requested from the agenda')}>
          {reqOp && <Avatar initials={reqOp.initials} size={20} color={reqOp.color} />}
          {reqOp && <span>{reqOp.first_name}</span>}
          {req.startMin != null && <span className="tabnum">{timeLabel(req.startMin)}</span>}
          <button type="button" onClick={() => { setReq(null); setShowAll(true); setItems((l) => l.map((it) => ({ ...it, operator_id: null }))); }} aria-label={t('Rimuovi richiesta', 'Clear request')} style={{ display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: 99, background: 'rgba(255,255,255,0.2)', cursor: 'pointer' }}><Icon name="x" size={11} color="#fff" stroke={2.6} /></button>
        </span>
      )}
    </div>
  );
}
