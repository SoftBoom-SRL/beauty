// SvcEditModal.jsx — create / edit a service (POST/PUT /api/catalog/services)
// plus operator assignment, which lives on the OPERATOR side:
// toggling a stylist = PUT /api/staff/{operator_id} with updated service_ids.
import React, { useState, useEffect } from 'react';
import { Icon, Avatar, Toggle, fmtEur, NumInput } from '@youty/shared';
import { DkModal } from '../../ui/index.js';
import { FRow, PriceBox, DurationInput, CategoryDot } from './parts.jsx';

const CAT_SWATCHES = ['#FDE2E4', '#DBEAFE', '#DCFCE7', '#FEF3C7', '#FCE7F3', '#EDE9FE', '#E0E7FF', '#FEE2E2', '#E0F2FE', '#F1F5F9'];

function catName(cat, lang) {
  if (!cat) return '';
  return lang === 'en' && cat.name_en ? cat.name_en : cat.name_it;
}

export default function SvcEditModal({ service, categories, operators, canTeam, canPricing = true, onSave, onClose, onCats, onCatColor, t, lang }) {
  const isNew = !service?.id;
  const [draft, setDraft] = useState(() => ({
    name_it: service?.name_it || '',
    name_en: service?.name_en || '',
    description_it: service?.description_it || '',
    description_en: service?.description_en || '',
    category_id: service?.category_id || categories[0]?.id || null,
    duration_min: service?.duration_min || 45,
    soak_min: service?.soak_min ?? 0,
    price: service?.price != null ? String(service.price) : '40',
    product_cost: service?.product_cost != null ? String(service.product_cost) : '0',
    supplier_cost: service?.supplier_cost != null ? String(service.supplier_cost) : '0',
    active: service?.active ?? true,
    order: service?.order ?? 0,
  }));
  // operators currently enabled for this service (existing services only until saved)
  const [opIds, setOpIds] = useState(() =>
    isNew ? [] : operators.filter((o) => (o.service_ids || []).includes(service.id)).map((o) => o.id)
  );
  const [saving, setSaving] = useState(false);

  // #2 — colore della categoria selezionata, configurabile qui (resta legato alla categoria)
  const selCat = categories.find((c) => c.id === draft.category_id) || null;
  const [catColor, setCatColorLocal] = useState(selCat?.color || '#E0E7FF');
  useEffect(() => {
    const c = categories.find((x) => x.id === draft.category_id);
    setCatColorLocal(c?.color || '#E0E7FF');
  }, [draft.category_id, categories]);
  const commitCatColor = (hex) => { if (onCatColor && canPricing && selCat && hex && hex !== selCat.color) onCatColor(selCat.id, hex); };

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const toggleOp = (id) => setOpIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const canSave = draft.name_it.trim().length > 0 && draft.category_id != null && Number(draft.price) >= 0 && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(
        {
          category_id: draft.category_id,
          name_it: draft.name_it.trim(),
          name_en: draft.name_en.trim(),
          description_it: draft.description_it.trim().slice(0, 600),
          description_en: draft.description_en.trim().slice(0, 600),
          duration_min: Math.max(5, parseInt(draft.duration_min, 10) || 45),
          soak_min: Math.max(0, parseInt(draft.soak_min, 10) || 0),
          price: Number(draft.price || 0).toFixed(2),
          product_cost: Number(draft.product_cost || 0).toFixed(2),
          supplier_cost: Number(draft.supplier_cost || 0).toFixed(2),
          active: draft.active,
          order: draft.order,
        },
        opIds,
      );
    } finally {
      setSaving(false);
    }
  };

  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%' };

  return (
    <DkModal
      open onClose={onClose}
      title={isNew ? t('Nuovo servizio', 'New service') : t('Modifica servizio', 'Edit service')}
      sub={t('Nome, categoria, durata, prezzo e operatrici', 'Name, category, duration, price and stylists')}
      width={580}
      foot={(
        <React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
          <button className="dk-btn dk-btn--clay" disabled={!canSave} style={{ opacity: canSave ? 1 : 0.5 }} onClick={submit}>
            <Icon name="check" size={17} color="#fff" />{saving ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
          </button>
        </React.Fragment>
      )}
    >
      {/* bilingual name */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Nome (italiano)', 'Name (Italian)')} <span style={{ color: 'var(--clay)' }}>*</span></div>
          <input value={draft.name_it} onChange={(e) => set({ name_it: e.target.value })} placeholder={t('Es. Semipermanente', 'E.g. Semipermanente')} style={inputCss} />
        </div>
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Nome (inglese)', 'Name (English)')}</div>
          <input value={draft.name_en} onChange={(e) => set({ name_en: e.target.value })} placeholder={t('Es. Gel polish', 'E.g. Gel polish')} style={inputCss} />
        </div>
        {/* descrizione breve: compare nell'app cliente sotto il nome del servizio */}
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Descrizione (italiano)', 'Description (Italian)')} <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--muted-2)' }}>· {t('nell’app cliente', 'in the client app')}</span></div>
          <textarea value={draft.description_it} onChange={(e) => set({ description_it: e.target.value.slice(0, 600) })} rows={3} placeholder={t('Cosa include, per chi è, cosa aspettarsi…', 'What it includes, who it is for, what to expect…')} style={{ ...inputCss, resize: 'vertical', fontSize: 13.5, boxSizing: 'border-box' }} />
          <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'right', fontSize: 11 }}>{draft.description_it.length}/600</div>
        </div>
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Descrizione (inglese)', 'Description (English)')}</div>
          <textarea value={draft.description_en} onChange={(e) => set({ description_en: e.target.value.slice(0, 600) })} rows={3} placeholder={t('Facoltativa: se manca, l’app usa l’italiano', 'Optional: the app falls back to Italian')} style={{ ...inputCss, resize: 'vertical', fontSize: 13.5, boxSizing: 'border-box' }} />
        </div>
      </div>

      {/* category pills */}
      <div style={{ marginBottom: 8 }}>
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('Categoria', 'Category')}</div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
          {categories.map((c) => {
            const on = draft.category_id === c.id;
            return (
              <button
                key={c.id} type="button" onClick={() => set({ category_id: c.id })} aria-pressed={on}
                className={'dk-pill' + (on ? ' dk-pill--on' : '')} style={{ padding: '5px 12px', fontSize: 12.5 }}
              >
                <CategoryDot color={c.color} size={9} />{catName(c, lang)}
              </button>
            );
          })}
          {onCats && (
            <button onClick={onCats} title={t('Gestisci categorie', 'Manage categories')} style={{ width: 32, height: 32, borderRadius: 99, border: '1px dashed var(--hair)', background: 'var(--surface)', cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--clay-ink)', flexShrink: 0 }}>
              <Icon name="plus" size={15} color="var(--clay-ink)" />
            </button>
          )}
        </div>
      </div>

      {/* colore della categoria — configurabile qui invece che in Impostazioni */}
      {selCat && (
        <div style={{ marginBottom: 8, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CategoryDot color={catColor} size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t-ui" style={{ fontWeight: 600 }}>{t('Colore categoria', 'Category colour')}</div>
              <div className="t-sm" style={{ color: 'var(--muted-2)' }}>
                {t('Vale per tutti i servizi di', 'Applies to all services in')} “{catName(selCat, lang)}” · {t('anche nei blocchi agenda', 'agenda blocks too')}
              </div>
            </div>
            {onCatColor && canPricing ? (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 30, height: 30, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', border: '1px solid var(--hair)', background: catColor, flexShrink: 0 }}>
                  <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(catColor) ? catColor : '#E0E7FF'} onChange={(e) => setCatColorLocal(e.target.value)} onBlur={() => commitCatColor(catColor)} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                </label>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 8, padding: '5px 8px', background: 'var(--surface)' }}>
                  <span style={{ color: 'var(--muted-2)', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 12.5 }}>#</span>
                  <input value={String(catColor || '').replace('#', '').toUpperCase()} maxLength={6} placeholder="E0E7FF"
                    onChange={(e) => setCatColorLocal('#' + e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6))}
                    onBlur={() => commitCatColor('#' + String(catColor).replace('#', '').padEnd(6, '0').slice(0, 6))}
                    style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 12.5, width: 64, letterSpacing: '0.05em' }} />
                </span>
              </div>
            ) : (
              <span className="t-sm" style={{ color: 'var(--muted-2)', flexShrink: 0 }}>{t('richiede permesso prezzi', 'requires pricing permission')}</span>
            )}
          </div>
          {onCatColor && canPricing && (
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {CAT_SWATCHES.map((c) => {
                const on = String(catColor || '').toLowerCase() === c.toLowerCase();
                return <button key={c} type="button" onClick={() => { setCatColorLocal(c); commitCatColor(c); }} title={c} style={{ width: 22, height: 22, borderRadius: 6, background: c, cursor: 'pointer', border: '1px solid var(--hair)', outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1 }} />;
              })}
            </div>
          )}
        </div>
      )}

      <FRow label={t('Prezzo', 'Price')}>
        <PriceBox value={draft.price} onChange={(v) => set({ price: v })} />
      </FRow>
      <FRow label={t('Tempo attivo', 'Active time')} hint={t("Minuti in cui l'operatrice lavora sul cliente", 'Minutes the stylist actively works on the client')}>
        <DurationInput value={draft.duration_min} onChange={(v) => set({ duration_min: v })} />
      </FRow>
      <FRow label={t('Tempo di posa', 'Soak time')} hint={t('Posa/attesa finale, opzionale (0 = nessuna)', 'Final soak/wait, optional (0 = none)')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <DurationInput value={draft.soak_min} onChange={(v) => set({ soak_min: v })} min={0} />
          {(parseInt(draft.soak_min, 10) || 0) > 0 && (
            <span className="t-sm" style={{ color: 'var(--muted)' }}>
              {t('Totale per il cliente', 'Total for the client')}: <strong style={{ color: 'var(--ink)' }}>{(parseInt(draft.duration_min, 10) || 0) + (parseInt(draft.soak_min, 10) || 0)} min</strong>
            </span>
          )}
        </div>
      </FRow>
      <FRow label={t('Costo prodotti', 'Product cost')} hint={t('Materiali consumati per seduta', 'Materials used per session')}>
        <PriceBox value={draft.product_cost} onChange={(v) => set({ product_cost: v })} width={96} />
      </FRow>
      <FRow label={t('Costo fornitori', 'Supplier cost')} hint={t('Costi esterni per seduta', 'External costs per session')}>
        <PriceBox value={draft.supplier_cost} onChange={(v) => set({ supplier_cost: v })} width={96} />
      </FRow>
      <FRow label={t('Ordine', 'Order')} hint={t('Posizione nella lista', 'Position in the list')}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)', width: 92 }}>
          <NumInput integer min={0} value={draft.order} onChange={(order) => set({ order })} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 15, fontWeight: 600, width: '100%' }} />
        </div>
      </FRow>

      {/* operators */}
      <div style={{ padding: '12px 0', borderTop: '1px solid var(--hair)' }}>
        <div className="t-meta" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('Operatrici abilitate', 'Enabled stylists')}
          {!canTeam && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· {t('richiede permesso team', 'requires team permission')}</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {operators.map((o) => {
            const on = opIds.includes(o.id);
            return (
              <button
                key={o.id} type="button" onClick={canTeam ? () => toggleOp(o.id) : undefined} aria-disabled={!canTeam} aria-pressed={on}
                className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')} style={{ '--pill-c': o.color, padding: '5px 12px 5px 5px' }}
              >
                <Avatar initials={o.initials} size={24} color={o.color} ring={on} />
                <span>{o.first_name}</span>
                {on && <Icon name="check" size={13} stroke={2.6} />}
              </button>
            );
          })}
        </div>
      </div>

      <FRow label={t('Servizio attivo', 'Service active')} hint={draft.active ? t('Prenotabile', 'Bookable') : t('In pausa, non prenotabile', 'Paused, not bookable')}>
        <Toggle on={draft.active} onChange={(v) => set({ active: v })} />
      </FRow>

      {Number(draft.price) > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--surface-2)', borderRadius: 12, marginTop: 10 }}>
          <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Margine lordo stimato', 'Estimated gross margin')}</span>
          <span className="t-num" style={{ fontSize: 17 }}>
            {fmtEur(Math.max(0, Number(draft.price) - Number(draft.product_cost || 0) - Number(draft.supplier_cost || 0)), lang)}
          </span>
        </div>
      )}
    </DkModal>
  );
}
