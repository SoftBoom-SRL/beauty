// desktop-fedelta.jsx — Coupon & Fedeltà: coupon templates + loyalty programs
const { useState: useStateFe, useRef: useRefFe } = React;

const COUPON_AUTO = {
  none: { it: 'Manuale', en: 'Manual' },
  new: { it: 'Auto · nuovi clienti', en: 'Auto · new clients' },
  dormant: { it: 'Auto · dormienti', en: 'Auto · dormant' },
  birthday: { it: 'Auto · compleanno', en: 'Auto · birthday' },
  loyalty: { it: 'Fedeltà · riscatto punti', en: 'Loyalty · points redeemed' },
};
function couponValue(c, lang) {
  if (c.kind === 'gift') return (c.giftText && (c.giftText[lang] || c.giftText.it)) || (lang === 'en' ? 'Gift' : 'Omaggio');
  if (c.kind === 'amount') return '-' + fmtEur(c.amount, lang);
  return '-' + c.amount + '%';
}
function couponScope(c, t, lang) {
  if (!c.services || !c.services.length) return t('Tutti i servizi', 'All services');
  return c.services.map(id => svc(id) ? svcName(svc(id), lang) : '').filter(Boolean).join(', ');
}

function DkFedelta() {
  const { t, lang, fireToast, coupons, setCoupons, loyalty, setLoyalty, giftcards, setGiftcards, subTab, setSubTab } = useDk();
  const sub = subTab || 'coupon';
  const setSub = setSubTab;
  const tabs = [['coupon', t('Coupon', 'Coupons')], ['fedelta', t('Fedeltà', 'Loyalty')], ['giftcard', t('Gift card', 'Gift cards')]];
  return (
    <div className="dk-page" style={{ maxWidth: 1120 }}>
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 22 }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} style={{ padding: '11px 4px', marginRight: 22, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', color: sub === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (sub === k ? 'var(--clay)' : 'transparent'), marginBottom: -1 }}>{l}</button>
        ))}
      </div>
      {sub === 'coupon'
        ? <CouponSub coupons={coupons} setCoupons={setCoupons} t={t} lang={lang} fireToast={fireToast} />
        : sub === 'fedelta'
          ? <LoyaltySub loyalty={loyalty} setLoyalty={setLoyalty} coupons={coupons} t={t} lang={lang} fireToast={fireToast} />
          : <GiftCardSub giftcards={giftcards} setGiftcards={setGiftcards} t={t} lang={lang} fireToast={fireToast} />}
    </div>
  );
}

/* pagina dedicata — Gift card (prepagato: natura finanziaria diversa dagli sconti) */
function GiftCardSub({ t, lang, fireToast, giftcards, setGiftcards }) {
  // props passed from DkFedelta
  return (
    <div className="dk-page" style={{ maxWidth: 1120 }}>
      <GiftSub giftcards={giftcards} setGiftcards={setGiftcards} t={t} lang={lang} fireToast={fireToast} />
    </div>
  );
}

/* ---------- Coupons ---------- */
function CouponSub({ coupons, setCoupons, t, lang, fireToast }) {
  const [q, setQ] = useStateFe('');
  const [origF, setOrigF] = useStateFe('all');
  const [typeF, setTypeF] = useStateFe('all');
  const [statusF, setStatusF] = useStateFe('all');
  const [edit, setEdit] = useStateFe(null);
  const seq = useRefFe(700);
  const origOf = (c) => c.auto === 'loyalty' ? 'loyalty' : (c.auto && c.auto !== 'none' ? 'auto' : 'manual');
  const list = coupons.filter(c => {
    const okO = origF === 'all' || origOf(c) === origF;
    const okT = typeF === 'all' || c.kind === typeF;
    const okS = statusF === 'all' || (statusF === 'active' && c.active) || (statusF === 'inactive' && !c.active);
    const okQ = !q || c.desc[lang].toLowerCase().includes(q.toLowerCase()) || c.code.toLowerCase().includes(q.toLowerCase());
    return okO && okT && okS && okQ;
  });
  const blank = () => ({ id: 'ct' + (seq.current++), code: 'YR' + Math.random().toString(36).slice(2, 6).toUpperCase(), desc: { it: '', en: '' }, kind: 'percent', amount: 10, giftText: { it: '', en: '' }, services: [], validity: { it: '60 giorni', en: '60 days' }, active: true, auto: 'none', _new: true });
  const save = (d) => { const { _new, ...rest } = d; setCoupons(l => _new ? [rest, ...l] : l.map(c => c.id === d.id ? rest : c)); setEdit(null); fireToast({ msg: t('Coupon salvato', 'Coupon saved'), icon: 'check' }); };
  const del = (id) => { setCoupons(l => l.filter(c => c.id !== id)); setEdit(null); fireToast({ msg: t('Coupon eliminato', 'Coupon deleted'), icon: 'x' }); };
  return (
    <React.Fragment>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('Crea i coupon e assegnali ai clienti dalla loro scheda. Quelli automatici partono da soli al verificarsi dell’evento.', 'Create coupons and assign them from each client’s profile. Automatic ones trigger on their own.')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 0, width: 'auto' }}>
          <Icon name="search" size={18} color="var(--muted-2)" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Cerca un coupon…', 'Search a coupon…')} />
          {q && <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
        </div>
        <GroupedFilterMenu t={t} groups={[
          { label: t('Origine', 'Origin'), value: origF, set: setOrigF, opts: [['all', t('Tutte', 'All')], ['manual', t('Manuale', 'Manual')], ['auto', t('Automatico', 'Automatic')], ['loyalty', t('Da fedeltà', 'From loyalty')]] },
          { label: t('Tipo', 'Type'), value: typeF, set: setTypeF, opts: [['all', t('Tutti', 'All')], ['percent', t('Percentuale', 'Percentage')], ['amount', t('Importo', 'Amount')], ['gift', t('Omaggio', 'Gift')]] },
          { label: t('Stato', 'Status'), value: statusF, set: setStatusF, opts: [['all', t('Tutti', 'All')], ['active', t('Attivi', 'Active')], ['inactive', t('Non attivi', 'Inactive')]] },
        ]} />
        <button className="dk-btn dk-btn--clay" onClick={() => setEdit(blank())} style={{ flexShrink: 0 }}><Icon name="plus" size={17} color="#fff" />{t('Nuovo coupon', 'New coupon')}</button>
      </div>
      {list.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {list.map(c => (
            <div key={c.id} className="dk-card dk-hovercard" onClick={() => setEdit({ ...c, desc: { ...c.desc }, giftText: { ...(c.giftText || { it: '', en: '' }) }, validity: { ...c.validity }, services: [...(c.services || [])] })} style={{ padding: 18, opacity: c.active ? 1 : 0.6, borderLeft: '3px solid ' + (c.active ? 'var(--clay)' : 'var(--faint)') }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={c.kind === 'gift' ? 'gift' : 'coupon'} size={21} color="var(--clay-ink)" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15.5 }}>{c.desc[lang]}</div>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 6, display: 'inline-block', marginTop: 5 }}>{c.code}</span>
                </div>
                <div className="t-num" style={{ fontSize: 20, color: 'var(--clay-ink)' }}>{couponValue(c, lang)}</div>
              </div>
              <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="tag" size={13} color="var(--muted-2)" />{couponScope(c, t, lang)}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="calendar" size={13} color="var(--muted-2)" />{c.validity[lang]}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
                {c.auto === 'loyalty' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name="star" size={12} color="var(--clay-ink)" />{COUPON_AUTO.loyalty[lang]}</span>}
                {c.auto !== 'none' && c.auto !== 'loyalty' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name="bolt" size={12} color="var(--ok)" />{COUPON_AUTO[c.auto][lang]}</span>}
                {c.auto === 'none' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>{COUPON_AUTO.none[lang]}</span>}
                {!c.active && <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 99 }}>{t('Non attivo', 'Inactive')}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="coupon" title={t('Nessun coupon', 'No coupons')} sub={t('Crea il tuo primo coupon.', 'Create your first coupon.')} action={t('Nuovo coupon', 'New coupon')} onAction={() => setEdit(blank())} />}
      {edit && <CouponEditModal draft={edit} setDraft={setEdit} onSave={save} onDelete={del} onClose={() => setEdit(null)} t={t} lang={lang} />}
    </React.Fragment>
  );
}

