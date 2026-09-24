// ProfileLabels.jsx — le etichette della scheda cliente (le categorie clienti
// del catalogo, PUT category_ids) e il menu per metterle e toglierle.
// Ogni clic calcola category_ids al momento dell'invio (updateClient con una
// funzione): due clic ravvicinati si sommano invece di annullarsi.
import React, { useState } from 'react';
import { Icon } from '@youty/shared';
import { CatChip } from './components.jsx';

const catIdsOf = (cl) => (cl?.categories || []).map((x) => x.id);

export default function ProfileLabels({ c, canWrite, clientCategories, updateClient, openModal, t }) {
  const [labelPick, setLabelPick] = useState(false);
  const assignedIds = catIdsOf(c);   // solo per il segno di spunta a video
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', position: 'relative', margin: '-6px 0 20px' }}>
      {(c.categories || []).map((cat) => (
        <CatChip key={cat.id} cat={cat}
          onRemove={canWrite ? () => updateClient((prev) => ({ category_ids: catIdsOf(prev).filter((x) => x !== cat.id) }), { msg: t('Etichetta rimossa', 'Label removed'), icon: 'check' }) : null}
          removeTitle={t('Rimuovi etichetta', 'Remove label')} />
      ))}
      {canWrite && (
        <button onClick={() => setLabelPick((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', border: '1px dashed var(--line-strong)', background: 'transparent', padding: '4px 10px', borderRadius: 99, cursor: 'pointer' }}>
          <Icon name="plus" size={11} color="var(--muted)" />{t('etichetta', 'label')}
        </button>
      )}
      {labelPick && (
        <React.Fragment>
          <div onClick={() => setLabelPick(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
          <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 51, width: 250, padding: 6, boxShadow: 'var(--sh-pop)' }}>
            <div className="t-meta" style={{ padding: '6px 9px 7px' }}>{t('Etichette cliente', 'Client labels')}</div>
            <div style={{ maxHeight: 250, overflowY: 'auto' }}>
              {clientCategories.map((cat) => {
                const on = assignedIds.includes(cat.id);
                return (
                  <button key={cat.id} className="dk-row" style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left', border: 'none', background: 'transparent' }}
                    onClick={() => updateClient((prev) => {
                      // le etichette assegnate si rileggono al momento dell'invio:
                      // due clic ravvicinati devono sommarsi, non annullarsi
                      const ids = catIdsOf(prev);
                      return { category_ids: ids.includes(cat.id) ? ids.filter((x) => x !== cat.id) : [...ids, cat.id] };
                    })}>
                    <span style={{ width: 11, height: 11, borderRadius: 99, background: cat.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{cat.name}</span>
                    {on && <Icon name="check" size={14} color="var(--clay-ink)" stroke={2.4} />}
                  </button>
                );
              })}
            </div>
            <div style={{ borderTop: '1px solid var(--hair)', marginTop: 5, paddingTop: 5 }}>
              <button className="dk-row" onClick={() => { setLabelPick(false); openModal('catsmgr', { scope: 'clienti' }); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left', color: 'var(--clay-ink)', fontWeight: 600, fontSize: 12.5, border: 'none', background: 'transparent' }}>
                <Icon name="settings" size={14} color="var(--clay-ink)" />{t('Gestisci catalogo', 'Manage catalogue')}<Icon name="chevR" size={13} color="var(--clay-ink)" style={{ marginLeft: 'auto' }} />
              </button>
            </div>
          </div>
        </React.Fragment>
      )}
    </div>
  );
}
