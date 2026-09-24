// OperatorChips — le chip «Calendari» della vista giorno: quali colonne si
// disegnano (vedi useOperatorVisibility), con «Tutte» / «Deseleziona».
import { Avatar, Icon } from '@youty/shared';
import { opDisplay } from '../lib.js';

export default function OperatorChips({ operators, vis, visCount, allOn, toggleVis, setAll, colorOf, t }) {
  const opFirsts = operators.map((o) => o.first_name); // disambiguazione omonimie nelle chip
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 26px', borderBottom: '1px solid var(--hair)', overflowX: 'auto' }}>
      <span className="t-meta" style={{ flexShrink: 0 }}>{t('Calendari', 'Calendars')}</span>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'nowrap' }}>
        {operators.map((o) => {
          const on = vis[o.id] !== false;
          const col = colorOf(o.id);
          return (
            <button key={o.id} onClick={() => toggleVis(o.id)} aria-pressed={on} title={`${o.first_name} ${o.last_name}`.trim() + (o.role_title ? ' · ' + o.role_title : '') + ' · ' + (on ? t('visibile', 'shown') : t('nascosta', 'hidden'))} className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : ' dk-pill--muted')} style={{ '--pill-c': col, padding: '4px 11px 4px 5px', flexShrink: 0 }}>
              <Avatar initials={o.initials} size={24} color={col} ring={on} />
              <span>{opDisplay(o.first_name, o.last_name, opFirsts)}</span>
              <Icon name={on ? 'check' : 'plus'} size={13} stroke={2.6} color={on ? 'var(--ink)' : 'var(--muted-2)'} />
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, minWidth: 8 }} />
      <span className="t-sm tabnum" style={{ color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>{visCount}/{operators.length}</span>
      <button className="dk-btn dk-btn--soft" style={{ height: 32, fontSize: 12.5, flexShrink: 0 }} onClick={() => setAll(!allOn)}>{allOn ? t('Deseleziona', 'Clear') : t('Tutte', 'All')}</button>
    </div>
  );
}
