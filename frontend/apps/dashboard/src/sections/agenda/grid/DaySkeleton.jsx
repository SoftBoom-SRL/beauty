// DaySkeleton — lo scheletro della vista giorno mentre la giornata carica:
// testate e colonne grigie, con lo spazio della colonna delle ore.
import { DAY_HOURS_W } from '../lib.js';

/* ---- day grid loading skeleton ---- */
export default function DaySkeleton() {
  return (
    <div style={{ flex: 1, overflow: 'hidden', padding: '14px 26px' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <div style={{ width: DAY_HOURS_W, flexShrink: 0 }} />
        {[...Array(5)].map((_, i) => <div key={i} className="skel" style={{ flex: 1, height: 54, borderRadius: 12 }} />)}
      </div>
      <div style={{ display: 'flex', gap: 6, height: '100%' }}>
        <div style={{ width: DAY_HOURS_W, flexShrink: 0 }} />
        {[...Array(5)].map((_, i) => <div key={i} className="skel" style={{ flex: 1, height: 520, borderRadius: 12 }} />)}
      </div>
    </div>
  );
}
