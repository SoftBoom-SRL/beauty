// SvcEditModal.jsx — create / edit a service (POST/PUT /api/catalog/services)
// plus operator assignment, which lives on the OPERATOR side:
// toggling a stylist = PUT /api/staff/{operator_id} with updated service_ids.
import React, { useState, useEffect } from 'react';
import { Icon, Avatar, Toggle, fmtEur, NumInput, nameIn } from '@youty/shared';
import { DkModal, DkSeg } from '../../ui/index.js';
import { FRow, PriceBox, DurationInput, CategoryDot } from './parts.jsx';
import SwatchRows from '../../ui/SwatchRows.jsx';
import HexInput from '../../ui/HexInput.jsx';
import ColorWheel from '../../ui/ColorWheel.jsx';
import { TREATMENT_SWATCHES } from '../../ui/palette.js';
import { pillVars } from '../../ui/colorTools.js';


const catName = (cat, lang) => (cat ? nameIn(cat, lang) : '');

export default function SvcEditModal({ service, categories, operators, canTeam, canPricing = true, onSave, onArchive = null, onRestore = null, onClose, onCats, onCatColor, t, lang }) {
  const isNew = !service?.id;
  // archiviato: fuori dalla lista e in pausa; riattivandolo e salvando esce dall'archivio
  const archived = !isNew && !!service.archived_at;
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
    // "" = il colore della categoria; "#RRGGBB" = uno solo di questo servizio
    color: service?.color || '',
    // aggiuntivo: si fa durante un altro servizio (nail art durante la manicure)
    is_addon: !!service?.is_addon,
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
  // Colore suo o della categoria. Passando a «Personalizzato» si parte dal
  // colore della categoria, così il blocco non cambia finché non se ne sceglie
  // un altro; tornando a «Della categoria» il colore suo si toglie.
  const ownColor = !!draft.color;
  const pickColorMode = (mode) => {
    if (mode === 'category') return set({ color: '' });
    if (!ownColor) set({ color: /^#[0-9a-fA-F]{6}$/.test(catColor) ? catColor.toUpperCase() : TREATMENT_SWATCHES[0].colors[0] });
  };

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
          color: draft.color,
          is_addon: draft.is_addon,
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
      sub={t('Nome, categoria, colore, durata, prezzo, aggiuntivo e operatrici', 'Name, category, colour, duration, price, add-on and stylists')}
      width={580}
      foot={(
        <React.Fragment>
          {!isNew && !archived && onArchive && (
            <button data-archive className="dk-btn dk-btn--ghost" style={{ marginRight: 'auto' }} onClick={onArchive}
              title={t('Non lo fai più: esce dalla lista e non si prenota, resta nelle visite passate', 'You no longer offer it: it leaves the list and cannot be booked, it stays in past visits')}>
              <Icon name="archive" size={15} />{t('Archivia', 'Archive')}
            </button>
          )}
          <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
          <button className="dk-btn dk-btn--clay" disabled={!canSave} style={{ opacity: canSave ? 1 : 0.5 }} onClick={submit}>
            <Icon name="check" size={17} color="#fff" />{saving ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
          </button>
        </React.Fragment>
      )}
    >
      {archived && (
        <div data-archived-banner style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 14, borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--hair)' }}>
          <Icon name="archive" size={18} color="var(--muted)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t('Servizio archiviato', 'Archived service')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 12 }}>{t('Fuori dalla lista e non prenotabile; resta nelle visite passate e nei pacchetti.', 'Not listed and not bookable; it stays in past visits and packages.')}</div>
          </div>
          {onRestore && (
            <button data-restore className="dk-btn dk-btn--soft" style={{ flexShrink: 0 }} onClick={onRestore}>
              <Icon name="undo" size={14} />{t('Ripristina', 'Restore')}
            </button>
          )}
        </div>
      )}
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

      {/* Il colore in agenda: quello della categoria (configurabile qui
          invece che in Impostazioni, vale per tutti i suoi servizi) o uno solo
          di questo servizio. 15/10: dentro la stessa categoria i servizi erano
          tutti dello stesso colore e in agenda non si distinguevano. */}
      {selCat && (
        <div style={{ marginBottom: 8, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <div className="t-ui" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{t('Colore in agenda', 'Colour in the agenda')}</div>
            <DkSeg value={ownColor ? 'own' : 'category'} onChange={pickColorMode}
              options={[{ value: 'category', label: t('Della categoria', 'Category colour') }, { value: 'own', label: t('Personalizzato', 'Custom') }]} />
          </div>
          {ownColor ? (
            <React.Fragment>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CategoryDot color={draft.color} size={16} />
                <div className="t-sm" style={{ flex: 1, minWidth: 0, color: 'var(--muted-2)' }}>
                  {t('Solo per questo servizio: gli altri di', 'Only for this service: the others in')} “{catName(selCat, lang)}” {t('restano col colore della categoria', 'keep the category colour')}
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <HexInput value={draft.color} onChange={(c) => set({ color: c })} width={64} />
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                <SwatchRows value={draft.color} onChange={(c) => set({ color: c })} t={t} />
              </div>
              {/* qualsiasi sfumatura, senza conoscerne il codice */}
              <div style={{ marginTop: 12 }}>
                <ColorWheel value={draft.color} onChange={(c) => set({ color: c })} t={t} />
              </div>
            </React.Fragment>
          ) : (
            <React.Fragment>
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
              {/* vivaci, scure e tenui: le sole pastello si confondevano in agenda */}
              {onCatColor && canPricing && (
                <div style={{ marginTop: 10 }}>
                  <SwatchRows value={catColor} onChange={(c) => { setCatColorLocal(c); commitCatColor(c); }} t={t} />
                  {/* la ruota salva sulla categoria a gesto finito, non a ogni movimento */}
                  <div style={{ marginTop: 12 }}>
                    <ColorWheel value={catColor} onChange={setCatColorLocal} onCommit={commitCatColor} t={t} />
                  </div>
                </div>
              )}
            </React.Fragment>
          )}
        </div>
      )}

      <FRow label={t('Prezzo', 'Price')}>
        <PriceBox value={draft.price} onChange={(v) => set({ price: v })} />
      </FRow>
      {/* Aggiuntivo: nail art, scrub, rimozione del gel durante la manicure.
          In agenda va sotto il servizio durante il quale si fa, col suo
          prezzo, senza allungare l'appuntamento; da solo non si prenota. */}
      <FRow label={t('Aggiuntivo', 'Add-on')} hint={t('Si fa durante un altro servizio: aggiunge il prezzo, non il tempo', 'Done during another service: adds the price, not the time')}>
        <Toggle on={draft.is_addon} onChange={(v) => set({ is_addon: v })} />
      </FRow>
      <FRow
        label={draft.is_addon ? t('Durata indicativa', 'Indicative duration') : t('Tempo attivo', 'Active time')}
        hint={draft.is_addon
          ? t('Solo di riferimento: in agenda l’aggiuntivo non occupa tempo', 'For reference only: in the agenda the add-on takes no time')
          : t("Minuti in cui l'operatrice lavora sul cliente", 'Minutes the stylist actively works on the client')}
      >
        <DurationInput value={draft.duration_min} onChange={(v) => set({ duration_min: v })} />
      </FRow>
      {/* la posa non c'è, per un aggiuntivo: si fa dentro il tempo di un altro */}
      {!draft.is_addon && (
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
      )}
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
                className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')} style={{ ...pillVars(o.color), padding: '5px 12px 5px 5px' }}
              >
                <Avatar initials={o.initials} size={24} color={o.color} ring={on} />
                <span>{o.first_name}</span>
                {on && <Icon name="check" size={13} stroke={2.6} />}
              </button>
            );
          })}
        </div>
      </div>

      <FRow label={t('Servizio attivo', 'Service active')} hint={draft.active
        ? (archived ? t('Prenotabile: salvando esce dall’archivio', 'Bookable: saving takes it out of the archive') : t('Prenotabile', 'Bookable'))
        : (archived ? t('Archiviato, non prenotabile', 'Archived, not bookable') : t('In pausa, non prenotabile', 'Paused, not bookable'))}>
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
