// ServiziSub.jsx — catalogo servizi come lista compatta raggruppata per categoria.
// Una riga per servizio (nome, durata, prezzo, operatrici, stato): densità alta,
// scansione rapida, modifica al clic. Sostituisce le card grandi 3-per-riga.
import React, { useState } from 'react';
import { Icon, Toggle, fmtEur, fmtDur, EmptyState } from '@youty/shared';
import { GroupedFilterMenu } from '../../ui/index.js';
import { CategoryDot, OperatorAvatarStack, SearchToolbar } from './parts.jsx';

function catName(cat, lang) {
  if (!cat) return '';
  return lang === 'en' && cat.name_en ? cat.name_en : cat.name_it;
}
function svcName(s, lang) {
  return lang === 'en' && s.name_en ? s.name_en : s.name_it;
}
// the "other" language label, shown small next to the primary name
function svcNameAlt(s, lang) {
  return lang === 'en' ? s.name_it : s.name_en || '';
}

const COLS = 'minmax(180px, 1fr) 92px 82px 112px 108px 36px';

export default function ServiziSub({ services, loading, categories, operators, canEdit, onCats, onEdit, onNew, onToggleActive, t, lang }) {
  const [q, setQ] = useState('');
  const [catF, setCatF] = useState('all');
  const [statusF, setStatusF] = useState('all');
  const [collapsed, setCollapsed] = useState({});

  const opsFor = (serviceId) => operators.filter((o) => (o.service_ids || []).includes(serviceId));

  const filtered = services.filter((s) => {
    const okCat = catF === 'all' || catF === String(s.category_id);
    const okStatus = statusF === 'all' || (statusF === 'active' && s.active) || (statusF === 'paused' && !s.active);
    const okQ = !q || svcName(s, lang).toLowerCase().includes(q.toLowerCase()) || (svcNameAlt(s, lang) || '').toLowerCase().includes(q.toLowerCase());
    return okCat && okStatus && okQ;
  });

  const groups = [...categories]
    .sort((a, b) => a.order - b.order)
    .map((cat) => ({
      cat,
      items: filtered
        .filter((s) => s.category_id === cat.id)
        .sort((a, b) => a.order - b.order || svcName(a, lang).localeCompare(svcName(b, lang))),
    }))
    .filter((g) => g.items.length);
  const orphan = filtered.filter((s) => !categories.some((c) => c.id === s.category_id));
  if (orphan.length) groups.push({ cat: { id: 'none', name_it: t('Senza categoria', 'Uncategorised'), color: 'var(--muted-2)' }, items: orphan });

  const activeCount = services.filter((s) => s.active).length;

  if (loading) {
    return (
      <div className="dk-card" style={{ overflow: 'hidden' }}>
        {[...Array(8)].map((_, i) => <div key={i} className="skel" style={{ height: 46, borderRadius: 0, borderBottom: '1px solid var(--hair)' }} />)}
      </div>
    );
  }

  return (
    <React.Fragment>
      <SearchToolbar
        q={q} setQ={setQ} placeholder={t('Cerca un servizio…', 'Search a service…')}
        onAdd={onNew} addLabel={t('Nuovo servizio', 'New service')} canAdd={canEdit}
        extra={(
          <React.Fragment>
            <GroupedFilterMenu
              t={t}
              groups={[
                { label: t('Categoria', 'Category'), value: catF, set: setCatF, opts: [['all', t('Tutte', 'All')], ...categories.map((c) => [String(c.id), catName(c, lang)])] },
                { label: t('Stato', 'Status'), value: statusF, set: setStatusF, opts: [['all', t('Tutti', 'All')], ['active', t('Attivi', 'Active')], ['paused', t('In pausa', 'Paused')]] },
              ]}
            />
            <button className="dk-btn dk-btn--ghost" onClick={onCats} style={{ flexShrink: 0 }}>
              <Icon name="tag" size={16} />{t('Categorie', 'Categories')}
            </button>
          </React.Fragment>
        )}
      />

      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 10, display: 'flex', gap: 14 }}>
        <span><b style={{ color: 'var(--ink)' }}>{filtered.length}</b> {t('servizi', 'services')}{filtered.length !== services.length ? ` · ${t('su', 'of')} ${services.length}` : ''}</span>
        <span><b style={{ color: 'var(--ok)' }}>{activeCount}</b> {t('attivi', 'active')}</span>
        {services.length - activeCount > 0 && <span><b style={{ color: 'var(--muted)' }}>{services.length - activeCount}</b> {t('in pausa', 'paused')}</span>}
      </div>

      {groups.length === 0 ? (
        <div className="dk-card" style={{ padding: '12px 0' }}>
          <EmptyState icon="search" title={t('Nessun servizio', 'No services')} sub={t('Prova un altro filtro o termine di ricerca.', 'Try another filter or search term.')} />
        </div>
      ) : (
        <div className="dk-card" style={{ overflow: 'hidden', overflowX: 'auto' }}>
          {/* intestazione */}
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, alignItems: 'center', minWidth: 660, padding: '9px 16px', background: 'var(--surface-2)', borderBottom: '1px solid var(--hair)' }}>
            <span className="t-meta">{t('Servizio', 'Service')}</span>
            <span className="t-meta">{t('Durata', 'Duration')}</span>
            <span className="t-meta" style={{ textAlign: 'right' }}>{t('Prezzo', 'Price')}</span>
            <span className="t-meta">{t('Operatrici', 'Stylists')}</span>
            <span className="t-meta">{t('Stato', 'Status')}</span>
            <span />
          </div>

          {groups.map(({ cat, items }) => {
            const isCollapsed = !!collapsed[cat.id];
            return (
              <div key={cat.id}>
                <button
                  onClick={() => setCollapsed((m) => ({ ...m, [cat.id]: !m[cat.id] }))}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', minWidth: 660, padding: '8px 16px', background: `color-mix(in srgb, ${cat.color || 'var(--muted-2)'} 10%, var(--surface))`, borderTop: '1px solid var(--hair)', borderBottom: isCollapsed ? 'none' : '1px solid var(--hair)', textAlign: 'left', cursor: 'pointer' }}
                  aria-expanded={!isCollapsed}
                >
                  <CategoryDot color={cat.color} size={10} />
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{catName(cat, lang)}</span>
                  <span className="t-sm" style={{ color: 'var(--muted-2)' }}>· {items.length}</span>
                  <span style={{ flex: 1 }} />
                  <Icon name="chevD" size={14} color="var(--muted-2)" style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 140ms' }} />
                </button>
                {!isCollapsed && items.map((s) => {
                  const alt = svcNameAlt(s, lang);
                  const ops = opsFor(s.id);
                  return (
                    <div
                      key={s.id} className={canEdit ? 'dk-row' : ''} role={canEdit ? 'button' : undefined} tabIndex={canEdit ? 0 : undefined}
                      onClick={canEdit ? () => onEdit(s) : undefined}
                      onKeyDown={canEdit ? (e) => { if (e.key === 'Enter') onEdit(s); } : undefined}
                      style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, alignItems: 'center', minWidth: 660, padding: '8px 16px', minHeight: 46, borderTop: '1px solid var(--hair-2)', opacity: s.active ? 1 : 0.55, cursor: canEdit ? 'pointer' : 'default' }}
                    >
                      <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{svcName(s, lang)}</span>
                        {alt && <span className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{alt}</span>}
                      </div>
                      <span className="t-sm tabnum" style={{ color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>
                        {fmtDur(s.duration_min, lang)}
                        {s.soak_min > 0 && <span style={{ color: 'var(--muted-2)' }}> +{s.soak_min} {t('posa', 'soak')}</span>}
                      </span>
                      <span className="t-num" style={{ fontSize: 15, textAlign: 'right', fontWeight: 600 }}>{fmtEur(Number(s.price), lang)}</span>
                      <span title={ops.map((o) => `${o.first_name} ${o.last_name}`).join(', ')}>
                        {ops.length ? <OperatorAvatarStack ops={ops} max={5} size={24} /> : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--warn)' }}><Icon name="alert" size={12} color="var(--warn)" />{t('nessuna', 'none')}</span>}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                        {canEdit ? <Toggle on={s.active} onChange={(v) => onToggleActive(s, v)} /> : null}
                        <span className="t-sm" style={{ color: s.active ? 'var(--ok)' : 'var(--muted)', fontWeight: 600, fontSize: 12 }}>{s.active ? t('Attivo', 'Active') : t('In pausa', 'Paused')}</span>
                      </span>
                      <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        {canEdit && (
                          <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={(e) => { e.stopPropagation(); onEdit(s); }} aria-label={t('Modifica', 'Edit')}>
                            <Icon name="edit" size={13} />
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </React.Fragment>
  );
}
