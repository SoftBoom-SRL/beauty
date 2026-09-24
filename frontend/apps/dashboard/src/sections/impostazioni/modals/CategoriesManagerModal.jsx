// CategoriesManagerModal.jsx — port of CategoriesManager/CatEditModal (drawer UI)
// over the three real category APIs. Opened with openModal('catsmgr', { kind }).
//   clienti   → /api/clients/categories      {name, color, order}      (write: scope clients)
//   servizi   → /api/catalog/categories      {name_it, name_en, color, order} (write: scope pricing)
//   magazzino → /api/inventory/categories    {name, order}             (write: scope inventory)
// Riordino con trascinamento: dove esiste la rotta dedicata (solo catalog) si
// manda un solo POST /reorder con la lista di id — atomico e con una sola voce
// «category.reordered» nel registro attività. Clienti e magazzino non ce
// l'hanno e restano con una PUT per categoria.
import React, { useCallback, useEffect, useState } from 'react';
import { Icon, EmptyState, nameIn, toastApiError } from '@youty/shared';
import DkDrawer from '../../../ui/DkDrawer.jsx';
import DkConfirm from '../../../ui/DkConfirm.jsx';
import { useDash } from '../../../ctx.jsx';
import { GD_PALETTE } from '../../../ui/palette.js';
import { LockNote } from '../lib.jsx';
import { serviceCategoriesApi } from '../../../api/catalog.js';
import { clientCategoriesApi, clientsApi } from '../../../api/clients.js';
import { productCategoriesApi, productsApi } from '../../../api/inventory.js';
import CatEditModal from './CatEditModal.jsx';

const KINDS = {
  clienti: { endpoints: clientCategoriesApi, scope: 'clients', hasColor: true, bilingual: false },
  servizi: { endpoints: serviceCategoriesApi, scope: 'pricing', hasColor: true, bilingual: true, reorder: true },
  magazzino: { endpoints: productCategoriesApi, scope: 'inventory', hasColor: false, bilingual: false },
};
const flatPalette = GD_PALETTE.flat().filter((c) => !['#000000', '#FFFFFF', '#F3F3F3', '#EFEFEF'].includes(c));
const randColor = () => flatPalette[Math.floor(Math.random() * flatPalette.length)];
const catName = (c, kind, lang) => (KINDS[kind].bilingual ? nameIn(c, lang) : c.name);