function CouponEditModal({ draft, setDraft, onSave, onDelete, onClose, t, lang }) {
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setL = (key, v) => setDraft(d => ({ ...d, [key]: { ...d[key], [lang]: v } }));
  const toggleSvc = (id) => setDraft(d => ({ ...d, services: d.services.includes(id) ? d.services.filter(x => x !== id) : [...d.services, id] }));
  const canSave = (draft.desc[lang] || '').trim();
  const kinds = [['percent', t('Percentuale', 'Percentage')], ['amount', t('Importo', 'Amount')], ['gift', t('Omaggio', 'Gift')]];
  const autos = [['none', COUPON_AUTO.none[lang]], ['new', t('Nuovi clienti', 'New clients')], ['dormant', t('Dormienti', 'Dormant')], ['birthday', t('Compleanno', 'Birthday')], ['loyalty', t('Fedeltà (riscatto punti)', 'Loyalty (points redemption)')]];
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%' };
  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Nuovo coupon', 'New coupon') : t('Modifica coupon', 'Edit coupon')} sub={t('Valore, servizi, validità e automazione', 'Value, services, validity and automation')} width={560}
      foot={<React.Fragment>
        {!draft._new && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={() => onDelete(draft.id)}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => canSave && onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 12, marginBottom: 16 }}>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Descrizione', 'Description')}</div><input value={draft.desc[lang] || ''} onChange={e => setL('desc', e.target.value)} placeholder={t('es. Sconto fedeltà', 'e.g. Loyalty discount')} style={inputCss} /></div>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Codice', 'Code')}</div><input value={draft.code} onChange={e => set({ code: e.target.value.toUpperCase() })} style={{ ...inputCss, fontFamily: 'ui-monospace, monospace', letterSpacing: '0.05em', fontWeight: 700 }} /></div>
      </div>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Tipo', 'Type')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {kinds.map(([k, l]) => <button key={k} onClick={() => set({ kind: k })} style={{ flex: 1, padding: '10px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (draft.kind === k ? 'var(--ink)' : 'var(--hair)'), background: draft.kind === k ? 'var(--ink)' : 'var(--surface)', color: draft.kind === k ? '#fff' : 'var(--ink-2)' }}>{l}</button>)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12, marginBottom: 16 }}>
        {draft.kind === 'gift' ? (
          <div style={{ flex: 1 }}><div className="t-meta" style={{ marginBottom: 6 }}>{t('Servizio in omaggio', 'Free service / gift')}</div><input value={(draft.giftText && draft.giftText[lang]) || ''} onChange={e => setL('giftText', e.target.value)} placeholder={t('es. Nail art', 'e.g. Nail art')} style={inputCss} /></div>
        ) : (
          <React.Fragment>
            <div style={{ flex: 1 }}>
              <div className="t-meta" style={{ marginBottom: 8 }}>{draft.kind === 'percent' ? t('Percentuale', 'Percentage') : t('Importo', 'Amount')}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)' }}>
                {draft.kind === 'amount' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>}
                <input type="number" value={draft.amount} onChange={e => set({ amount: Math.max(0, parseInt(e.target.value) || 0) })} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 70 }} />
                {draft.kind === 'percent' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Mostrato come', 'Shown as')}</div><div className="t-num" style={{ fontSize: 24, color: 'var(--clay-ink)' }}>{couponValue(draft, lang)}</div></div>
          </React.Fragment>
        )}
      </div>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Servizi applicabili', 'Applicable services')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 6 }}>
        <button onClick={() => set({ services: [] })} style={{ padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (!draft.services.length ? 'var(--ink)' : 'var(--hair)'), background: !draft.services.length ? 'var(--ink)' : 'var(--surface)', color: !draft.services.length ? '#fff' : 'var(--ink-2)' }}>{t('Tutti i servizi', 'All services')}</button>
        {SERVICES.map(s => { const on = draft.services.includes(s.id); return (
          <button key={s.id} onClick={() => toggleSvc(s.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{svcName(s, lang)}{on && <Icon name="check" size={12} color="#fff" />}</button>); })}
      </div>
      <div style={{ height: 16 }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Validità', 'Validity')}</div><input value={draft.validity[lang] || ''} onChange={e => setL('validity', e.target.value)} style={inputCss} /></div>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Assegnazione', 'Assignment')}</div>
          <select value={draft.auto} onChange={e => set({ auto: e.target.value })} style={{ ...inputCss, cursor: 'pointer' }}>{autos.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12, marginTop: 16 }}>
        <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{t('Coupon attivo', 'Coupon active')}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{draft.auto !== 'none' ? t('Verrà inviato automaticamente', 'Sent automatically') : t('Assegnabile manualmente', 'Manually assignable')}</div></div>
        <Toggle on={draft.active} onChange={v => set({ active: v })} />
      </div>
    </DkModal>
  );
}

