// ServicesAssign.jsx — i servizi che l'operatrice può erogare, nella linguetta
// «Anagrafica» della scheda (StaffPage).
import { useRef, useState } from 'react';
import { Icon, NumInput, nameIn, apiErrorText } from '@youty/shared';
import { inputCss, svcLabel } from './lib.js';
import { servicesApi } from '../../api/catalog.js';

/* ================= Servizi abilitati: raggruppati per categoria + creazione inline =================
 * Non costringe a uscire dal profilo per creare un servizio mancante: "＋ Nuovo
 * servizio" apre un mini-form (nome, categoria, durata, prezzo) → POST
 * /api/catalog/services → il servizio appare già selezionato per l'operatrice.
 * Richiede il permesso "prezzi" (pricing) per creare; "team" per assegnare. */
export default function ServicesAssign({ services, categories, selected, onToggle, onBulk, canTeam, canPricing, onCreated, t, lang, fireToast }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name_it: '', category_id: null, duration_min: '45', price: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const nameRef = useRef(null);

  const active = services.filter((s) => s.active !== false);
  const match = (s) => !q || svcLabel(s, lang).toLowerCase().includes(q.toLowerCase());
  const groups = [...(categories || [])].sort((a, b) => a.order - b.order)
    .map((c) => ({ cat: c, items: active.filter((s) => s.category_id === c.id && match(s)) }))
    .filter((g) => g.items.length);
  const orphan = active.filter((s) => !(categories || []).some((c) => c.id === s.category_id) && match(s));
  if (orphan.length) groups.push({ cat: { id: 'none', name_it: t('Altro', 'Other'), name_en: 'Other', color: 'var(--muted-2)' }, items: orphan });
  const catLabel = (c) => nameIn(c, lang);

  const openCreate = (catId) => {
    setDraft({ name_it: q.trim(), category_id: catId ?? categories?.[0]?.id ?? null, duration_min: '45', price: '' });
    setErr(''); setCreating(true);
    requestAnimationFrame(() => nameRef.current?.focus());
  };
  const create = async () => {
    const name = draft.name_it.trim();
    if (!name) { setErr(t('Il nome è obbligatorio', 'Name is required')); return; }
    if (!draft.category_id) { setErr(t('Scegli una categoria', 'Pick a category')); return; }
    setSaving(true); setErr('');
    try {
      const svc = await servicesApi.create({
        category_id: draft.category_id, name_it: name, name_en: '',
        duration_min: Math.max(5, parseInt(draft.duration_min, 10) || 45),
        price: Number(draft.price || 0).toFixed(2), active: true, order: 0,
      });
      const outcome = await onCreated(svc);
      fireToast(outcome === 'enabled'
        ? { msg: t(`Servizio creato e abilitato: ${name}`, `Service created and enabled: ${name}`), icon: 'check' }
        : outcome === 'pending'
          ? { msg: t(`Servizio creato: premi «Salva» per abilitarlo a questa operatrice`, `Service created: press “Save” to enable it for this stylist`), icon: 'info' }
          : { msg: t(`Servizio creato: ${name}. Per abilitarlo all’operatrice serve il permesso “team”.`, `Service created: ${name}. Enabling it for the stylist requires the “team” permission.`), icon: 'check' });
      setCreating(false); setQ('');
    } catch (e) {
      setErr(apiErrorText(e, t));
    } finally { setSaving(false); }
  };

  const total = active.length, on = active.filter((s) => selected.includes(s.id)).length;
  const inputSm = { ...inputCss, padding: '8px 10px', fontSize: 13.5 };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <div>
          <div className="t-meta">{t('Servizi abilitati', 'Enabled services')} <span style={{ color: 'var(--ink)', letterSpacing: 0 }}>· {on}/{total}</span></div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>{t('Cosa può erogare: determina cosa è prenotabile sulla sua colonna in agenda.', 'What she can perform: it drives what is bookable on her column in the calendar.')}</div>
        </div>
        <div style={{ flex: 1 }} />
        {active.length > 8 && (
          <div className="dk-search" style={{ width: 200, height: 36 }}>
            <Icon name="search" size={15} color="var(--muted-2)" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Filtra servizi…', 'Filter services…')} style={{ fontSize: 13 }} />
          </div>
        )}
        {canTeam && (
          <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 12px' }} onClick={() => onBulk(active.map((s) => s.id), on < total)}>
            {on < total ? t('Seleziona tutti', 'Select all') : t('Deseleziona tutti', 'Clear all')}
          </button>
        )}
      </div>

      {creating && (
        <div style={{ border: '1.5px solid var(--clay)', borderRadius: 12, padding: 12, margin: '10px 0 12px', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center' }}><Icon name="scissors" size={15} color="var(--clay-ink)" /></div>
            <div style={{ flex: 1, fontWeight: 700, fontSize: 13.5 }}>{t('Nuovo servizio', 'New service')} {canTeam && <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 500 }}>· {t('verrà subito abilitato per questa operatrice', 'it will be enabled for this stylist right away')}</span>}</div>
            <button type="button" className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => setCreating(false)} aria-label={t('Annulla', 'Cancel')}><Icon name="x" size={14} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.4fr 0.8fr 0.8fr', gap: 8, marginBottom: 8 }}>
            <input ref={nameRef} autoFocus value={draft.name_it} onChange={(e) => setDraft((d) => ({ ...d, name_it: e.target.value }))} placeholder={t('Nome servizio *', 'Service name *')} style={inputSm} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <select value={draft.category_id ?? ''} onChange={(e) => setDraft((d) => ({ ...d, category_id: Number(e.target.value) || null }))} style={{ ...inputSm, cursor: 'pointer' }}>
              <option value="">{t('Categoria *', 'Category *')}</option>
              {(categories || []).map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...inputSm, padding: '0 10px' }}>
              <NumInput integer min={5} value={draft.duration_min} onChange={(v) => setDraft((d) => ({ ...d, duration_min: v }))} style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', fontSize: 13.5, fontWeight: 600 }} />
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>min</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...inputSm, padding: '0 10px' }}>
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>€</span>
              <NumInput min={0} value={draft.price} onChange={(v) => setDraft((d) => ({ ...d, price: v }))} style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', fontSize: 13.5, fontWeight: 600 }} />
            </div>
          </div>
          {err && <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--danger)', marginBottom: 8 }}><Icon name="alert" size={14} color="var(--danger)" />{err}</div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="t-sm" style={{ color: 'var(--muted-2)', flex: 1 }}>{t('Nome inglese, posa e costi si completano in Servizi.', 'English name, soak and costs can be completed in Services.')}</span>
            <button type="button" className="dk-btn dk-btn--clay" style={{ height: 36, fontSize: 13 }} onClick={create} disabled={saving}>
              <Icon name="check" size={15} color="#fff" />{saving ? t('Creazione…', 'Creating…') : canTeam ? t('Crea e abilita', 'Create & enable') : t('Crea servizio', 'Create service')}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
        {groups.map(({ cat, items }) => {
          const ids = items.map((s) => s.id);
          const allOn = ids.every((id) => selected.includes(id));
          return (
            <div key={cat.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: cat.color || 'var(--muted-2)' }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-2)' }}>{catLabel(cat)}</span>
                <span className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 12 }}>· {ids.filter((id) => selected.includes(id)).length}/{ids.length}</span>
                {canTeam && <button type="button" onClick={() => onBulk(ids, !allOn)} style={{ fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', marginLeft: 4 }}>{allOn ? t('nessuno', 'none') : t('tutti', 'all')}</button>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {items.map((s) => {
                  const isOn = selected.includes(s.id);
                  return (
                    <button key={s.id} type="button" onClick={() => onToggle(s.id)} aria-pressed={isOn} aria-disabled={!canTeam} className={'dk-pill' + (isOn ? ' dk-pill--on' : '')} style={{ padding: '5px 11px', fontSize: 12.5 }} title={`${s.duration_min} min · € ${Number(s.price).toFixed(2)}`}>
                      {svcLabel(s, lang)}<Icon name={isOn ? 'check' : 'plus'} size={12} stroke={2.6} color={isOn ? '#fff' : 'var(--muted-2)'} />
                    </button>
                  );
                })}
                {canPricing && !creating && cat.id !== 'none' && (
                  <button type="button" onClick={() => openCreate(cat.id)} className="dk-pill" style={{ padding: '5px 11px', fontSize: 12.5, borderStyle: 'dashed', color: 'var(--clay-ink)' }} title={t('Crea un servizio in questa categoria', 'Create a service in this category')}>
                    <Icon name="plus" size={12} stroke={2.6} color="var(--clay-ink)" />{t('Nuovo', 'New')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!groups.length && (
          <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{q ? t('Nessun servizio corrisponde al filtro.', 'No service matches the filter.') : t('Nessun servizio attivo nel catalogo.', 'No active service in the catalog.')}</div>
        )}
        {canPricing && !creating && (
          <button type="button" onClick={() => openCreate(null)} className="dk-btn dk-btn--ghost" style={{ alignSelf: 'flex-start', height: 36, fontSize: 13, borderStyle: 'dashed' }}>
            <Icon name="plus" size={15} />{q ? t(`Crea “${q.trim()}”`, `Create “${q.trim()}”`) : t('Nuovo servizio', 'New service')}
          </button>
        )}
        {!canPricing && canTeam && (
          <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Per creare un servizio nuovo serve il permesso “prezzi”.', 'Creating a new service requires the “pricing” permission.')}</div>
        )}
      </div>
    </div>
  );
}
