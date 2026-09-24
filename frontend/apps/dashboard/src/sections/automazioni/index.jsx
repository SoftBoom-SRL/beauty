// Automazioni — two-pane section (prototype DkAuto port, API-backed).
// Left: rules from GET /api/automations/ (toggle POST /{id}/toggle, delete with
// confirm). Right: builder (POST / PUT /api/automations/). Events, condition
// fields and operators come from GET /api/automations/events-catalog.
import React, { useCallback, useEffect, useState } from 'react';
import { api, Icon, Toggle, EmptyState, toastApiError } from '@youty/shared';
import { DkModal } from '../../ui/index.js';
import { useDash, useLive } from '../../ctx.jsx';
import Builder from './Builder.jsx';
import { eventIcon, offsetPhrase, catLabel } from './catalog.js';

export default function AutomazioniSection() {
  const { t, lang, fireToast, hasScope, settings, session, reload } = useDash();
  const canWrite = hasScope('marketing');

  const [rules, setRules] = useState(null);      // null = loading
  const [catalog, setCatalog] = useState(null);  // { events, operators, fields }
  const [loadError, setLoadError] = useState(false);
  const [sel, setSel] = useState(null);          // rule id | 'new' | null
  const [confirmDel, setConfirmDel] = useState(null); // rule pending deletion
  const [deleting, setDeleting] = useState(false);

  const toastErr = useCallback((err) => toastApiError(err, fireToast, t), [fireToast, t]);

  const refetch = useCallback(async () => {
    const list = await api.get('/api/automations/');
    setRules(list);
    return list;
  }, []);

  /* ---- initial load: rules + events catalog in parallel ---- */
  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const [list, cat] = await Promise.all([
        api.get('/api/automations/'),
        api.get('/api/automations/events-catalog'),
      ]);
      setRules(list);
      setCatalog(cat);
      setSel((s) => (s != null ? s : (list[0] ? list[0].id : null)));
    } catch (err) {
      setLoadError(true);
      toastErr(err);
    }
  }, [toastErr]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // client_category: rinominando un'etichetta il server riscrive le condizioni
  // delle automazioni che la citano (il Builder aperto fonde la versione nuova)
  useLive(/^(automation|client_category)\./, () => load());

  /* ---- toggle active (optimistic, then refetch) ---- */
  const toggle = async (rule) => {
    if (!canWrite) return;
    setRules((l) => l.map((r) => (r.id === rule.id ? { ...r, active: !r.active } : r)));
    try {
      await api.post(`/api/automations/${rule.id}/toggle`);
      await refetch();
    } catch (err) {
      toastErr(err);
      try { await refetch(); } catch { /* list already shown */ }
    }
  };

  /* ---- delete (confirm modal first) ---- */
  const doDelete = async () => {
    const rule = confirmDel;
    if (!rule) return;
    setDeleting(true);
    try {
      await api.del(`/api/automations/${rule.id}`);
      setConfirmDel(null);
      const list = await refetch();
      setSel((s) => (s === rule.id ? (list[0] ? list[0].id : null) : s));
      fireToast({ msg: t('Automazione eliminata', 'Automation deleted'), icon: 'check' });
    } catch (err) {
      toastErr(err);
    } finally {
      setDeleting(false);
    }
  };

  /* ---- after save in the builder: refetch + select the saved rule ---- */
  const onSaved = async (saved) => {
    try {
      await refetch();
      setSel(saved.id);
    } catch (err) {
      toastErr(err);
    }
  };

  const loading = rules === null || catalog === null;
  const activeCount = (rules || []).filter((r) => r.active).length;
  const curRule = sel !== 'new' ? (rules || []).find((r) => r.id === sel) : null;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* ---- left: rules list ---- */}
      <div style={{ width: 380, flexShrink: 0, borderRight: '1px solid var(--hair)', display: 'flex', flexDirection: 'column', background: 'var(--paper)' }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--hair)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {loading
                ? <div className="skel" style={{ height: 16, width: 140 }} />
                : <div className="t-meta" style={{ color: 'var(--clay-ink)' }}>{activeCount} {t('attive', 'active')} · {rules.length} {t('totali', 'total')}</div>}
              <div className="t-body" style={{ color: 'var(--muted)', marginTop: 4 }}>{t('Decidi quando partono e a chi. Canale e messaggio su Yourang.', 'Decide when they fire and to whom. Channel and message on Yourang.')}</div>
            </div>
            {canWrite && !loading && (
              <button className="dk-btn dk-btn--clay" style={{ height: 38, padding: '0 14px', fontSize: 13.5, flexShrink: 0 }} onClick={() => setSel('new')}>
                <Icon name="plus" size={15} color="#fff" />{t('Nuova', 'New')}
              </button>
            )}
          </div>
        </div>
        <DelaySetting t={t} settings={settings} isOwner={!!session?.is_owner} reload={reload} fireToast={fireToast} onError={toastErr} />
        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {loadError ? (
            <EmptyState
              icon="alert"
              title={t('Errore di caricamento', 'Loading error')}
              sub={t('Impossibile caricare le automazioni.', 'Could not load the automations.')}
              action={t('Riprova', 'Retry')}
              onAction={load}
            />
          ) : loading ? (
            [...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 76, borderRadius: 14, marginBottom: 8 }} />)
          ) : rules.length === 0 && sel !== 'new' ? (
            <EmptyState
              icon="bolt"
              title={t('Nessuna automazione', 'No automations')}
              sub={t('Crea la prima regola: evento, tempi e filtri.', 'Create your first rule: event, timing and filters.')}
              action={canWrite ? t('Nuova automazione', 'New automation') : undefined}
              onAction={() => setSel('new')}
            />
          ) : (
            rules.map((r) => {
              const on = r.id === sel;
              const evItem = catalog.events.find((e) => e.value === r.event);
              return (
                <div key={r.id} className="dk-row" onClick={() => setSel(r.id)} style={{ padding: '13px 14px', borderRadius: 14, marginBottom: 4, background: on ? 'var(--surface)' : 'transparent', boxShadow: on ? 'var(--sh-sm)' : 'none', opacity: r.active ? 1 : 0.68 }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ width: 38, height: 38, borderRadius: 11, background: r.active ? 'var(--clay-tint)' : 'var(--paper-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                      <Icon name={eventIcon(r.event)} size={19} color={r.active ? 'var(--clay-ink)' : 'var(--muted)'} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>
                        {catLabel(evItem, lang) || r.event} · {offsetPhrase(r.offset_direction, r.offset_value, r.offset_unit, lang).toLowerCase()}
                      </div>
                      {r.active && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7, fontSize: 12, fontWeight: 600, color: 'var(--muted-2)' }}>
                          <Icon name="trend" size={13} color="var(--muted-2)" />— · {t('dati da Yourang (fase 2)', 'data from Yourang (phase 2)')}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      <Toggle on={r.active} onChange={() => toggle(r)} />
                      {canWrite && (
                        <button className="dk-iconbtn" title={t('Elimina', 'Delete')} onClick={() => setConfirmDel(r)} style={{ width: 28, height: 28, borderRadius: 8, color: 'var(--muted)' }}>
                          <Icon name="x" size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ---- right: builder ---- */}
      <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {loadError ? null : loading ? (
          <BuilderSkeleton />
        ) : sel === 'new' ? (
          <Builder key="new" rule={null} catalog={catalog} canWrite={canWrite} onSaved={onSaved} />
        ) : curRule ? (
          <Builder key={curRule.id} rule={curRule} catalog={catalog} canWrite={canWrite} onSaved={onSaved} />
        ) : (
          <div style={{ padding: '24px 28px' }}>
            <EmptyState icon="bolt" title={t('Seleziona un’automazione', 'Select an automation')} sub={t('Oppure creane una nuova dalla lista.', 'Or create a new one from the list.')} />
          </div>
        )}
      </div>

      {/* ---- delete confirm ---- */}
      <DkModal
        open={!!confirmDel}
        onClose={() => !deleting && setConfirmDel(null)}
        title={t('Eliminare l’automazione?', 'Delete this automation?')}
        sub={confirmDel ? confirmDel.name : ''}
        width={440}
        foot={(
          <React.Fragment>
            <button className="dk-btn dk-btn--ghost" disabled={deleting} onClick={() => setConfirmDel(null)}>{t('Annulla', 'Cancel')}</button>
            <button className="dk-btn dk-btn--primary" disabled={deleting} onClick={doDelete} style={{ background: 'var(--danger)', opacity: deleting ? 0.6 : 1 }}>
              {deleting ? t('Eliminazione…', 'Deleting…') : t('Elimina', 'Delete')}
            </button>
          </React.Fragment>
        )}
      >
        <div className="t-body" style={{ color: 'var(--muted)' }}>
          {t('La regola viene rimossa anche da Yourang e smette subito di inviare messaggi. L’azione non è reversibile.', 'The rule is removed from Yourang too and immediately stops sending messages. This cannot be undone.')}
        </div>
      </DkModal>
    </div>
  );
}

/* ---- attesa prima dell'invio ----------------------------------------------------
 * Il gesto e il messaggio non sono la stessa cosa. In agenda si inserisce una
 * cliente e un attimo dopo la si sposta di mezz'ora: se l'automazione partisse
 * nell'istante del primo gesto, la cliente riceverebbe due messaggi, e il primo
 * sbagliato. Con qualche secondo di attesa i due gesti diventano un messaggio
 * solo, quello giusto — e un'azione annullata con «torna indietro» non ne manda
 * nessuno. Si cambia da qui perché è qui che si ragiona sui messaggi.
 * Salva subito, senza tasti: è una scelta sola, e il titolare la vede applicata. */
const DELAY_CHOICES = [
  [0, 'Subito', 'Now'],
  [15, '15 s', '15 s'],
  [30, '30 s', '30 s'],
  [60, '1 min', '1 min'],
  [120, '2 min', '2 min'],
];

function DelaySetting({ t, settings, isOwner, reload, fireToast, onError }) {
  const saved = settings?.automation_delay_seconds ?? 30;
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(saved); }, [saved]);

  const pick = async (next) => {
    if (!isOwner || saving || next === value) return;
    const previous = value;
    setValue(next);           // la scelta si vede subito, il salvataggio segue
    setSaving(true);
    try {
      await api.put('/api/core/settings', { automation_delay_seconds: next });
      // Salvato: la ricarica delle impostazioni va per conto suo. Stava nello
      // stesso try e, se cadeva, la pillola tornava al valore vecchio anche se
      // il server aveva salvato il nuovo (15-19).
      reload.salon().catch(() => {});
      fireToast({
        msg: next === 0
          ? t('I messaggi partono subito', 'Messages go out immediately')
          : t(`Attesa di ${next < 60 ? next + ' secondi' : next / 60 + ' minuti'} prima dell'invio`, `${next < 60 ? next + ' seconds' : next / 60 + ' minutes'} wait before sending`),
        icon: 'check',
      });
    } catch (err) {
      setValue(previous);
      onError(err);
    } finally { setSaving(false); }
  };

  return (
    <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--hair)', background: 'var(--paper-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="clock" size={15} color="var(--muted)" />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Attesa prima dell’invio', 'Wait before sending')}</span>
      </div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>
        {t('Se l’appuntamento viene corretto (o l’azione annullata) entro questo tempo, alla cliente arriva un messaggio solo: quello giusto.',
           'If the appointment is corrected (or the action undone) within this time, the client gets a single message: the right one.')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, opacity: isOwner ? 1 : 0.6 }}>
        {/* Un valore impostato altrove (l'API accetta qualunque numero fino a
          * dieci minuti) compare come pillola in più: l'impostazione in corso
          * deve vedersi sempre, anche se non è una delle scelte rapide. */}
        {(DELAY_CHOICES.some(([v]) => v === value) ? DELAY_CHOICES : [...DELAY_CHOICES, [value, `${value} s`, `${value} s`]])
          .map(([v, it, en]) => {
          const on = value === v;
          return (
            <button key={v} onClick={() => pick(v)} disabled={!isOwner || saving}
              title={isOwner ? undefined : t('Solo il titolare può cambiarla', 'Only the owner can change this')}
              style={{ padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: isOwner && !saving ? 'pointer' : 'default', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)', transition: 'all 140ms' }}>
              {t(it, en)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BuilderSkeleton() {
  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 780 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
        <div className="skel" style={{ width: 48, height: 48, borderRadius: 14 }} />
        <div style={{ flex: 1 }}>
          <div className="skel" style={{ height: 24, width: 260, marginBottom: 8 }} />
          <div className="skel" style={{ height: 14, width: 180 }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14, marginBottom: 22 }}>
        {[...Array(3)].map((_, i) => <div key={i} className="skel" style={{ height: 74, borderRadius: 14, flex: i === 2 ? 2 : 1 }} />)}
      </div>
      {[...Array(3)].map((_, i) => <div key={i} className="skel" style={{ height: 130, borderRadius: 16, marginBottom: 12 }} />)}
    </div>
  );
}