// La scheda iniziale arriva come `kind` (Impostazioni, Servizi) o come `scope`
// (la scheda cliente): valgono entrambe.
export default function CategoriesManagerModal({ onClose, kind: kindProp, scope: scopeProp }) {
  const { t, lang, hasScope, reload, fireToast, services } = useDash();
  const initialKind = kindProp ?? scopeProp;
  const [kind, setKind] = useState(initialKind && KINDS[initialKind] ? initialKind : 'clienti');
  const [lists, setLists] = useState({ clienti: null, servizi: null, magazzino: null });
  const [dragIdx, setDragIdx] = useState(null);
  const [edit, setEdit] = useState(null); // draft { _new?, id?, name/name_it/name_en, color }
  const cfg = KINDS[kind];
  const list = lists[kind];
  const canWrite = hasScope(cfg.scope);

  const setList = (k, v) => setLists((s) => ({ ...s, [k]: v }));

  const load = useCallback(async (k) => {
    try { const res = await KINDS[k].endpoints.list(); setLists((s) => ({ ...s, [k]: res })); }
    catch (err) { toastApiError(err, fireToast, t); setLists((s) => ({ ...s, [k]: [] })); }
  }, [fireToast, t]);
  useEffect(() => { if (lists[kind] === null) load(kind); }, [kind, lists, load]);

  const syncCtx = (k) => {
    if (k === 'clienti') reload.clientCategories();
    if (k === 'servizi') reload.serviceCategories();
  };

  const payloadOf = (d) => {
    if (kind === 'servizi') return { name_it: (d.name_it || '').trim(), name_en: (d.name_en || '').trim(), color: d.color || '#CCCCCC' };
    if (kind === 'clienti') return { name: (d.name || '').trim(), color: d.color || '#CCCCCC' };
    return { name: (d.name || '').trim() };
  };

  // doppio clic su «Salva» = due categorie identiche (15-20)
  const [saving, setSaving] = useState(false);
  const save = async (d) => {
    if (saving) return;
    setSaving(true);
    try {
      let renamed = false;
      if (d._new) {
        const created = await cfg.endpoints.create({ ...payloadOf(d), order: (list || []).length });
        setList(kind, [...(list || []), created]);
      } else {
        const before = (list || []).find((c) => c.id === d.id);
        const upd = await cfg.endpoints.update(d.id, { ...payloadOf(d), order: d.order ?? 0 });
        setList(kind, list.map((c) => (c.id === d.id ? upd : c)));
        renamed = kind === 'clienti' && !!before && before.name !== upd.name;
      }
      syncCtx(kind);
      setEdit(null);
      /* Le condizioni di regole caparra e automazioni citano l'etichetta per
       * nome: al rinomina il server le riscrive, e le viste aperte si
       * ricaricano dal feed live (client_category.updated). */
      fireToast({
        msg: renamed
          ? t('Etichetta rinominata: regole caparra e automazioni che la usano sono aggiornate', 'Label renamed: deposit rules and automations using it are updated')
          : t('Categoria salvata', 'Category saved'),
        icon: 'check',
      });
    } catch (err) { toastApiError(err, fireToast, t); } // 400: nome già usato (anche con maiuscole diverse)
    finally { setSaving(false); }
  };

  /* Eliminare partiva al primo clic sulla «x» rossa accanto alla matita: «VIP»
   * spariva da trecento schede cliente, una categoria magazzino dai suoi
   * prodotti (15-08). Ora si chiede, dicendo quante schede la perdono. */
  const [confirmDel, setConfirmDel] = useState(null); // { cat, kind, count: n|null }
  const [deleting, setDeleting] = useState(false);
  const askDelete = async (cat) => {
    const k = kind;
    setConfirmDel({ cat, kind: k, count: null });
    let count;
    try {
      if (k === 'clienti') count = (await clientsApi.list({ category_id: cat.id, limit: 1 }))?.count;
      else if (k === 'magazzino') count = (await productsApi.list({ category_id: cat.id, include_inactive: true, limit: 1 }))?.count;
      else count = (services || []).filter((sv) => sv.category_id === cat.id).length;
    } catch { count = undefined; }
    setConfirmDel((c) => (c && c.cat.id === cat.id ? { ...c, count: Number.isFinite(count) ? count : -1 } : c));
  };
  const del = async () => {
    const c = confirmDel;
    if (!c || deleting) return;
    setDeleting(true);
    try {
      await KINDS[c.kind].endpoints.remove(c.cat.id);
      setList(c.kind, (lists[c.kind] || []).filter((x) => x.id !== c.cat.id));
      syncCtx(c.kind);
      setEdit(null);
      fireToast({ msg: t('Categoria eliminata', 'Category deleted'), icon: 'x' });
    } catch (err) {
      // 400 con il motivo: servizi collegati, o etichetta citata da una regola
      // caparra o da un'automazione (il messaggio le nomina)
      toastApiError(err, fireToast, t);
    } finally {
      setDeleting(false);
      setConfirmDel(null);
    }
  };
  const delDetail = () => {
    const c = confirmDel;
    if (!c) return '';
    if (c.count === null) return t('Controllo dove è usata…', 'Checking where it is used…');
    if (c.kind === 'clienti') {
      if (c.count < 0) return t('L’etichetta verrà tolta da tutte le schede cliente che la hanno.', 'The label will be removed from every client profile that has it.');
      return c.count
        ? t(`${c.count === 1 ? '1 cliente la ha' : c.count + ' clienti la hanno'}: l’etichetta verrà tolta da ${c.count === 1 ? 'quella scheda' : 'tutte quelle schede'}.`, `${c.count === 1 ? '1 client has' : c.count + ' clients have'} it: the label will be removed from ${c.count === 1 ? 'that profile' : 'all of them'}.`)
        : t('Nessuna scheda cliente ha questa etichetta.', 'No client profile has this label.');
    }
    if (c.kind === 'magazzino') {
      if (c.count < 0) return t('I prodotti di questa categoria resteranno senza categoria.', 'Products in this category will be left without a category.');
      return c.count
        ? t(`${c.count === 1 ? '1 prodotto resterà' : c.count + ' prodotti resteranno'} senza categoria.`, `${c.count === 1 ? '1 product' : c.count + ' products'} will be left without a category.`)
        : t('Nessun prodotto è in questa categoria.', 'No product is in this category.');
    }
    return c.count > 0
      ? t(`Contiene ${c.count === 1 ? '1 servizio' : c.count + ' servizi'}: spostali prima in un’altra categoria, altrimenti non si può eliminare.`, `It holds ${c.count === 1 ? '1 service' : c.count + ' services'}: move them to another category first, otherwise it cannot be deleted.`)
      : t('Nessun servizio è in questa categoria.', 'No service is in this category.');
  };

  const reorder = async (fromI, toI) => {
    const next = [...list];
    const [moved] = next.splice(fromI, 1);
    next.splice(toI, 0, moved);
    setList(kind, next); // optimistic
    try {
      if (cfg.reorder) {
        // una sola chiamata: con una PUT per categoria il riordino non era
        // atomico e, se una falliva a metà, l'ordine tornava indietro da solo
        await cfg.endpoints.reorder(next.map((c) => c.id));
      } else {
        const body = (c) => (kind === 'clienti' ? { name: c.name, color: c.color } : { name: c.name });
        await Promise.all(next.map((c, i) => cfg.endpoints.update(c.id, { ...body(c), order: i })));
      }
      await load(kind);
      syncCtx(kind);
      fireToast({ msg: t('Ordine aggiornato', 'Order updated'), icon: 'check' });
    } catch (err) { toastApiError(err, fireToast, t); load(kind); }
  };

  const blank = () => (kind === 'servizi'
    ? { _new: true, name_it: '', name_en: '', color: randColor() }
    : { _new: true, name: '', color: randColor() });

  const types = [
    ['clienti', t('Clienti', 'Clients'), 'clients'],
    ['servizi', t('Servizi', 'Services'), 'scissors'],
    ['magazzino', t('Magazzino', 'Inventory'), 'box'],
  ];

  return (
    <DkDrawer open onClose={onClose}>
      <div style={{ padding: '22px 22px 0', borderBottom: '1px solid var(--hair)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500 }}>{t('Categorie', 'Categories')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('Crea e modifica le categorie', 'Create and edit categories')}</div>
          </div>
          <button className="dk-iconbtn" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {types.map(([k, l, ic]) => (
            <button key={k} onClick={() => setKind(k)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '11px 4px', marginRight: 18, fontSize: 14.5, fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none', color: kind === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (kind === k ? 'var(--clay)' : 'transparent'), marginBottom: -1 }}>
              <Icon name={ic} size={16} color={kind === k ? 'var(--clay-ink)' : 'var(--muted)'} />{l}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 30px' }}>
        {canWrite ? (
          <button className="dk-btn dk-btn--clay" style={{ width: '100%', marginBottom: 16 }} onClick={() => setEdit(blank())}><Icon name="plus" size={16} color="#fff" />{t('Nuova categoria', 'New category')}</button>
        ) : (
          <div style={{ marginBottom: 16 }}><LockNote t={t} msg={t('Non hai il permesso per modificare queste categorie.', 'You lack the permission to edit these categories.')} /></div>
        )}

        {list === null ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 48, borderRadius: 12 }} />)}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map((c, i) => (
              <div key={c.id} className="dk-card dk-row" draggable={canWrite}
                onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={(e) => { e.preventDefault(); if (canWrite && dragIdx !== null && dragIdx !== i) reorder(dragIdx, i); setDragIdx(null); }}
                onDragEnd={() => setDragIdx(null)}
                onClick={canWrite ? () => setEdit({ ...c }) : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 14px', boxShadow: 'none', border: '1px solid ' + (dragIdx === i ? 'var(--clay)' : 'var(--hair)'), opacity: dragIdx === i ? 0.5 : 1, cursor: canWrite ? 'pointer' : 'default' }}>
                {canWrite && <span title={t('Trascina per riordinare', 'Drag to reorder')} style={{ cursor: 'grab', color: 'var(--muted-2)', fontSize: 15, lineHeight: 1, letterSpacing: '-3px', flexShrink: 0, userSelect: 'none' }} onClick={(e) => e.stopPropagation()}>⋮⋮</span>}
                {cfg.hasColor && <span style={{ width: 14, height: 14, borderRadius: 99, background: c.color || 'var(--paper-2)', flexShrink: 0 }} />}
                <span style={{ flex: 1, fontWeight: 600, fontSize: 14.5 }}>{catName(c, kind, lang)}</span>
                {canWrite && (
                  <React.Fragment>
                    <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={(e) => { e.stopPropagation(); setEdit({ ...c }); }}><Icon name="edit" size={14} /></button>
                    <button className="dk-iconbtn" title={t('Elimina', 'Delete')} style={{ width: 30, height: 30, borderRadius: 8 }} onClick={(e) => { e.stopPropagation(); askDelete(c); }}><Icon name="x" size={14} color="var(--danger)" /></button>
                  </React.Fragment>
                )}
              </div>
            ))}
            {!list.length && <EmptyState icon="tag" title={t('Nessuna categoria', 'No categories')} sub={t('Crea la prima categoria.', 'Create the first category.')} />}
          </div>
        )}
      </div>

      {edit && <CatEditModal draft={edit} setDraft={setEdit} cfg={cfg} onSave={save} saving={saving} onDelete={() => askDelete((list || []).find((x) => x.id === edit.id) || edit)} onClose={() => setEdit(null)} t={t} />}
      <DkConfirm
        open={!!confirmDel}
        busy={deleting}
        confirmDisabled={confirmDel?.count === null}
        onClose={() => setConfirmDel(null)}
        onConfirm={del}
        title={confirmDel?.kind === 'clienti' ? t('Eliminare l’etichetta?', 'Delete the label?') : t('Eliminare la categoria?', 'Delete the category?')}
        message={t(`«${confirmDel ? catName(confirmDel.cat, confirmDel.kind, lang) : ''}» verrà eliminata.`, `“${confirmDel ? catName(confirmDel.cat, confirmDel.kind, lang) : ''}” will be deleted.`)}
        detail={delDetail()}
        confirmLabel={t('Elimina', 'Delete')}
        cancelLabel={t('Annulla', 'Cancel')}
      />
    </DkDrawer>
  );
}