/* ---------- Loyalty ---------- */
const LOYALTY_COLORS = ['#B26A4F', '#6FB89A', '#5FAEC9', '#9B86E0', '#E0A85A', '#E08B9A'];
const LOYALTY_ICONS = ['star', 'gift', 'sparkle', 'heart', 'cake', 'bolt'];
const REWARD_KINDS = [
  { k: 'amount',  it: 'Buono €',    en: '€ coupon',     suffix: '€' },
  { k: 'percent', it: 'Sconto %',   en: '% discount',   suffix: '%' },
  { k: 'service', it: 'Servizio omaggio', en: 'Free service', suffix: '' },
  { k: 'product', it: 'Prodotto omaggio', en: 'Free product', suffix: '' },
  { k: 'giftcard', it: 'Gift card',  en: 'Gift card',    suffix: '€' },
];
function composeReward(kind, value, customText, lang) {
  if (kind === 'percent') return lang === 'en' ? value + '% discount' : 'Sconto ' + value + '%';
  if (kind === 'service') return customText || (lang === 'en' ? 'Free service' : 'Servizio omaggio');
  if (kind === 'product') return customText || (lang === 'en' ? 'Free product' : 'Prodotto omaggio');
  if (kind === 'giftcard') return lang === 'en' ? '€' + value + ' gift card' : 'Gift card da €' + value;
  return lang === 'en' ? '€' + value + ' coupon' : 'Buono da €' + value;
}
function LoyaltySub({ loyalty, setLoyalty, coupons, t, lang, fireToast }) {
  const { clientCats } = useDk();
  const [edit, setEdit] = useStateFe(null);
  const seq = useRefFe(700);
  const blank = () => ({ id: 'lp' + (seq.current++), name: { it: '', en: '' }, type: 'points', active: true, earn: 1, earnPer: 1, earnBasis: 'spend', earnOn: 'both', threshold: 100, rewardKind: 'amount', rewardValue: 10, reward: { it: '', en: '' }, desc: { it: '', en: '' }, color: LOYALTY_COLORS[0], icon: 'star', iconImg: null, enroll: 'auto', fee: 0, expiry: 'none', bonus: [], audTags: [], audClients: [], _new: true });
  const save = (d) => { const { _new, ...rest } = d; setLoyalty(l => _new ? [...l, rest] : l.map(p => p.id === d.id ? rest : p)); setEdit(null); fireToast({ msg: t('Programma salvato', 'Program saved'), icon: 'check' }); };
  const del = (id) => { setLoyalty(l => l.filter(p => p.id !== id)); setEdit(null); fireToast({ msg: t('Programma eliminato', 'Program deleted'), icon: 'x' }); };
  return (
    <React.Fragment>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="t-sm" style={{ color: 'var(--muted)', maxWidth: 560 }}>{t('Crea percorsi fedeltà a punti o a timbri. Il progresso di ogni cliente è visibile nella sua scheda.', 'Create points- or stamp-based loyalty paths. Each client’s progress shows on their profile.')}</div>
        <button className="dk-btn dk-btn--clay" onClick={() => setEdit(blank())} style={{ flexShrink: 0 }}><Icon name="plus" size={17} color="#fff" />{t('Nuovo programma', 'New program')}</button>
      </div>
      {/* il premio, al riscatto, genera un coupon — legame esplicito fedeltà → coupon */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 16px', background: 'var(--clay-tint)', borderRadius: 12, marginBottom: 18 }}>
        <Icon name="star" size={17} color="var(--clay-ink)" />
        <div style={{ fontSize: 13.5, color: 'var(--clay-ink)', lineHeight: 1.45 }}>
          <strong>{t('Premio raggiunto = coupon.', 'Reward reached = coupon.')}</strong> {t('Quando la cliente riscatta il premio, viene generato un coupon che trovi nel tab Coupon con origine “Fedeltà”.', 'When a client redeems the reward, a coupon is generated — you’ll find it in the Coupons tab with origin “Loyalty”.')}
        </div>
      </div>
      {loyalty.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
          {loyalty.map(p => (
            <div key={p.id} className="dk-card dk-hovercard" onClick={() => setEdit({ ...p, name: { ...p.name }, reward: { ...p.reward }, desc: { ...p.desc }, audTags: [...(p.audTags || [])], audClients: [...(p.audClients || [])] })} style={{ padding: 20, opacity: p.active ? 1 : 0.6 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: 'color-mix(in srgb, ' + (p.color || 'var(--clay-ink)') + ' 16%, transparent)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={p.type === 'points' ? 'star' : 'check'} size={22} color={p.color || 'var(--clay-ink)'} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{p.name[lang]}</div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--ink-2)', background: 'var(--paper-2)', padding: '3px 9px', borderRadius: 99 }}>{p.type === 'points' ? t('A punti', 'Points') : t('A timbri', 'Stamps')}</span>
                </div>
                {!p.active && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 99 }}>{t('Off', 'Off')}</span>}
              </div>
              <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.5, marginBottom: 12 }}>{p.desc[lang]}</div>
              {/* clienti associate — per etichetta o per nome */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                <Icon name="clients" size={14} color="var(--muted-2)" />
                {!(p.audTags || []).length && !(p.audClients || []).length
                  ? <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('Tutte le clienti', 'All clients')}</span>
                  : <React.Fragment>
                      {(p.audTags || []).map(tid => { const cat = clientCats.find(c => c.id === tid); return cat ? <span key={tid} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 99, background: 'color-mix(in srgb, ' + cat.color + ' 14%, transparent)', color: 'var(--ink-2)' }}><span style={{ width: 7, height: 7, borderRadius: 99, background: cat.color }} />{cat.name[lang]}</span> : null; })}
                      {(p.audClients || []).map(cid => client(cid) ? <span key={cid} style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 99, background: 'var(--paper-2)', color: 'var(--ink-2)' }}>{client(cid).name}</span> : null)}
                    </React.Fragment>}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px' }}><div className="t-meta" style={{ fontSize: 9.5, marginBottom: 3 }}>{t('Traguardo', 'Threshold')}</div><div className="t-num" style={{ fontSize: 17 }}>{p.threshold} {p.type === 'points' ? t('pt', 'pt') : t('timbri', 'stamps')}</div></div>
                <div style={{ flex: 1.4, background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px' }}><div className="t-meta" style={{ fontSize: 9.5, marginBottom: 3 }}>{t('Premio', 'Reward')}</div><div style={{ fontWeight: 700, fontSize: 14 }}>{p.reward[lang]}</div></div>
              </div>
              <div className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, paddingTop: 11, borderTop: '1px solid var(--hair)', color: 'var(--muted)' }}>
                <Icon name="coupon" size={13} color="var(--clay-ink)" />{t('Al riscatto → genera un coupon (origine “Fedeltà”)', 'On redemption → generates a coupon (origin “Loyalty”)')}
              </div>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="star" title={t('Nessun programma', 'No programs')} sub={t('Crea il primo percorso fedeltà.', 'Create your first loyalty path.')} action={t('Nuovo programma', 'New program')} onAction={() => setEdit(blank())} />}
      {edit && <LoyaltyEditModal draft={edit} setDraft={setEdit} onSave={save} onDelete={del} onClose={() => setEdit(null)} t={t} lang={lang} />}
    </React.Fragment>
  );
}

