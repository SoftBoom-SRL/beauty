// ComEditModal.jsx — composer for a Communication (title/body/cta/audience/schedule).
// Not a registry modal (comunicazioni isn't in modals/registry.js) — rendered locally by
// index.jsx as a plain <DkModal>. Owns its own save/delete API calls; the parent just
// refetches the list on success.
import React, { useEffect, useMemo, useState } from 'react';
import { api, ApiError, Icon, toastApiError } from '@youty/shared';
import { DkModal, DkSeg } from '../../ui/index.js';
import { useDash } from '../../ctx.jsx';
import { comStatusMeta, comWhenLabel, dtLocalToIso, isPastSchedule, isoToDtLocal, nowDtLocal } from './helpers.js';

const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 14,
  padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)',
  width: '100%', boxSizing: 'border-box',
};

export default function ComEditModal({ comm, onClose, onSaved, onDeleted, onSend }) {
  const { t, clientCategories, hasScope, fireToast } = useDash();
  const isNew = !comm;
  const canWrite = hasScope('marketing');
  const sent = !isNew && comm.status === 'sent';
  const locked = !canWrite || sent;
  // Una campagna programmata che si modifica torna in bozza sul server (che
  // annulla l'invio in coda o presso Yourang): «Salva» la riprogramma subito
  // alla data del campo, invece di lasciarla in bozza senza dirlo (14-09).
  const wasScheduled = !isNew && comm.status === 'scheduled';

  const [title, setTitle] = useState(comm?.title || '');
  const [body, setBody] = useState(comm?.body || '');
  const [ctaOn, setCtaOn] = useState(!!(comm?.cta_label || comm?.cta_url));
  const [ctaLabel, setCtaLabel] = useState(comm?.cta_label || '');
  const [ctaUrl, setCtaUrl] = useState(comm?.cta_url || '');
  const [audienceType, setAudienceType] = useState(comm?.audience_type || 'labels');
  const [audience, setAudience] = useState(comm?.audience || []);
  const [scheduledAt, setScheduledAt] = useState(isoToDtLocal(comm?.scheduled_at));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* ---- client picker (audience_type === 'clients') ---- */
  const [cq, setCq] = useState('');
  const [clientResults, setClientResults] = useState([]);
  const [clientBusy, setClientBusy] = useState(false);
  const [knownClients, setKnownClients] = useState({}); // id -> full_name (for chip labels)

  // preload names for ids already on the record (editing an existing 'clients' audience)
  useEffect(() => {
    if (isNew || (comm?.audience_type || 'labels') !== 'clients') return;
    const ids = comm?.audience || [];
    if (!ids.length) return;
    let cancelled = false;
    Promise.all(ids.map((id) => api.get(`/api/clients/${id}`).catch(() => null))).then((rows) => {
      if (cancelled) return;
      setKnownClients((m) => {
        const next = { ...m };
        rows.forEach((r) => { if (r) next[r.id] = r.full_name; });
        return next;
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // debounced client search
  useEffect(() => {
    if (audienceType !== 'clients') return;
    let cancelled = false;
    setClientBusy(true);
    const h = setTimeout(() => {
      // solo schede attive: l'invio salta comunque le archiviate, e scegliere
      // il doppione archiviato lasciava fuori la cliente vera (14-22)
      api.get('/api/clients/', { params: { q: cq, is_active: true, limit: 12 } })
        .then((res) => { if (!cancelled) setClientResults(res.items || []); })
        .catch(() => { if (!cancelled) setClientResults([]); })
        .finally(() => { if (!cancelled) setClientBusy(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(h); };
  }, [cq, audienceType]);

  const setAudienceType_ = (v) => {
    if (v === audienceType) return;
    setAudienceType(v);
    setAudience([]); // ids from one type don't apply to the other
  };
  const toggleTag = (id) => setAudience((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const toggleClient = (c) => {
    setKnownClients((m) => ({ ...m, [c.id]: c.full_name }));
    setAudience((a) => (a.includes(c.id) ? a.filter((x) => x !== c.id) : [...a, c.id]));
  };

  // Una data già passata non si accetta: programmata, restava «Programmata»
  // per sempre con una data vecchia (07-14).
  const pastDate = isPastSchedule(scheduledAt);
  const canSave = !!title.trim() && !!body.trim() && !locked && !pastDate;

  const selectedTagNames = useMemo(
    () => audience.map((id) => clientCategories.find((c) => c.id === id)).filter(Boolean).map((c) => c.name),
    [audience, clientCategories]
  );
  const audienceText = !audience.length
    ? t('Nessuna selezione: la comunicazione non avrà destinatari.', 'No selection: the communication will have no recipients.')
    : audienceType === 'labels'
      ? selectedTagNames.join(' · ')
      : audience.length + ' ' + t('clienti selezionate', 'clients selected');

  const persist = () => {
    const payload = {
      title: title.trim(),
      body: body.trim(),
      cta_label: ctaOn ? ctaLabel.trim() : '',
      cta_url: ctaOn ? ctaUrl.trim() : '',
      audience_type: audienceType,
      audience,
      scheduled_at: dtLocalToIso(scheduledAt),
    };
    return isNew
      ? api.post('/api/marketing/communications', payload)
      : api.put(`/api/marketing/communications/${comm.id}`, payload);
  };

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const saved = await persist();
      if (!wasScheduled) {
        fireToast({ msg: t('Comunicazione salvata', 'Communication saved'), icon: 'check' });
        onSaved(saved);
        return;
      }
      const when = dtLocalToIso(scheduledAt);
      if (!when) {
        // campo svuotato: resta in bozza, e lo si dice
        fireToast({ msg: t('Salvata come bozza: l’invio programmato è annullato. Per programmarla di nuovo usa «Invia…».', 'Saved as a draft: the scheduled send is cancelled. Use “Send…” to schedule it again.'), icon: 'alert' });
        onSaved(saved);
        return;
      }
      try {
        const rescheduled = await api.post(`/api/marketing/communications/${saved.id}/send`, { scheduled_at: when });
        fireToast({ msg: t(`Comunicazione salvata · invio programmato per ${comWhenLabel(when, 'it')}`, `Communication saved · send scheduled for ${comWhenLabel(when, 'en')}`), icon: 'check' });
        onSaved(rescheduled);
      } catch (err) {
        const why = err instanceof ApiError ? err.message : t('errore di rete', 'network error');
        fireToast({ msg: t(`Salvata come bozza, ma non riprogrammata (${why}): usa «Invia…» per programmarla.`, `Saved as a draft but not rescheduled (${why}): use “Send…” to schedule it.`), icon: 'alert' });
        onSaved(saved);
      }
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally {
      setSaving(false);
    }
  };

  // "Invia…" — persist current edits first, then hand the fresh record to the send dialog.
  const saveThenSend = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const saved = await persist();
      onSend(saved);
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (isNew || deleting) return;
    setDeleting(true);
    try {
      await api.del(`/api/marketing/communications/${comm.id}`);
      fireToast({ msg: t('Comunicazione eliminata', 'Communication deleted'), icon: 'x' });
      onDeleted(comm.id);
    } catch (err) {
      toastApiError(err, fireToast, t);
      setDeleting(false);
    }
  };

  const statusMeta = !isNew ? comStatusMeta(comm.status, t) : null;

  return (
    <DkModal
      open
      onClose={onClose}
      width={860}
      title={isNew ? t('Nuova comunicazione', 'New communication') : t('Modifica comunicazione', 'Edit communication')}
      sub={statusMeta ? statusMeta.label : undefined}
      foot={
        <React.Fragment>
          {!isNew && canWrite && (
            <button className="dk-btn dk-btn--ghost" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={del} disabled={deleting}>
              <Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}
            </button>
          )}
          <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
          {!sent && canWrite && (
            <button className="dk-btn dk-btn--ghost" disabled={!canSave || saving} onClick={saveThenSend}>
              <Icon name="send" size={16} />{t('Invia…', 'Send…')}
            </button>
          )}
          {!locked && (
            <button className="dk-btn dk-btn--clay" disabled={!canSave || saving} onClick={save}>
              <Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}
            </button>
          )}
        </React.Fragment>
      }
    >
      {sent && (
        <div className="t-sm" style={{ color: 'var(--muted)', background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px', marginBottom: 16 }}>
          {t('Comunicazione già inviata: non è più modificabile.', 'Already sent: no longer editable.')}
        </div>
      )}
      {wasScheduled && canWrite && (
        <div className="t-sm" style={{ color: 'var(--info)', background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="clock" size={14} color="var(--info)" />
          {t(`Programmata per ${comWhenLabel(comm.scheduled_at, 'it')}: salvando, l’invio parte con le modifiche alla data indicata qui sotto.`,
             `Scheduled for ${comWhenLabel(comm.scheduled_at, 'en')}: on save, the send goes out with your edits at the date below.`)}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 22, alignItems: 'start' }}>
        {/* LEFT — editor */}
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Titolo', 'Title')}</div>
          <input disabled={locked} value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={t('es. Nuovo rituale viso "Lumière"', 'e.g. New "Lumière" facial ritual')}
            style={{ ...inputCss, marginBottom: 14 }} />

          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Messaggio', 'Message')}</div>
          <textarea disabled={locked} value={body} onChange={(e) => setBody(e.target.value)} rows={5}
            placeholder={t('Racconta la novità con il tono del salone…', 'Tell the story in the salon’s voice…')}
            style={{ ...inputCss, resize: 'vertical', marginBottom: 14 }} />

          {/* CTA — optional, free-text */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
            <div className="t-meta" style={{ flex: 1 }}>{t('Pulsante azione', 'Action button')}</div>
            <button disabled={locked} onClick={() => setCtaOn((o) => !o)} style={{ position: 'relative', width: 38, height: 22, borderRadius: 99, cursor: locked ? 'default' : 'pointer', border: 'none', background: ctaOn ? 'var(--clay)' : 'var(--hair)', transition: 'background 140ms' }}>
              <span style={{ position: 'absolute', top: 2, left: ctaOn ? 18 : 2, width: 18, height: 18, borderRadius: 99, background: '#fff', transition: 'left 140ms' }} />
            </button>
          </div>
          {ctaOn ? (
            <React.Fragment>
              <input disabled={locked} value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)}
                placeholder={t('Testo, es. Prenota ora', 'Label, e.g. Book now')} style={{ ...inputCss, marginBottom: 8 }} />
              <input disabled={locked} value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)}
                placeholder={t('Link (opzionale)', 'Link (optional)')} style={{ ...inputCss, marginBottom: 18 }} />
            </React.Fragment>
          ) : (
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 18 }}>{t('Nessun pulsante — solo testo.', 'No button — text only.')}</div>
          )}

          {/* audience */}
          <div style={{ padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12 }}>
            <div className="t-meta" style={{ marginBottom: 3 }}>{t('Pubblico', 'Audience')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 11 }}>{t('Per etichetta o per cliente — non è possibile combinarle.', 'By label or by client — cannot be combined.')}</div>

            <DkSeg
              options={[
                { value: 'labels', label: t('Per etichetta', 'By label') },
                { value: 'clients', label: t('Per cliente', 'By client') },
              ]}
              value={audienceType}
              onChange={locked ? () => {} : setAudienceType_}
              style={{ marginBottom: 13 }}
            />

            {audienceType === 'labels' ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {clientCategories.map((cat) => {
                  const on = audience.includes(cat.id);
                  return (
                    <button key={cat.id} disabled={locked} onClick={() => toggleTag(cat.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: locked ? 'default' : 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: cat.color }} />{cat.name}{on && <Icon name="check" size={12} color="var(--clay-ink)" />}
                    </button>
                  );
                })}
                {!clientCategories.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessuna etichetta configurata.', 'No labels configured.')}</span>}
              </div>
            ) : (
              <React.Fragment>
                <div className="dk-search" style={{ width: '100%', height: 36, marginBottom: 8 }}>
                  <Icon name="search" size={15} color="var(--muted-2)" />
                  <input disabled={locked} value={cq} onChange={(e) => setCq(e.target.value)} placeholder={t('Cerca cliente…', 'Search client…')} />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, minHeight: 30 }}>
                  {audience.filter((id) => !clientResults.some((c) => c.id === id)).map((id) => (
                    <button key={id} disabled={locked} onClick={() => toggleClient({ id, full_name: knownClients[id] })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: locked ? 'default' : 'pointer', border: '1px solid var(--clay)', background: 'var(--clay-tint)', color: 'var(--clay-ink)' }}>
                      {knownClients[id] || ('#' + id)}<Icon name="check" size={12} color="var(--clay-ink)" />
                    </button>
                  ))}
                  {clientResults.map((c) => {
                    const on = audience.includes(c.id);
                    return (
                      <button key={c.id} disabled={locked} onClick={() => toggleClient(c)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: locked ? 'default' : 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>
                        {c.full_name}{on && <Icon name="check" size={12} color="var(--clay-ink)" />}
                      </button>
                    );
                  })}
                  {clientBusy && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Ricerca…', 'Searching…')}</span>}
                  {!clientBusy && !clientResults.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun cliente trovato.', 'No client found.')}</span>}
                </div>
              </React.Fragment>
            )}

            {audience.length > 0 && !locked && (
              <button className="t-sm" onClick={() => setAudience([])} style={{ marginTop: 11, fontWeight: 600, color: 'var(--clay-ink)', cursor: 'pointer', textDecoration: 'underline', background: 'transparent' }}>
                {t('Azzera selezione', 'Clear selection')}
              </button>
            )}
          </div>
        </div>

        {/* RIGHT — preview + scheduling */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div className="t-meta" style={{ marginBottom: 8 }}>{t('Anteprima WhatsApp', 'WhatsApp preview')}</div>
            <div style={{ background: '#E5DDD3', borderRadius: 14, padding: 14 }}>
              <div style={{ background: '#fff', borderRadius: '4px 14px 14px 14px', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.12)' }}>
                <div style={{ padding: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{title || t('Titolo della comunicazione', 'Communication title')}</div>
                  <div style={{ fontSize: 12.5, color: '#3A3A3A', marginTop: 5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{body || t('Il testo del messaggio comparirà qui.', 'The message text will appear here.')}</div>
                  {ctaOn && ctaLabel && <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid #ECECEC', textAlign: 'center', color: '#1F8AED', fontWeight: 700, fontSize: 13 }}>{ctaLabel}</div>}
                  <div style={{ textAlign: 'right', fontSize: 10, color: '#9A9A9A', marginTop: 6 }}>{t('Inviata da Yourang', 'Sent via Yourang')}</div>
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="t-meta" style={{ marginBottom: 5 }}>{t('Programma invio (opzionale)', 'Schedule send (optional)')}</div>
            <input disabled={locked} type="datetime-local" min={nowDtLocal()} value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} style={inputCss} />
            {pastDate && !locked && (
              <div className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600, marginTop: 6 }}>
                {t('La data è già passata: scegline una futura o svuota il campo.', 'That date has passed: pick a future one or clear the field.')}
              </div>
            )}
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>
              {wasScheduled
                ? t('Programmata: «Salva» la riprogramma a questa data con le modifiche. Svuota il campo per riportarla in bozza.', 'Scheduled: “Save” reschedules it at this date with your edits. Clear the field to turn it back into a draft.')
                : t('Salvata qui come promemoria. L’invio (subito o programmato) avviene con "Invia…".', 'Saved here as a reminder. Delivery (now or scheduled) happens with "Send…".')}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 13px', background: 'var(--clay-tint)', borderRadius: 12 }}>
            <Icon name="clients" size={15} color="var(--clay-ink)" />
            <span className="t-sm" style={{ color: 'var(--clay-ink)', lineHeight: 1.45 }}>
              {t('Destinatari', 'Recipients')}: <b>{audienceText}</b>. {t('L’invio WhatsApp è gestito da Yourang.', 'WhatsApp delivery is handled by Yourang.')}
            </span>
          </div>
        </div>
      </div>
    </DkModal>
  );
}