function LoyaltyEditModal({ draft, setDraft, onSave, onDelete, onClose, t, lang }) {
  const { clientCats } = useDk();
  const [cq, setCq] = useStateFe('');
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setL = (key, v) => setDraft(d => ({ ...d, [key]: { ...d[key], [lang]: v } }));
  const canSave = (draft.name[lang] || '').trim() && (draft.reward[lang] || '').trim();
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%' };
  const numCss = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)' };
  const isPts = draft.type === 'points';
  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Nuovo programma fedeltà', 'New loyalty program') : t('Modifica programma', 'Edit program')} sub={t('Regole di accumulo e premio', 'Earning rules and reward')} width={820}
      foot={<React.Fragment>
        {!draft._new && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={() => onDelete(draft.id)}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => canSave && onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>
      <input value={draft.name[lang] || ''} onChange={e => setL('name', e.target.value)} placeholder={t('Nome programma', 'Program name')} style={{ border: 'none', borderBottom: '2px solid var(--hair)', outline: 'none', fontSize: 20, fontWeight: 700, fontFamily: 'var(--serif)', padding: '6px 0', background: 'transparent', width: '100%', marginBottom: 16 }} />
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Tipo di programma', 'Program type')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
        {[['points', t('A punti', 'Points'), 'star', t('Punti per € speso, visita o servizio', 'Points per € spent, visit or service')], ['stamps', t('A timbri', 'Stamps'), 'check', t('Un timbro per visita/servizio', 'A stamp per visit/service')], ['tiers', t('A livelli', 'Tiers'), 'sparkle', t('Silver / Gold / Platinum con vantaggi crescenti', 'Silver / Gold / Platinum with rising perks')], ['membership', t('Membership', 'Membership'), 'heart', t('Quota periodica con vantaggi riservati', 'Recurring fee with member perks')]].map(([k, l, ic, hint]) => {
          const on = draft.type === k;
          return (
            <button key={k} onClick={() => set({ type: k })} style={{ textAlign: 'left', padding: '13px', borderRadius: 12, cursor: 'pointer', border: '1.5px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)' }}>
              <Icon name={ic} size={19} color={on ? 'var(--clay-ink)' : 'var(--muted)'} />
              <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 6 }}>{l}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>{hint}</div>
            </button>
          );
        })}
      </div>

      {/* points earn basis */}
      {isPts && (
        <div style={{ marginBottom: 16 }}>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('I punti si accumulano per', 'Points are earned per')}</div>
          <div style={{ display: 'flex', gap: 7, marginBottom: 10 }}>
            {[['spend', t('€ speso', '€ spent')], ['visit', t('Visita', 'Visit')], ['service', t('Servizio', 'Service')]].map(([k, l]) => { const on = (draft.earnBasis || 'spend') === k; return (
              <button key={k} onClick={() => set({ earnBasis: k })} style={{ flex: 1, padding: '9px', borderRadius: 9, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{l}</button>
            ); })}
          </div>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Validi su', 'Valid on')}</div>
          <div style={{ display: 'flex', gap: 7 }}>
            {[['both', t('Servizi e prodotti', 'Services & products')], ['services', t('Solo servizi', 'Services only')], ['products', t('Solo prodotti', 'Products only')]].map(([k, l]) => { const on = (draft.earnOn || 'both') === k; return (
              <button key={k} onClick={() => set({ earnOn: k })} style={{ flex: 1, padding: '9px', borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>
            ); })}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isPts && (draft.earnBasis || 'spend') === 'spend' ? '1fr 1fr' : '1fr', gap: 12, marginBottom: 16 }}>
        {isPts && (draft.earnBasis || 'spend') === 'spend' && <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Punti per €1', 'Points per €1')}</div><div style={numCss}><input type="number" value={draft.earn} onChange={e => set({ earn: Math.max(0, parseInt(e.target.value) || 0) })} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 60 }} /><span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>pt/€</span></div></div>}
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{draft.type === 'tiers' ? t('Soglia primo livello', 'First tier threshold') : draft.type === 'membership' ? t('Soglia vantaggio', 'Perk threshold') : isPts ? t('Punti per il premio', 'Points for reward') : t('Timbri per il premio', 'Stamps for reward')}</div><div style={numCss}><input type="number" value={draft.threshold} onChange={e => set({ threshold: Math.max(1, parseInt(e.target.value) || 1) })} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 70 }} /><span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>{isPts || draft.type === 'tiers' || draft.type === 'membership' ? 'pt' : t('timbri', 'stamps')}</span></div></div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('Tipo di premio', 'Reward type')}</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {REWARD_KINDS.map(rk => { const on = (draft.rewardKind || 'amount') === rk.k; return (
            <button key={rk.k} onClick={() => { const nv = draft.rewardValue || 10; set({ rewardKind: rk.k, reward: { it: composeReward(rk.k, nv, draft.reward.it, 'it'), en: composeReward(rk.k, nv, draft.reward.en, 'en') } }); }} style={{ flex: 1, padding: '9px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{rk[lang]}</button>
          ); })}
        </div>
        {((draft.rewardKind || 'amount') === 'service' || (draft.rewardKind || 'amount') === 'product') ? (
          <input value={draft.reward[lang] || ''} onChange={e => setL('reward', e.target.value)} placeholder={(draft.rewardKind === 'product') ? t('es. Smalto a casa', 'e.g. Take-home polish') : t('es. Manicure gratis', 'e.g. Free manicure')} style={inputCss} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={numCss}>
              {(draft.rewardKind || 'amount') === 'amount' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>}
              <input type="number" value={draft.rewardValue || 0} onChange={e => { const nv = Math.max(0, parseInt(e.target.value) || 0); set({ rewardValue: nv, reward: { it: composeReward(draft.rewardKind || 'amount', nv, '', 'it'), en: composeReward(draft.rewardKind || 'amount', nv, '', 'en') } }); }} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 64 }} />
              {(draft.rewardKind || 'amount') === 'percent' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>}
            </div>
            <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Mostrato come', 'Shown as')}: <b style={{ color: 'var(--clay-ink)' }}>{draft.reward[lang] || composeReward(draft.rewardKind || 'amount', draft.rewardValue, '', lang)}</b></div>
          </div>
        )}
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="coupon" size={12} color="var(--muted-2)" />{t('Al riscatto, il premio genera un coupon con origine “Fedeltà”.', 'On redemption, the reward generates a coupon with origin “Loyalty”.')}</div>
      </div>

      {/* presentazione visiva — configurabile dal salone */}
      <div style={{ padding: '16px', background: 'var(--surface-2)', borderRadius: 12, marginBottom: 16 }}>
        <div className="t-meta" style={{ marginBottom: 3 }}>{t('Presentazione visiva', 'Visual presentation')}</div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 13 }}>{t('Come appare la tessera fedeltà alla cliente.', 'How the loyalty card looks to the client.')}</div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 7 }}>{t('Colore', 'Colour')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 34, height: 34, borderRadius: 9, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: draft.color || LOYALTY_COLORS[0] }}>
                <input type="color" value={draft.color || LOYALTY_COLORS[0]} onChange={e => set({ color: e.target.value })} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
              </label>
              <window.HexInput value={draft.color || LOYALTY_COLORS[0]} onChange={c => set({ color: c })} width={70} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 280 }}>
              {(window.GD_PALETTE || []).map((row, ri) => (
                <div key={ri} style={{ display: 'flex', gap: 3 }}>
                  {row.map(c => { const on = (draft.color || '').toLowerCase() === c.toLowerCase(); return (
                    <button key={c} onClick={() => set({ color: c })} title={c} style={{ width: 22, height: 22, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid ' + (c.toUpperCase() === '#FFFFFF' ? 'var(--hair)' : 'transparent'), outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1, flexShrink: 0 }} />
                  ); })}
                </div>
              ))}
            </div>
          </div>
          {/* live preview */}
          <div style={{ width: 210, flexShrink: 0 }}>
            <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 7 }}>{t('Anteprima', 'Preview')}</div>
            <div style={{ borderRadius: 14, padding: 16, color: '#fff', background: 'linear-gradient(135deg, ' + (draft.color || LOYALTY_COLORS[0]) + ', color-mix(in srgb, ' + (draft.color || LOYALTY_COLORS[0]) + ' 70%, #000))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <Icon name="star" size={20} color="#fff" />
                <span style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{draft.name[lang] || t('Programma fedeltà', 'Loyalty program')}</span>
              </div>
              <div style={{ height: 6, borderRadius: 99, background: 'rgba(255,255,255,0.3)', overflow: 'hidden', marginBottom: 8 }}><div style={{ height: '100%', width: '60%', background: '#fff', borderRadius: 99 }} /></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, opacity: 0.9 }}>
                <span>{Math.round((draft.threshold || 100) * 0.6)}/{draft.threshold || 100} {isPts ? 'pt' : t('timbri', 'stamps')}</span>
                <span style={{ fontWeight: 700 }}>{draft.reward[lang] || composeReward(draft.rewardKind || 'amount', draft.rewardValue, '', lang)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* regole generali — copre le varie esigenze di mercato */}
      <div style={{ padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12, marginBottom: 16 }}>
        <div className="t-meta" style={{ marginBottom: 11 }}>{t('Regole generali', 'General rules')}</div>
        <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>{t('Iscrizione', 'Enrollment')}</div>
        <div style={{ display: 'flex', gap: 7, marginBottom: 13 }}>
          {[['auto', t('Automatica', 'Automatic')], ['optin', t('Su richiesta', 'Opt-in')], ['paid', t('A pagamento', 'Paid')]].map(([k, l]) => { const on = (draft.enroll || 'auto') === k; return (
            <button key={k} onClick={() => set({ enroll: k })} style={{ flex: 1, padding: '8px', borderRadius: 9, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{l}</button>
          ); })}
        </div>
        {(draft.enroll === 'paid') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 13 }}>
            <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Quota di iscrizione', 'Membership fee')}</span>
            <div style={{ ...numCss, height: 38 }}><span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span><input type="number" value={draft.fee || 0} onChange={e => set({ fee: Math.max(0, parseInt(e.target.value) || 0) })} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 15, fontWeight: 700, width: 56 }} /><span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('/anno', '/yr')}</span></div>
          </div>
        )}
        <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>{t('Scadenza punti', 'Points expiry')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 14 }}>
          {[['none', t('Mai', 'Never')], ['6m', t('6 mesi', '6 months')], ['12m', t('12 mesi', '12 months')], ['24m', t('24 mesi', '24 months')]].map(([k, l]) => { const on = (draft.expiry || 'none') === k; return (
            <button key={k} onClick={() => set({ expiry: k })} style={{ padding: '7px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>
          ); })}
        </div>
        <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>{t('Punti bonus', 'Bonus points')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {[['birthday', t('Compleanno', 'Birthday')], ['referral', t('Porta un’amica', 'Referral')], ['prebook', t('Pre-prenotazione', 'Pre-booking')], ['review', t('Recensione / social', 'Review / social')], ['doubleday', t('Giorni doppi punti', 'Double-point days')]].map(([k, l]) => { const on = (draft.bonus || []).includes(k); return (
            <button key={k} onClick={() => set({ bonus: on ? draft.bonus.filter(x => x !== k) : [...(draft.bonus || []), k] })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{on && <Icon name="check" size={12} color="var(--clay-ink)" />}{l}</button>
          ); })}
        </div>
      </div>

      <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Descrizione per il cliente', 'Description for the client')}</div><textarea value={draft.desc[lang] || ''} onChange={e => setL('desc', e.target.value)} rows={2} placeholder={t('Come funziona…', 'How it works…')} style={{ ...inputCss, resize: 'none', lineHeight: 1.45 }} /></div>

      {/* clienti associate — per etichetta o per nome */}
      <div style={{ marginTop: 16, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12 }}>
        <div className="t-meta" style={{ marginBottom: 3 }}>{t('Clienti associate', 'Enrolled clients')}</div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 11 }}>{t('Per etichetta o per nome. Nessuna selezione = tutte le clienti.', 'By tag or by name. No selection = all clients.')}</div>
        <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>{t('Per etichetta', 'By tag')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 13 }}>
          {clientCats.map(cat => { const on = (draft.audTags || []).includes(cat.id); return (
            <button key={cat.id} onClick={() => set({ audTags: on ? draft.audTags.filter(x => x !== cat.id) : [...(draft.audTags || []), cat.id] })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: cat.color }} />{cat.name[lang]}{on && <Icon name="check" size={12} color="var(--clay-ink)" />}
            </button>); })}
        </div>
        <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>{t('Per nome', 'By name')}</div>
        <div className="dk-search" style={{ width: '100%', marginBottom: 9, background: 'var(--surface)' }}>
          <Icon name="search" size={16} color="var(--muted-2)" />
          <input value={cq} onChange={e => setCq(e.target.value)} placeholder={t('Cerca una cliente…', 'Search a client…')} />
          {cq && <button onClick={() => setCq('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {CLIENTS.filter(c => !cq || c.name.toLowerCase().includes(cq.toLowerCase())).map(c => { const on = (draft.audClients || []).includes(c.id); return (
            <button key={c.id} onClick={() => set({ audClients: on ? draft.audClients.filter(x => x !== c.id) : [...(draft.audClients || []), c.id] })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{c.name}{on && <Icon name="check" size={12} color="#fff" />}</button>); })}
        </div>
        {((draft.audTags || []).length > 0 || (draft.audClients || []).length > 0) && (
          <button className="t-sm" onClick={() => set({ audTags: [], audClients: [] })} style={{ marginTop: 11, fontWeight: 600, color: 'var(--clay-ink)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, background: 'transparent' }}>{t('Azzera — valido per tutte le clienti', 'Clear — valid for all clients')}</button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12, marginTop: 16 }}>
        <div style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{t('Programma attivo', 'Program active')}</div>
        <Toggle on={draft.active} onChange={v => set({ active: v })} />
      </div>
    </DkModal>
  );
}

/* ---------- Gift card (prepagate: incasso anticipato da monitorare) ---------- */
function QrMini({ code, size = 54 }) {
  // pseudo-QR deterministico dal codice — segnaposto visivo
  const n = 11, cell = size / n;
  let s = 0; for (let i = 0; i < code.length; i++) s = (s * 31 + code.charCodeAt(i)) >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >> 16) & 1; };
  const inFinder = (r, c) => (r < 3 && c < 3) || (r < 3 && c > n - 4) || (r > n - 4 && c < 3);
  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (inFinder(r, c)) continue;
    if (rnd()) cells.push(<rect key={r + '-' + c} x={c * cell} y={r * cell} width={cell} height={cell} />);
  }
  const finder = (x, y) => (
    <g key={x + ',' + y}>
      <rect x={x} y={y} width={cell * 3} height={cell * 3} fill="none" stroke="currentColor" strokeWidth={cell * 0.7} />
      <rect x={x + cell} y={y + cell} width={cell} height={cell} />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={'0 0 ' + size + ' ' + size} style={{ color: 'var(--ink)', display: 'block' }} fill="currentColor" aria-hidden="true">
      {cells}{finder(0, 0)}{finder((n - 3) * cell, 0)}{finder(0, (n - 3) * cell)}
    </svg>
  );
}

const GC_STATUS = {
  active:   { it: 'Attiva',     en: 'Active',    c: 'var(--ok)',     bg: 'var(--ok-tint)' },
  redeemed: { it: 'Riscattata', en: 'Redeemed',  c: 'var(--muted)', bg: 'var(--paper-2)' },
  expired:  { it: 'Scaduta',    en: 'Expired',   c: 'var(--danger)',bg: 'var(--danger-tint)' },
};
function buildWhen(dateStr, timeStr, lang) {
  if (!dateStr) return { it: timeStr || '', en: timeStr || '' };
  const d = new Date(dateStr + 'T' + (timeStr || '09:00'));
  const days    = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
  const daysEn  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months  = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  const monthsEn= ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const tm = (timeStr || '09:00').slice(0, 5);
  return { it: `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} · ${tm}`, en: `${daysEn[d.getDay()]} ${d.getDate()} ${monthsEn[d.getMonth()]} · ${tm}` };
}

function GiftSub({ giftcards, setGiftcards, t, lang, fireToast }) {
  const [edit, setEdit] = useStateFe(null);
  const seq = useRefFe(800);
  const paid = giftcards.filter(g => g.payment.status === 'paid');
  const sold = paid.reduce((s, g) => s + g.value, 0);
  const redeemed = paid.reduce((s, g) => s + Math.min(g.used, g.value), 0);
  const outstanding = sold - redeemed;
  const dueCount = giftcards.filter(g => g.payment.status === 'due').length;
  const personName = (g, key) => key === 'buyer' ? (client(g.buyerId) ? client(g.buyerId).name : '—') : (g.recipId ? client(g.recipId).name : g.recipName || '—');
  const save = (d) => {
    const { _new, ...rest } = d;
    setGiftcards(l => _new ? [rest, ...l] : l.map(g => g.id === d.id ? rest : g));
    setEdit(null); fireToast({ msg: t('Gift card salvata', 'Gift card saved'), icon: 'check' });
  };
  const blank = () => ({ id: 'gc' + (seq.current++), code: 'TP-GC-' + Math.random().toString(36).slice(2, 6).toUpperCase(), value: 50, used: 0, buyerId: 'c1', recipId: null, recipName: '',
    payment: { status: 'paid', date: { it: 'Oggi', en: 'Today' }, method: { it: 'Carta', en: 'Card' } },
    delivery: { mode: 'hand', date: '', time: '09:00' }, expiry: { it: '6 mesi', en: '6 months' }, status: 'active', _new: true });
  return (
    <React.Fragment>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('Valore prepagato: il centro incassa subito e onora la card quando viene riscattata. Monitora qui il saldo ancora da onorare.', 'Prepaid value: the salon collects up front and honours the card when redeemed. Track the outstanding balance here.')}</div>

      {/* monitoraggio — venduto / riscattato / da riscattare */}
      <div className="dk-card" style={{ display: 'flex', alignItems: 'stretch', gap: 0, padding: '16px 6px', marginBottom: 18, boxShadow: 'none', border: '1px solid var(--hair)' }}>
        {[
          [t('Valore venduto', 'Sold value'), fmtEur(sold, lang), 'var(--ink)', t(paid.length + ' card pagate', paid.length + ' paid cards')],
          [t('Già riscattato', 'Already redeemed'), fmtEur(redeemed, lang), 'var(--muted)', t('valore consumato', 'value consumed')],
          [t('Da riscattare', 'Outstanding'), fmtEur(outstanding, lang), 'var(--clay-ink)', t('saldo da onorare', 'balance to honour')],
        ].map(([l, v, c, sub], i) => (
          <div key={i} style={{ flex: 1, padding: '2px 18px', borderLeft: i ? '1px solid var(--hair)' : 'none' }}>
            <div className="t-meta" style={{ marginBottom: 5 }}>{l}</div>
            <div className="t-num" style={{ fontSize: 24, color: c }}>{v}</div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2 }}>{sub}</div>
          </div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-end', gap: 8, padding: '0 14px 0 18px', borderLeft: '1px solid var(--hair)' }}>
          {dueCount > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '3px 10px', borderRadius: 99, whiteSpace: 'nowrap' }}>{dueCount} {t('da pagare', 'unpaid')}</span>}
          <button className="dk-btn dk-btn--clay" onClick={() => setEdit(blank())} style={{ whiteSpace: 'nowrap' }}><Icon name="plus" size={17} color="#fff" />{t('Nuova gift card', 'New gift card')}</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
        {giftcards.map(g => {
          const st = GC_STATUS[g.status] || GC_STATUS.active;
          const due = g.payment.status === 'due';
          const residual = g.value - g.used;
          return (
            <div key={g.id} className="dk-card" style={{ padding: 18, opacity: g.status === 'redeemed' || g.status === 'expired' ? 0.72 : 1, borderLeft: '3px solid ' + (due ? 'var(--warn)' : g.status === 'active' ? 'var(--clay)' : 'var(--faint)') }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <div style={{ flexShrink: 0, padding: 7, border: '1px solid var(--hair)', borderRadius: 10, background: '#fff' }}><QrMini code={g.code} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span className="t-num" style={{ fontSize: 24, color: 'var(--clay-ink)' }}>{fmtEur(g.value, lang)}</span>
                    {g.used > 0 && g.status === 'active' && <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('residuo', 'left')} <strong style={{ color: 'var(--ink)' }}>{fmtEur(residual, lang)}</strong></span>}
                  </div>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 6, display: 'inline-block', marginTop: 5 }}>{g.code}</span>
                  {/* acquirente → destinataria */}
                  <div className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, color: 'var(--ink-2)', flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="user" size={13} color="var(--muted-2)" /><span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('da', 'from')}</span> <strong>{personName(g, 'buyer')}</strong></span>
                    <Icon name="chevR" size={12} color="var(--muted-2)" />
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="gift" size={13} color="var(--muted-2)" /><span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('a', 'to')}</span> <strong>{personName(g, 'recip')}</strong></span>
                  </div>
                </div>
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 99, background: st.bg, color: st.c }}>{st[lang]}</span>
              </div>

              {/* pagamento + consegna — a colpo d'occhio */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                {due
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '5px 11px', borderRadius: 99 }}><Icon name="clock" size={13} color="var(--warn)" />{t('Da pagare', 'Payment due')}</span>
                  : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '5px 11px', borderRadius: 99, whiteSpace: 'nowrap' }}><Icon name="check" size={13} color="var(--ok)" stroke={2.4} />{t('Pagata', 'Paid')} · {g.payment.date[lang]} · {g.payment.method[lang]}</span>}
                {g.delivery.mode === 'scheduled'
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', background: 'var(--surface-2)', padding: '5px 11px', borderRadius: 99 }}><Icon name="send" size={13} color="var(--muted)" />{t('Consegna', 'Delivery')} · {g.delivery.when[lang]}</span>
                  : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', background: 'var(--surface-2)', padding: '5px 11px', borderRadius: 99 }}><Icon name="barcode" size={13} color="var(--muted)" />{t('Consegna a mano', 'Hand delivery')}</span>}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
                <span className="t-sm" style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="calendar" size={13} color="var(--muted-2)" />{g.status === 'redeemed' && g.redeemedOn ? t('Riscattata il ', 'Redeemed on ') + g.redeemedOn[lang] : t('Scade: ', 'Expires: ') + g.expiry[lang]}</span>
                {g.delivery.mode === 'hand' && g.status === 'active' && (
                  <button className="dk-btn dk-btn--ghost" style={{ marginLeft: 'auto', height: 32, fontSize: 12.5 }} onClick={() => fireToast({ msg: t('QR pronto per la stampa', 'QR ready to print'), icon: 'check' })}><Icon name="barcode" size={14} />{t('Stampa QR', 'Print QR')}</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {edit && <GiftCardModal draft={edit} setDraft={setEdit} onSave={save} onClose={() => setEdit(null)} t={t} lang={lang} />}
    </React.Fragment>
  );
}

function GiftCardModal({ draft, setDraft, onSave, onClose, t, lang }) {
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const canSave = draft.value > 0 && (draft.recipName || '').trim();
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%' };
  const paid = draft.payment.status === 'paid';
  const seg = (on) => ({ flex: 1, padding: '10px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' });
  return (
    <DkModal open onClose={onClose} title={t('Nuova gift card', 'New gift card')} sub={t('Valore prepagato: registra pagamento e consegna', 'Prepaid value: record payment and delivery')} width={540}
      foot={<React.Fragment>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => canSave && onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Valore', 'Value')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)' }}>
          <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
          <input type="number" value={draft.value} onChange={e => set({ value: Math.max(0, parseInt(e.target.value) || 0) })} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 70 }} />
        </div>
        {[25, 50, 75, 100].map(v => <button key={v} onClick={() => set({ value: v })} style={{ padding: '8px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (draft.value === v ? 'var(--clay)' : 'var(--hair)'), background: draft.value === v ? 'var(--clay-tint)' : 'var(--surface)', color: draft.value === v ? 'var(--clay-ink)' : 'var(--ink-2)' }}>€{v}</button>)}
        <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '4px 9px', borderRadius: 6 }}>{draft.code}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Acquirente (chi paga)', 'Buyer (who pays)')}</div>
          <select value={draft.buyerId} onChange={e => set({ buyerId: e.target.value })} style={{ ...inputCss, cursor: 'pointer' }}>{CLIENTS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </div>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Destinataria (chi riceve)', 'Recipient (who receives)')}</div>
          <input value={draft.recipName || ''} onChange={e => set({ recipName: e.target.value, recipId: null })} placeholder={t('Nome destinataria', 'Recipient name')} style={inputCss} />
        </div>
      </div>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Pagamento', 'Payment')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: paid ? 10 : 16 }}>
        <button style={seg(paid)} onClick={() => set({ payment: { status: 'paid', date: { it: 'Oggi', en: 'Today' }, method: draft.payment.method || { it: 'Carta', en: 'Card' } } })}>{t('Pagata ora', 'Paid now')}</button>
        <button style={seg(!paid)} onClick={() => set({ payment: { status: 'due' } })}>{t('Da pagare', 'Payment due')}</button>
      </div>
      {paid && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {[['Carta', 'Card'], ['Contanti', 'Cash'], ['Link di pagamento', 'Payment link']].map(([it_, en_]) => {
            const on = (draft.payment.method && draft.payment.method.it) === it_;
            return <button key={it_} onClick={() => set({ payment: { ...draft.payment, method: { it: it_, en: en_ } } })} style={{ padding: '8px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{lang === 'en' ? en_ : it_}</button>;
          })}
        </div>
      )}
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Consegna', 'Delivery')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: draft.delivery.mode === 'scheduled' ? 10 : 16 }}>
        <button style={seg(draft.delivery.mode === 'hand')} onClick={() => set({ delivery: { mode: 'hand' } })}>{t('A mano · stampa QR', 'By hand · print QR')}</button>
        <button style={seg(draft.delivery.mode === 'scheduled')} onClick={() => set({ delivery: { mode: 'scheduled', when: draft.delivery.when || { it: '', en: '' } } })}>{t('Programmata', 'Scheduled')}</button>
      </div>
      {draft.delivery.mode === 'scheduled' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, marginBottom: 16 }}>
          <input type="date" value={(draft.delivery.date) || ''}
            onChange={e => set({ delivery: { mode: 'scheduled', date: e.target.value, time: draft.delivery.time || '09:00', when: buildWhen(e.target.value, draft.delivery.time || '09:00', lang) } })}
            style={{ border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%' }} />
          <input type="time" value={(draft.delivery.time) || '09:00'}
            onChange={e => set({ delivery: { mode: 'scheduled', date: draft.delivery.date || '', time: e.target.value, when: buildWhen(draft.delivery.date || '', e.target.value, lang) } })}
            style={{ border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: 110 }} />
        </div>
      )}
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Scadenza', 'Expiry')}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        {[[3, '3 mesi', '3 months'], [6, '6 mesi', '6 months'], [12, '12 mesi', '12 months']].map(([m, it_, en_]) => {
          const on = draft.expiry.it === it_;
          return <button key={m} onClick={() => set({ expiry: { it: it_, en: en_ } })} style={{ padding: '8px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{lang === 'en' ? en_ : it_}</button>;
        })}
      </div>
    </DkModal>
  );
}

function DkGiftCard() {
  const { t, lang, fireToast, giftcards, setGiftcards } = useDk();
  return <GiftCardSub t={t} lang={lang} fireToast={fireToast} giftcards={giftcards} setGiftcards={setGiftcards} />;
}
Object.assign(window, { DkFedelta, DkGiftCard, couponValue, couponScope });
