// desktop-clienti.jsx — master-detail: list + full profile (levels, notes, vouchers)
const { useState: useStateDc, useRef: useRefDc } = React;

const DK_HIST = {
  c1: [['24 ott', '24 Oct', 'sole', ['s2', 's3'], 85, 20, 'carta'], ['2 ott', '2 Oct', 'sole', ['s1'], 35, 0, 'contanti'], ['11 set', '11 Sep', 'giulia', ['s4'], 40, 0, 'carta'], ['21 ago', '21 Aug', 'sole', ['s2'], 65, 20, 'carta']],
};
function dkHist(c) {
  if (DK_HIST[c.id]) return DK_HIST[c.id];
  if (c.visits === 0) return [];
  if (c.techType === 'hair') return [['18 ott', '18 Oct', 'mara', ['s6', 's5'], 60, 0, 'carta'], ['20 set', '20 Sep', 'asia', ['s7'], 78, 20, 'carta'], ['30 ago', '30 Aug', 'mara', ['s6'], 32, 0, 'contanti']];
  if (c.techType === 'viso') return [['15 ott', '15 Oct', 'lina', ['s11'], 80, 20, 'carta'], ['12 set', '12 Sep', 'lina', ['s10'], 55, 0, 'contanti']];
  return [['16 ott', '16 Oct', 'giulia', ['s1'], 35, 0, 'contanti'], ['18 set', '18 Sep', 'sole', ['s2'], 65, 20, 'carta']];
}
// internal cost/margin estimate — removed per policy: no salon cost/margin shown in the dashboard

/* ---------- Level labels (anzianità · attività · valore) ---------- */
// lower rank = higher priority in the compact list view
function clientLevels(c, t) {
  const L = [];
  const sy = parseInt(c.since) || 2023;
  // valore / relazione
  if (c.segment === 'vip') L.push({ key: 'vip', label: t('VIP', 'VIP'), color: '#B08D57', icon: 'star', rank: 1 });
  if (c.segment === 'fedele' || (c.value >= 1500 && c.segment !== 'vip')) L.push({ key: 'fedele', label: t('Fedele', 'Loyal'), color: 'var(--ok)', rank: 5 });
  // attività / frequenza
  if (c.segment === 'dormiente') L.push({ key: 'dormiente', label: t('Dormiente', 'Dormant'), color: 'var(--muted-2)', icon: 'moon', rank: 2 });
  else if (c.noshow >= 2 || c.latecancel >= 2) L.push({ key: 'rischio', label: t('A rischio', 'At risk'), color: 'var(--warn)', icon: 'alert', rank: 2 });
  else if (c.segment === 'vip' || c.segment === 'fedele' || c.visits >= 20) L.push({ key: 'attivo', label: t('Attivo', 'Active'), color: '#3F7A52', rank: 6 });
  else L.push({ key: 'regolare', label: t('Regolare', 'Regular'), color: 'var(--muted)', rank: 7 });
  // anzianità
  if (c.segment === 'nuovo' || c.visits <= 3 || sy >= 2025) L.push({ key: 'nuovo', label: t('Nuovo', 'New'), color: 'var(--info)', rank: 4 });
  else if (sy <= 2022) L.push({ key: 'storico', label: t('Storico', 'Long-time'), color: 'var(--ok)', rank: 5 });
  return L;
}
function LevelBadge({ lv, sm }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: sm ? 10.5 : 11.5, fontWeight: 700, color: lv.color, background: `color-mix(in srgb, ${lv.color} 14%, transparent)`, padding: sm ? '2px 8px' : '4px 10px', borderRadius: 99, whiteSpace: 'nowrap' }}>
      {lv.icon && <Icon name={lv.icon} size={sm ? 10 : 12} color={lv.color} stroke={2} />}{lv.label}
    </span>
  );
}

/* ---------- Notes & vouchers seeds ---------- */
function seedNotes(c) {
  if (c._manual) return c._initialNote ? [{ id: 'n1', text: { it: c._initialNote, en: c._initialNote }, ai: false, by: 'SC', when: { it: 'Oggi', en: 'Today' } }] : [];
  const first = c.techType === 'hair'
    ? { it: 'Formula colore 6.0 + 6.3, posa 35 min. Cute sensibile, niente ammoniaca forte.', en: 'Colour formula 6.0 + 6.3, 35 min. Sensitive scalp, avoid strong ammonia.' }
    : c.techType === 'viso'
      ? { it: 'Pelle mista con couperose. Usare acido ialuronico, evitare scrub aggressivi.', en: 'Combination skin with couperose. Use hyaluronic acid, avoid harsh scrubs.' }
      : { it: 'Preferisce forma a mandorla e colori nude. Allergia al lattice → guanti in nitrile.', en: 'Prefers almond shape and nude colours. Latex allergy → nitrile gloves.' };
  return [
    { id: 'n1', text: first, ai: true, by: 'Sole', when: { it: '2 ott', en: '2 Oct' } },
    { id: 'n2', text: { it: 'Ha accennato a un evento a dicembre, valutare un pacchetto dedicato.', en: 'Mentioned an event in December — consider a dedicated package.' }, ai: false, by: 'Sole', when: { it: '24 ott', en: '24 Oct' } },
  ];
}
function dkClientNotes(c) {
  window.__clientNotes = window.__clientNotes || {};
  if (!window.__clientNotes[c.id]) window.__clientNotes[c.id] = seedNotes(c);
  return window.__clientNotes[c.id];
}
function seedVouchers(c) {
  if (c.segment === 'vip' || c.segment === 'fedele') return [
    { id: 'vc0', code: 'PUNTI10', desc: { it: 'Buono fedeltà €10', en: '€10 loyalty reward' }, kind: 'amount', amount: 10, services: [], exp: { it: 'Scade 10 gen 2026', en: 'Expires 10 Jan 2026' }, used: false, origin: 'loyalty' },
    { id: 'vc1', code: 'GRAZIE20', desc: { it: 'Sconto fedeltà', en: 'Loyalty discount' }, kind: 'percent', amount: 20, services: [], exp: { it: 'Scade 31 dic 2025', en: 'Expires 31 Dec 2025' }, used: false, origin: 'manual' },
    { id: 'vc2', code: 'NAILGIFT', desc: { it: 'Nail art in omaggio', en: 'Free nail art' }, kind: 'gift', amount: 0, giftText: { it: 'Nail art', en: 'Nail art' }, services: ['s3'], exp: { it: 'Usato il 2 ott', en: 'Used 2 Oct' }, used: true, origin: 'manual' },
  ];
  if (c.segment === 'nuovo') return [
    { id: 'vc1', code: 'BENVENUTA', desc: { it: 'Sconto prima visita', en: 'First-visit discount' }, kind: 'percent', amount: 10, services: [], exp: { it: 'Scade 30 nov 2025', en: 'Expires 30 Nov 2025' }, used: false, origin: 'auto' },
  ];
  if (c.segment === 'dormiente') return [
    { id: 'vc1', code: 'TORNADANOI', desc: { it: 'Ti aspettiamo', en: 'Come back to us' }, kind: 'percent', amount: 15, services: [], exp: { it: 'Scade 15 dic 2025', en: 'Expires 15 Dec 2025' }, used: false, origin: 'auto' },
  ];
  return [];
}
function voucherValue(v, lang) {
  if (v.kind === 'gift') return (v.giftText && (v.giftText[lang] || v.giftText.it)) || (lang === 'en' ? 'Gift' : 'Omaggio');
  if (v.kind === 'amount') return '-' + fmtEur(v.amount, lang);
  return '-' + v.amount + '%';
}
function voucherScope(v, t, lang) {
  if (!v.services || !v.services.length) return t('Tutti i servizi', 'All services');
  return v.services.map(id => svc(id) ? svcName(svc(id), lang) : '').filter(Boolean).join(', ');
}
/* ---------- Gift card seeds ---------- */
function seedGifts(c) {
  if (c.segment === 'vip') return [
    { id: 'g1', code: 'GIFT-7D2K', value: 50, role: 'dest', other: 'Marta R.', exp: { it: 'Scade 28 feb 2026', en: 'Expires 28 Feb 2026' }, used: false },
    { id: 'g2', code: 'GIFT-K91A', value: 25, role: 'buyer', other: 'Sara L.', exp: { it: 'Usata il 12 set', en: 'Used 12 Sep' }, used: true },
  ];
  if (c.segment === 'fedele') return [
    { id: 'g1', code: 'GIFT-M44P', value: 30, role: 'dest', other: 'Giulia T.', exp: { it: 'Scade 31 gen 2026', en: 'Expires 31 Jan 2026' }, used: false },
  ];
  return [];
}
function QrGlyph({ code, size = 44 }) {
  let h = 0; for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  const cells = [];
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) { h = (h * 1103515245 + 12345) >>> 0; if ((h >> 16) % 5 < 2 || (x < 2 && y < 2) || (x > 4 && y < 2) || (x < 2 && y > 4)) cells.push([x, y]); }
  const u = size / 7;
  return (
    <svg width={size} height={size} style={{ display: 'block', borderRadius: 6, background: '#fff', border: '1px solid var(--hair)' }} aria-hidden="true">
      {cells.map(([x, y], i) => <rect key={i} x={x * u + 1.5} y={y * u + 1.5} width={u - 3} height={u - 3} rx={1} fill="var(--ink)" />)}
    </svg>
  );
}

const noteText = (n, lang) => (typeof n.text === 'string' ? n.text : (n.text[lang] || n.text.it));

// resolve a client's category tags: explicit assignment (set in profile) wins,
// otherwise a deterministic default spread across the category catalog.
function dkClientTags(c, clientCats) {
  const a = window.__clientLabels && window.__clientLabels[c.id];
  if (a && a.length) return a;
  if (c.segment === 'vip' && clientCats.some(cc => cc.id === 'vip')) return ['vip'];
  const pool = clientCats.map(cc => cc.id).filter(id => id !== 'vip');
  if (!pool.length) return [];
  const h = (c.id || '').split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return [pool[h % pool.length]];
}

function DkClienti() {
  const { t, lang, selClient, setSelClient, fireToast, search, setSearch, clientCats } = useDk();
  const [seg, setSeg] = useStateDc('all');
  const [relFilt, setRelFilt] = useStateDc('all');
  const [newOpen, setNewOpen] = useStateDc(false);
  const [bulkOpen, setBulkOpen] = useStateDc(false);
  const q = search;
  const segs = [['all', t('Tutti', 'All')], ['__active', t('Attivi', 'Active')], ...clientCats.map(cc => [cc.id, cc.name[lang] || cc.name.it])];
  const relScore = (c) => Math.max(0, 100 - c.noshow * 18 - c.latecancel * 6);
  const segMatch = (c) => {
    if (relFilt !== 'all') {
      const s = relScore(c);
      if (relFilt === 'good' && s < 85) return false;
      if (relFilt === 'watch' && (s < 60 || s >= 85)) return false;
      if (relFilt === 'risk' && s >= 60) return false;
    }
    if (seg === 'all') return true;
    if (seg === '__active') return c.segment !== 'dormiente';
    if (clientCats.some(cc => cc.id === seg)) return dkClientTags(c, clientCats).includes(seg);
    if (['vip', 'fedele', 'nuovo', 'dormiente'].includes(seg)) return c.segment === seg;
    return clientLevels(c, t).some(lv => lv.key === seg);
  };
  const list = CLIENTS.filter(c => segMatch(c) && c.name.toLowerCase().includes(q.toLowerCase())).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const c = client(selClient);
  const activeLabel = (segs.find(s => s[0] === seg) || segs[0])[1];
  const countOf = (key) => key === '__active'
    ? CLIENTS.filter(cl => cl.segment !== 'dormiente').length
    : CLIENTS.filter(cl => dkClientTags(cl, clientCats).includes(key)).length;
  const catCards = [
    { key: '__active', label: t('Attivi', 'Active'), color: '#C2E8CB' },
    ...clientCats.map(cc => ({ key: cc.id, label: cc.name[lang] || cc.name.it, color: cc.color })),
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* category summary cards — driven by the client category catalog (+ always-on Attivi) */}
      <div className="scroll" style={{ display: 'flex', gap: 12, padding: '20px 24px 4px', overflowX: 'auto' }}>
        {catCards.map(cc => {
          const on = seg === cc.key;
          return (
            <button key={cc.key} onClick={() => setSeg(on ? 'all' : cc.key)} style={{ width: 150, flexShrink: 0, textAlign: 'left', cursor: 'pointer', background: '#fff', border: '1px solid ' + (on ? cc.color : 'var(--hair)'), borderRadius: 16, padding: '14px 16px', boxShadow: 'var(--sh-sm)', position: 'relative', overflow: 'hidden' }}>
              <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: cc.color }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 99, background: cc.color }} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cc.label}</span>
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--ink)', marginTop: 6 }}>{countOf(cc.key)}</div>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* list */}
      <div style={{ width: 360, flexShrink: 0, borderRight: '1px solid var(--hair)', display: 'flex', flexDirection: 'column', background: 'var(--paper)' }}>
        <div style={{ padding: '18px 20px 12px' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="dk-search" style={{ flex: 1, width: 'auto' }}>
              <Icon name="search" size={18} color="var(--muted-2)" />
              <input value={q} onChange={e => setSearch(e.target.value)} placeholder={t('Cerca cliente…', 'Search client…')} />
              {q && <button onClick={() => setSearch('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
            </div>
            <GroupedFilterMenu t={t} groups={[
              { label: t('Categoria', 'Category'), value: seg, set: setSeg, opts: segs },
              { label: t('Affidabilità', 'Reliability'), value: relFilt, set: setRelFilt, opts: [['all', t('Tutte', 'All')], ['good', t('Ottima', 'Excellent')], ['watch', t('Da seguire', 'Watch')], ['risk', t('A rischio', 'At risk')]] },
            ]} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
            <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{list.length} {t('clienti', 'clients')}{seg !== 'all' ? ' · ' + activeLabel : ''}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {(seg !== 'all' || relFilt !== 'all') && <button onClick={() => { setSeg('all'); setRelFilt('all'); }} style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)' }}>{t('Azzera', 'Clear')}</button>}
              <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 11px' }} onClick={() => setBulkOpen(true)}><Icon name="arrowDn" size={15} />{t('Importa', 'Import')}</button>
              <button className="dk-btn dk-btn--clay" style={{ height: 34, fontSize: 12.5, padding: '0 13px' }} onClick={() => setNewOpen(true)}><Icon name="plus" size={15} color="#fff" />{t('Nuovo cliente', 'New client')}</button>
            </div>
          </div>
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 12px 16px' }}>
          {list.map(cl => {
            const on = cl.id === selClient;
            const badges = clientLevels(cl, t).sort((a, b) => a.rank - b.rank).slice(0, 2);
            return (
              <button key={cl.id} className="dk-row" onClick={() => setSelClient(cl.id)} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '11px 12px', borderRadius: 12, width: '100%', textAlign: 'left', background: on ? 'var(--surface)' : 'transparent', boxShadow: on ? 'var(--sh-sm)' : 'none', marginBottom: 2 }}>
                <Avatar initials={cl.initials} size={42} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 14.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cl.name}</span>
                    {cl.depositAlways && <Icon name="coupon" size={13} color="var(--warn)" />}
                  </div>
                  <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{cl.visits} {t('visite', 'visits')} · {fmtEur(cl.value, lang)}</div>
                  <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>{badges.map(lv => <LevelBadge key={lv.key} lv={lv} sm />)}</div>
                </div>
              </button>
            );
          })}
          {!list.length && <div style={{ padding: '30px 12px' }}><EmptyState icon="search" title={t('Nessun cliente', 'No clients')} sub={t('Prova un altro filtro o nome.', 'Try another filter or name.')} /></div>}
        </div>
      </div>

      {/* detail */}
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', minWidth: 0, padding: '20px 24px 24px', background: 'var(--paper)' }}>
        {c ? <div className="dk-card" style={{ background: '#fff', borderRadius: 18, border: '1px solid var(--hair)', boxShadow: 'var(--sh-card)', minHeight: 'calc(100% - 0px)' }}><DkClientProfile key={c.id} c={c} t={t} lang={lang} fireToast={fireToast} /></div> : <EmptyState icon="clients" title={t('Seleziona un cliente', 'Select a client')} />}
      </div>
      </div>
      {newOpen && <NewClientModal onClose={() => setNewOpen(false)} onCreate={(nc) => { CLIENTS.unshift(nc); setNewOpen(false); setSelClient(nc.id); setSeg('all'); fireToast({ msg: t(`Cliente ${nc.name} creato`, `Client ${nc.name} created`), icon: 'check' }); }} t={t} lang={lang} />}
      {bulkOpen && <BulkClientImport onClose={() => setBulkOpen(false)} t={t} lang={lang} fireToast={fireToast} />}
    </div>
  );
}

/* ---------- New client modal (manual entry) ---------- */
const NCField = ({ label, children, hint }) => (
  <div>
    <div className="t-meta" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>{label}{hint && <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--muted-2)' }}>{hint}</span>}</div>
    {children}
  </div>
);
function BulkClientImport({ onClose, t, lang, fireToast }) {
  const [text, setText] = useStateDc('');
  const fileRef = useRefDc(null);
  const parse = (raw) => {
    const rows = String(raw).split(/\r?\n/).map(r => r.trim()).filter(Boolean);
    if (!rows.length) return [];
    const delim = (rows[0].match(/;/g) || []).length > (rows[0].match(/,/g) || []).length ? ';' : ',';
    let start = 0;
    if (/nome|name|email|tel|phone/i.test(rows[0])) start = 1;
    const out = [];
    for (let i = start; i < rows.length; i++) {
      const cols = rows[i].split(delim).map(c => c.trim().replace(/^"(.*)"$/, '$1'));
      const name = cols[0]; if (!name) continue;
      const email = (cols[1] || '').trim();
      const phone = (cols[2] || '').trim();
      const existing = CLIENTS.find(c => c.name.toLowerCase() === name.toLowerCase());
      out.push({ name, email, phone, existing: !!existing, existingId: existing ? existing.id : null });
    }
    return out;
  };
  const rows = parse(text);
  const toUpdate = rows.filter(r => r.existing).length;
  const toCreate = rows.length - toUpdate;
  const onFile = (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => setText(r.result); r.readAsText(f); e.target.value = ''; };
  const apply = () => {
    let created = 0, updated = 0;
    rows.forEach(r => {
      if (r.existing) {
        const c = client(r.existingId);
        if (c) { if (r.email) c.email = r.email; if (r.phone) { c.phone = r.phone; c.phoneWa = r.phone; c.wa = true; } updated++; }
      } else {
        const initials = r.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
        CLIENTS.unshift({ id: 'c' + Date.now() + Math.round(Math.random() * 1e4), name: r.name, initials, phone: r.phone, phoneWa: r.phone, wa: !!r.phone, email: r.email, segment: 'nuovo', visits: 0, value: 0, noshow: 0, latecancel: 0, lang: 'it', birthday: '', _manual: true });
        created++;
      }
    });
    fireToast({ msg: t(`Importati ${created} nuovi · ${updated} aggiornati`, `${created} added · ${updated} updated`), icon: 'check' });
    onClose();
  };
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' };
  return (
    <DkModal open onClose={onClose} title={t('Importa clienti in massa', 'Bulk import clients')} sub={t('Aggiungi o aggiorna nome, email e telefono da un elenco', 'Add or update name, email and phone from a list')} width={620}
      foot={<React.Fragment>
        <span className="t-sm" style={{ marginRight: 'auto', color: 'var(--muted)' }}>{rows.length > 0 ? t(`${toCreate} nuovi · ${toUpdate} da aggiornare`, `${toCreate} new · ${toUpdate} to update`) : ''}</span>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!rows.length} onClick={apply}><Icon name="check" size={17} color="#fff" />{t('Importa', 'Import')} {rows.length || ''}</button>
      </React.Fragment>}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button className="dk-btn dk-btn--ghost" onClick={() => fileRef.current && fileRef.current.click()}><Icon name="arrowDn" size={15} />{t('Carica file CSV', 'Upload CSV file')}</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'none' }} />
        <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('oppure incolla qui sotto', 'or paste below')}</span>
      </div>
      <div className="t-meta" style={{ marginBottom: 6 }}>{t('Formato', 'Format')}: <span style={{ fontFamily: 'var(--mono, monospace)', textTransform: 'none', letterSpacing: 0 }}>{t('Nome, Email, Telefono', 'Name, Email, Phone')}</span></div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={7} placeholder={"Sofia Ricci, sofia@email.it, +39 348 221 0094\nGiada Neri, giada@email.it, +39 333 118 4420"} style={{ ...inputCss, fontFamily: 'var(--mono, monospace)', resize: 'vertical' }} />
      <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>{t('I clienti già esistenti (stesso nome) ricevono solo l’aggiornamento di email e telefono — i nuovi vengono creati.', 'Existing clients (same name) only get email and phone updated — new ones are created.')}</div>
      {rows.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Anteprima', 'Preview')} · {rows.length}</div>
          <div className="dk-card" style={{ overflow: 'hidden', maxHeight: 200, overflowY: 'auto' }}>
            {rows.slice(0, 40).map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span className="t-sm" style={{ flex: 1, minWidth: 0, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email || '—'}</span>
                <span className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.phone || '—'}</span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: r.existing ? 'var(--warn)' : 'var(--ok)', background: r.existing ? 'var(--warn-tint)' : 'var(--ok-tint)', padding: '2px 8px', borderRadius: 99, flexShrink: 0 }}>{r.existing ? t('aggiorna', 'update') : t('nuovo', 'new')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </DkModal>
  );
}

function NewClientModal({ onClose, onCreate, t, lang }) {
  const { clientCats, waitList, setWaitList } = useDk();
  const [f, setF] = useStateDc({ first: '', last: '', phoneWa: '', phone: '', email: '', birthday: '', privacy: true, marketing: false, whatsapp: false, tags: [], note: '', lang: 'it', addToWaitlist: false, wlServices: [], wlPrefTime: 'any' });
  const set = (k, v) => setF(o => ({ ...o, [k]: v }));
  const canSave = f.first.trim() && f.last.trim() && (f.phoneWa.trim() || f.phone.trim());
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box' };
  const Field = NCField;
  const save = () => {
    const name = f.first.trim() + ' ' + f.last.trim();
    const initials = (f.first.trim()[0] + (f.last.trim()[0] || '')).toUpperCase();
    const id = 'c' + Date.now();
    window.__clientLabels = window.__clientLabels || {};
    window.__clientLabels[id] = [...f.tags];
    const newClient = {
      id, name, initials, visits: 0, value: 0, segment: 'nuovo', since: '2025',
      origin: { it: 'Inserimento manuale', en: 'Manual entry' }, noshow: 0, latecancel: 0, techType: 'nail',
      wa: !!f.phoneWa.trim(), phoneWa: f.phoneWa.trim(), phone: f.phone.trim(), email: f.email.trim(), birthday: f.birthday, lang: f.lang,
      consents: { privacy: f.privacy, marketing: f.marketing, whatsapp: f.whatsapp },
      _manual: true, _initialNote: f.note.trim(),
    };
    onCreate(newClient);
    if (f.addToWaitlist && setWaitList) {
      setWaitList(l => [...l, { id: 'w' + Date.now(), clientId: id, serviceIds: [...f.wlServices], opId: null, prefDays: [], prefTime: f.wlPrefTime, note: '', added: { it: 'Oggi', en: 'Today' } }]);
    }
  };
  const Cons = ({ k, label, sub }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0' }}>
      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{label}</div>{sub && <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5 }}>{sub}</div>}</div>
      <Toggle on={f[k]} onChange={v => set(k, v)} />
    </div>
  );
  return (
    <DkModal open onClose={onClose} title={t('Nuovo cliente', 'New client')} sub={t('Inserimento manuale in anagrafica', 'Manual entry')} width={520}
      foot={<React.Fragment>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} style={{ opacity: canSave ? 1 : 0.4 }} onClick={save}><Icon name="check" size={17} color="#fff" />{t('Crea cliente', 'Create client')}</button>
      </React.Fragment>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <Field label={t('Nome', 'First name')}><input value={f.first} onChange={e => set('first', e.target.value)} style={inputCss} autoFocus /></Field>
        <Field label={t('Cognome', 'Last name')}><input value={f.last} onChange={e => set('last', e.target.value)} style={inputCss} /></Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <Field label={t('Telefono WhatsApp', 'WhatsApp phone')}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', display: 'grid', placeItems: 'center' }}><Icon name="whatsapp" size={15} color="#3F9D58" /></span>
            <input value={f.phoneWa} onChange={e => set('phoneWa', e.target.value)} placeholder="+39 …" style={{ ...inputCss, paddingLeft: 34 }} />
          </div>
        </Field>
        <Field label={t('Telefono', 'Phone')}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', display: 'grid', placeItems: 'center' }}><Icon name="phone" size={15} color="var(--muted-2)" /></span>
            <input value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="+39 …" style={{ ...inputCss, paddingLeft: 34 }} />
          </div>
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Field label="Email"><input type="email" value={f.email} onChange={e => set('email', e.target.value)} placeholder="nome@email.it" style={inputCss} /></Field>
        <Field label={t('Compleanno', 'Birthday')}><input type="date" value={f.birthday} onChange={e => set('birthday', e.target.value)} style={inputCss} /></Field>
      </div>
      {/* lingua preferita — lingua delle comunicazioni WhatsApp automatiche */}
      <Field label={t('Lingua preferita', 'Preferred language')} hint={t('· comunicazioni WhatsApp automatiche', '· automatic WhatsApp messages')}>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['it', 'Italiano'], ['en', 'English']].map(([k, l]) => { const on = f.lang === k; return (
            <button key={k} onClick={() => set('lang', k)} style={{ flex: 1, padding: '10px', borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>
          ); })}
        </div>
      </Field>
      {/* etichette — assegnazione dal catalogo (gestito in Impostazioni → Categorie) */}
      <div className="t-meta" style={{ margin: '16px 0 8px' }}>{t('Etichette', 'Labels')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 16 }}>
        {clientCats.map(cat => {
          const on = f.tags.includes(cat.id);
          return (
            <button key={cat.id} onClick={() => set('tags', on ? f.tags.filter(x => x !== cat.id) : [...f.tags, cat.id])} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: cat.color }} />{cat.name[lang] || cat.name.it}{on && <Icon name="check" size={12} color="var(--clay-ink)" />}
            </button>
          );
        })}
      </div>
      {/* nota iniziale */}
      <Field label={t('Note', 'Notes')} hint={t('· facoltative, visibili nella scheda', '· optional, shown on the profile')}>
        <textarea value={f.note} onChange={e => set('note', e.target.value)} rows={3} placeholder={t('es. Allergie, preferenze, come ci ha conosciuto…', 'e.g. Allergies, preferences, how they found us…')} style={{ ...inputCss, resize: 'none', lineHeight: 1.5 }} />
      </Field>
      {/* Lista d'attesa */}
      <div style={{ padding: '14px 0', borderTop: '1px solid var(--hair)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{t("Aggiungi in lista d'attesa", "Add to waiting list")}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{t('Sarà avvisata quando si libera uno slot compatibile', 'She will be notified when a matching slot opens up')}</div>
          </div>
          <Toggle on={f.addToWaitlist} onChange={v => set('addToWaitlist', v)} />
        </div>
        {f.addToWaitlist && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div>
              <div className="t-meta" style={{ marginBottom: 7 }}>{t('Servizi desiderati', 'Desired services')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SERVICES.slice(0, 8).map(s => { const on = f.wlServices.includes(s.id); return (
                  <button key={s.id} onClick={() => set('wlServices', on ? f.wlServices.filter(x => x !== s.id) : [...f.wlServices, s.id])} style={{ padding: '5px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{svcName(s, lang)}</button>
                ); })}
              </div>
            </div>
            <div>
              <div className="t-meta" style={{ marginBottom: 7 }}>{t('Preferenza orario', 'Time preference')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {[['any', t('Qualsiasi', 'Any')], ['morning', t('Mattina', 'Morning')], ['afternoon', t('Pomeriggio', 'Afternoon')]].map(([v, l]) => { const on = f.wlPrefTime === v; return (
                  <button key={v} onClick={() => set('wlPrefTime', v)} style={{ flex: 1, padding: '8px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>
                ); })}
              </div>
            </div>
          </div>
        )}
      </div>
      <div style={{ height: 16 }} />
      <div className="t-meta" style={{ marginBottom: 4 }}>{t('Consensi GDPR', 'GDPR consents')}</div>
      <div style={{ border: '1px solid var(--hair)', borderRadius: 12, padding: '2px 14px', display: 'flex', flexDirection: 'column' }}>
        <Cons k="privacy" label={t('Privacy & trattamento dati', 'Privacy & data')} sub={t('Obbligatorio per l\'anagrafica', 'Required for records')} />
        <div style={{ height: 1, background: 'var(--hair)' }} />
        <Cons k="marketing" label={t('Comunicazioni marketing', 'Marketing messages')} />
        <div style={{ height: 1, background: 'var(--hair)' }} />
        <Cons k="whatsapp" label={t('Contatto via WhatsApp', 'WhatsApp contact')} />
      </div>
      <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 10 }}>{t('I consensi possono arrivare anche da modulo cartaceo e restano modificabili dalla scheda.', 'Consents may come from a paper form and stay editable from the profile.')}</div>
    </DkModal>
  );
}

function DkClientProfile({ c, t, lang, fireToast }) {
  const { clientCats, setTab: setNavTab, loyalty, openModal, waitList } = useDk();
  const [tab, setTab] = useStateDc('storico');
  const [vouchers, setVouchers] = useStateDc(() => seedVouchers(c));
  // etichette assegnate al singolo cliente (il catalogo vive in Impostazioni → Categorie)
  window.__clientLabels = window.__clientLabels || {};
  const [assigned, setAssigned] = useStateDc(() => dkClientTags(c, clientCats).filter(k => clientCats.some(cc => cc.id === k)));
  const setLabels = (next) => { window.__clientLabels[c.id] = next; setAssigned(next); };
  const [labelPick, setLabelPick] = useStateDc(false);
  const [consents, setConsents] = useStateDc(() => ({ ...c.consents }));
  const setConsent = (k, v) => { setConsents(o => { const n = { ...o, [k]: v }; c.consents = n; return n; }); fireToast({ msg: v ? t('Consenso attivato', 'Consent enabled') : t('Consenso revocato', 'Consent revoked'), icon: v ? 'check' : 'x' }); };
  const [cardConsent, setCardConsent] = useStateDc(() => c.cardConsent || null);
  const grantCardConsent = () => {
    const now = new Date(); const pad = n => String(n).padStart(2, '0');
    const stamp = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} · ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const rec = { granted: true, when: stamp, by: 'Sole Caputo' }; c.cardConsent = rec; setCardConsent(rec);
    fireToast({ msg: t('Autorizzazione addebito registrata', 'Charge authorization recorded'), icon: 'check' });
  };
  const revokeCardConsent = () => { c.cardConsent = null; setCardConsent(null); fireToast({ msg: t('Autorizzazione addebito revocata', 'Charge authorization revoked'), icon: 'x' }); };
  const [expanded, setExpanded] = useStateDc(null);
  const [prefLang, setPrefLang] = useStateDc(() => c.lang || 'it');
  const changeLang = (v) => { setPrefLang(v); c.lang = v; fireToast({ msg: v === 'en' ? t('Comunicazioni WhatsApp in inglese', 'WhatsApp messages set to English') : t('Comunicazioni WhatsApp in italiano', 'WhatsApp messages set to Italian'), icon: 'whatsapp' }); };
  const score = Math.max(0, 100 - c.noshow * 18 - c.latecancel * 6);
  const relColor = score >= 85 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--danger)';
  const relLabel = score >= 85 ? t('Ottima', 'Excellent') : score >= 60 ? t('Buona', 'Good') : t('Da seguire', 'Watch');
  const hist = dkHist(c);
  const loyProg = clientLoyalty(c.id);
  const activeLoy = loyalty.filter(p => p.active);

  const tabs = [['storico', t('Storico', 'History')], ['scheda', t('Scheda tecnica', 'Tech sheet')], ['note', t('Note', 'Notes')], ['voucher', 'Wallet'], ['consensi', t('Consensi', 'Consents')]];

  return (
    <div style={{ padding: '26px 30px 40px', maxWidth: 880 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, marginBottom: 22 }}>
        <Avatar initials={c.initials} size={76} />
        <div style={{ flex: 1, minWidth: 210 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 500, whiteSpace: 'nowrap' }}>{c.name}</span>
            {waitList && waitList.some(w => w.clientId === c.id) && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, background: 'var(--clay-tint)', color: 'var(--clay-ink)', border: '1px solid color-mix(in srgb, var(--clay) 25%, transparent)', whiteSpace: 'nowrap' }}>
                <Icon name="clock" size={11} color="var(--clay-ink)" />{t("In lista d'attesa", "On waiting list")}
              </span>
            )}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6, whiteSpace: 'nowrap' }}>{t('Cliente dal', 'Client since')} {c.since} · {c.origin[lang]}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: c.wa ? t('Apri chat WhatsApp', 'Open WhatsApp chat') : t('WhatsApp non disponibile', 'WhatsApp unavailable'), icon: 'whatsapp' })}><Icon name="whatsapp" size={17} color="#3F9D58" />WhatsApp</button>
          <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('Chiamata a ' + c.name.split(' ')[0], 'Calling ' + c.name.split(' ')[0]), icon: 'phone' })}><Icon name="phone" size={17} />{t('Chiama', 'Call')}</button>
          <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('Bozza email aperta', 'Email draft opened'), icon: 'mail' })}><Icon name="mail" size={17} />Email</button>
          <button className="dk-btn dk-btn--clay" title={t('La conversazione si gestisce su Yourang', 'The conversation is managed on Yourang')} onClick={() => fireToast({ msg: t('Apertura di Yourang…', 'Opening Yourang…'), icon: 'ext' })}><Icon name="ext" size={16} color="#fff" />Yourang</button>
          
        </div>
      </div>

      {/* etichette — riga a tutta larghezza, una accanto all'altra */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', position: 'relative', margin: '-6px 0 20px' }}>
        {assigned.map(k => {
          const cat = clientCats.find(cc => cc.id === k);
          if (!cat) return null;
          return (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: cat.color, background: `color-mix(in srgb, ${cat.color} 14%, transparent)`, padding: '4px 6px 4px 10px', borderRadius: 99, whiteSpace: 'nowrap' }}>
              {cat.name[lang] || cat.name.it}
              <button onClick={() => setLabels(assigned.filter(x => x !== k))} title={t('Rimuovi etichetta', 'Remove label')} style={{ width: 16, height: 16, borderRadius: 99, display: 'grid', placeItems: 'center', cursor: 'pointer', background: `color-mix(in srgb, ${cat.color} 18%, transparent)` }}><Icon name="x" size={10} color={cat.color} stroke={2.6} /></button>
            </span>
          );
        })}
        <button onClick={() => setLabelPick(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', border: '1px dashed var(--line-strong)', background: 'transparent', padding: '4px 10px', borderRadius: 99, cursor: 'pointer' }}><Icon name="plus" size={11} color="var(--muted)" />{t('etichetta', 'label')}</button>
        {labelPick && (
          <React.Fragment>
            <div onClick={() => setLabelPick(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
            <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 51, width: 250, padding: 6, boxShadow: 'var(--sh-pop)' }}>
              <div className="t-meta" style={{ padding: '6px 9px 7px' }}>{t('Etichette cliente', 'Client labels')}</div>
              <div style={{ maxHeight: 250, overflowY: 'auto' }}>
                {clientCats.map(cat => {
                  const on = assigned.includes(cat.id);
                  return (
                    <button key={cat.id} className="dk-row" onClick={() => setLabels(on ? assigned.filter(x => x !== cat.id) : [...assigned, cat.id])} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left' }}>
                      <span style={{ width: 11, height: 11, borderRadius: 99, background: cat.color, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{cat.name[lang] || cat.name.it}</span>
                      {on && <Icon name="check" size={14} color="var(--clay-ink)" stroke={2.4} />}
                    </button>
                  );
                })}
              </div>
              <div style={{ borderTop: '1px solid var(--hair)', marginTop: 5, paddingTop: 5 }}>
                <button className="dk-row" onClick={() => { setLabelPick(false); openModal('catsmgr', 'clienti'); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left', color: 'var(--clay-ink)', fontWeight: 600, fontSize: 12.5 }}>
                  <Icon name="settings" size={14} color="var(--clay-ink)" />{t('Gestisci catalogo', 'Manage catalogue')}<Icon name="chevR" size={13} color="var(--clay-ink)" style={{ marginLeft: 'auto' }} />
                </button>
              </div>
            </div>
          </React.Fragment>
        )}
      </div>

      {/* KPIs (unchanged) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 14 }}>
        <ProfStat label={t('Visite', 'Visits')} value={c.visits} />
        <ProfStat label={t('Valore totale', 'Lifetime value')} value={fmtEur(c.value, lang)} />
        <ProfStat label={t('Scontrino medio', 'Avg ticket')} value={fmtEur(Math.round(c.value / Math.max(1, c.visits)), lang)} />
        <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Affidabilità', 'Reliability')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <RelRing score={score} color={relColor} />
            <div><div style={{ fontWeight: 700, fontSize: 14, color: relColor }}>{relLabel}</div><div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{c.noshow} no-show · {c.latecancel} {t('disdette', 'cancels')}</div></div>
          </div>
        </div>
      </div>
      {c.depositAlways && <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', background: 'var(--warn-tint)', borderRadius: 12, marginBottom: 14 }}><Icon name="coupon" size={18} color="var(--warn)" /><span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)' }}>{t('Deposito sempre richiesto · 2 no-show passati', 'Deposit always required · 2 past no-shows')}</span></div>}

      {/* lingua preferita — sotto le box dati — determina la lingua delle comunicazioni WhatsApp automatiche */}
      <div className="dk-card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', marginBottom: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="whatsapp" size={18} color="#3F9D58" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Lingua preferita', 'Preferred language')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{t('Tutte le comunicazioni WhatsApp automatiche (conferme, promemoria, post-visita, marketing) usano questa lingua.', 'All automatic WhatsApp messages (confirmations, reminders, post-visit, marketing) use this language.')}</div>
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', borderRadius: 10, padding: 4, flexShrink: 0 }}>
          {[['it', 'Italiano'], ['en', 'English']].map(([k, l]) => { const on = prefLang === k; return (
            <button key={k} onClick={() => changeLang(k)} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--ink)' : 'var(--muted)', boxShadow: on ? 'var(--sh-card)' : 'none' }}>{l}</button>
          ); })}
        </div>
      </div>

      {/* stato fedeltà → nel tab Wallet (qui era ridondante) */}

      {/* tabs */}
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 20 }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '11px 4px', marginRight: 18, fontSize: 14.5, fontWeight: 600, cursor: 'pointer', color: tab === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (tab === k ? 'var(--clay)' : 'transparent'), marginBottom: -1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {l}
            {k === 'voucher' && vouchers.filter(v => !v.used).length > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: 'var(--clay)', minWidth: 18, height: 18, padding: '0 5px', borderRadius: 99, display: 'inline-grid', placeItems: 'center' }}>{vouchers.filter(v => !v.used).length}</span>}
          </button>
        ))}
      </div>

      {tab === 'storico' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {hist.map((h, i) => {
            const o = op(h[2]);
            const open = expanded === i;
            const dep = h[5] || 0, method = h[6] === 'contanti' ? t('Contanti', 'Cash') : t('Carta', 'Card');
            return (
              <div key={i} className="dk-card" style={{ padding: 0, boxShadow: 'none', border: '1px solid var(--hair)', overflow: 'hidden' }}>
                <button className="dk-row" onClick={() => setExpanded(open ? null : i)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', width: '100%', textAlign: 'left', background: 'transparent', cursor: 'pointer' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: o.color, flexShrink: 0 }} />
                  <div style={{ width: 70, fontWeight: 700, fontSize: 13.5, flexShrink: 0 }}>{lang === 'en' ? h[1] : h[0]}</div>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{h[3].map(s => svcName(svc(s), lang)).join(' + ')}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{o.name}</div></div>
                  <span className="t-num" style={{ fontSize: 16, flexShrink: 0 }}>{fmtEur(h[4], lang)}</span>
                  <Icon name="chevD" size={15} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
                </button>
                {open && (
                  <div style={{ padding: '0 18px 16px 42px', borderTop: '1px solid var(--hair)' }}>
                    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', paddingTop: 14 }}>
                      <div>
                        <div className="t-meta" style={{ marginBottom: 4 }}>{t('Acconto', 'Deposit')}</div>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: dep ? 'var(--ink-2)' : 'var(--muted-2)' }}>{dep ? fmtEur(dep, lang) + ' · ' + t('versato', 'paid') : t('Nessun acconto', 'No deposit')}</div>
                      </div>
                      <div>
                        <div className="t-meta" style={{ marginBottom: 4 }}>{t('Metodo di pagamento', 'Payment method')}</div>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)' }}><Icon name={h[6] === 'contanti' ? 'wallet' : 'coupon'} size={14} color="var(--muted)" />{method}</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!hist.length && <EmptyState icon="calendar" title={t('Nessuna visita', 'No visits yet')} sub={t('Lo storico apparirà dopo la prima visita.', 'History will appear after the first visit.')} />}
        </div>
      )}

      {tab === 'scheda' && <TechSheetTab c={c} t={t} lang={lang} fireToast={fireToast} />}

      {tab === 'note' && <NotesTab clientId={c.id} t={t} lang={lang} fireToast={fireToast} />}

      {tab === 'voucher' && <VouchersTab vouchers={vouchers} setVouchers={setVouchers} t={t} lang={lang} fireToast={fireToast} clientName={c.name} clientId={c.id} />}

      {tab === 'consensi' && (
        <div style={{ maxWidth: 520 }}>
          <div className="dk-card" style={{ padding: 8, boxShadow: 'none', border: '1px solid var(--hair)' }}>
            {/* card-charge authorization — normal consent row, recorded with timestamp + attribution */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 14px', borderTop: 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Autorizzazione addebito carta', 'Card charge authorization')}</div>
                <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5 }}>{cardConsent ? cardConsent.when + ' · ' + t('da', 'by') + ' ' + cardConsent.by : t('Addebito no-show e cancellazioni tardive', 'No-show & late-cancel charge')}</div>
              </div>
              <span className="t-sm" style={{ fontWeight: 700, color: cardConsent ? 'var(--ok)' : 'var(--muted-2)' }}>{cardConsent ? t('Attivo', 'On') : 'Off'}</span>
              <Toggle on={!!cardConsent} onChange={v => v ? grantCardConsent() : revokeCardConsent()} />
            </div>
            {[['privacy', t('Privacy & trattamento dati', 'Privacy & data'), t('Obbligatorio per l\'anagrafica', 'Required for records')], ['marketing', t('Comunicazioni marketing', 'Marketing messages'), t('Promozioni e novità', 'Promotions and news')], ['whatsapp', t('Contatto via WhatsApp', 'WhatsApp contact'), t('Promemoria e conferme', 'Reminders and confirmations')]].map(([k, l, sub]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 14px', borderTop: '1px solid var(--hair)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{l}</div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5 }}>{sub}</div>
                </div>
                <span className="t-sm" style={{ fontWeight: 700, color: consents[k] ? 'var(--ok)' : 'var(--muted-2)' }}>{consents[k] ? t('Attivo', 'On') : 'Off'}</span>
                <Toggle on={!!consents[k]} onChange={v => setConsent(k, v)} />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 12 }}>
            <Icon name="edit" size={14} color="var(--muted)" />
            <span className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.45 }}>{t('Modificabili a mano: i consensi possono arrivare anche da modulo cartaceo firmato in salone.', 'Editable by hand: consents may also come from a paper form signed in the salon.')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Notes tab (store-backed, shared with agenda popup) ---------- */
function NotesTab({ clientId, t, lang, fireToast }) {
  const c = client(clientId);
  const [notes, setNotesState] = useStateDc(() => dkClientNotes(c));
  const setNotes = (fn) => setNotesState(prev => { const next = typeof fn === 'function' ? fn(prev) : fn; window.__clientNotes = window.__clientNotes || {}; window.__clientNotes[clientId] = next; return next; });
  const aiCount = notes.filter(n => n.ai).length;
  const [draft, setDraft] = useStateDc('');
  const [draftAi, setDraftAi] = useStateDc(false);
  const seq = React.useRef(100);
  const add = () => {
    if (!draft.trim()) return;
    setNotes(l => [{ id: 'n' + (seq.current++), text: draft.trim(), ai: draftAi, by: 'Sole', when: { it: 'oggi', en: 'today' } }, ...l]);
    setDraft(''); setDraftAi(false);
    fireToast({ msg: t('Nota aggiunta', 'Note added'), icon: 'check' });
  };
  const toggleAi = (id) => setNotes(l => l.map(n => n.id === id ? { ...n, ai: !n.ai } : n));
  const remove = (id) => setNotes(l => l.filter(n => n.id !== id));
  return (
    <div style={{ maxWidth: 640 }}>
      {/* add */}
      <div className="dk-card" style={{ padding: 16, marginBottom: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} placeholder={t('Aggiungi una nota su questo cliente…', 'Add a note about this client…')} style={{ width: '100%', border: 'none', outline: 'none', resize: 'none', fontSize: 14.5, lineHeight: 1.5, fontFamily: 'var(--sans)', background: 'transparent', color: 'var(--ink)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
          <VisibilityToggle ai={draftAi} onChange={setDraftAi} t={t} />
          <div style={{ flex: 1 }} />
          <button className="dk-btn dk-btn--clay" style={{ height: 40 }} disabled={!draft.trim()} onClick={add}><Icon name="plus" size={16} color="#fff" />{t('Aggiungi nota', 'Add note')}</button>
        </div>
      </div>
      {/* ai context hint */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, padding: '10px 14px', background: 'var(--clay-tint)', borderRadius: 12 }}>
        <Icon name="sparkle" size={16} color="var(--clay-ink)" />
        <span className="t-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{aiCount > 0 ? t(`${aiCount} note visibili all\'assistente AI`, `${aiCount} notes visible to the AI assistant`) : t('Nessuna nota condivisa con l\'AI', 'No notes shared with the AI')}</span>
      </div>
      {/* list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {notes.map(n => (
          <div key={n.id} className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid ' + (n.ai ? 'color-mix(in srgb, var(--clay) 35%, var(--hair))' : 'var(--hair)') }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: n.ai ? 'var(--clay-tint)' : 'var(--paper-2)' }}>
                <Icon name={n.ai ? 'sparkle' : 'lock'} size={16} color={n.ai ? 'var(--clay-ink)' : 'var(--muted)'} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>{noteText(n, lang)}</div>
                <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>{n.by} · {n.when[lang] || n.when.it}</div>
              </div>
              <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0 }} onClick={() => remove(n.id)}><Icon name="x" size={14} /></button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
              <VisibilityToggle ai={n.ai} onChange={() => toggleAi(n.id)} t={t} />
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{n.ai ? t('L\'AI può usarla nei suggerimenti', 'AI may use it in suggestions') : t('Visibile solo allo staff', 'Staff-only')}</span>
            </div>
          </div>
        ))}
        {!notes.length && <EmptyState icon="edit" title={t('Nessuna nota', 'No notes')} sub={t('Aggiungi la prima nota su questo cliente.', 'Add the first note about this client.')} />}
      </div>
    </div>
  );
}

function VisibilityToggle({ ai, onChange, t }) {
  return (
    <div style={{ display: 'inline-flex', background: 'var(--paper-2)', borderRadius: 99, padding: 3, gap: 2 }}>
      <button onClick={() => onChange(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: !ai ? 'var(--surface)' : 'transparent', color: !ai ? 'var(--ink)' : 'var(--muted)', boxShadow: !ai ? 'var(--sh-sm)' : 'none' }}>
        <Icon name="lock" size={13} color={!ai ? 'var(--ink)' : 'var(--muted)'} />{t('Privata', 'Private')}
      </button>
      <button onClick={() => onChange(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: ai ? 'var(--surface)' : 'transparent', color: ai ? 'var(--clay-ink)' : 'var(--muted)', boxShadow: ai ? 'var(--sh-sm)' : 'none' }}>
        <Icon name="sparkle" size={13} color={ai ? 'var(--clay-ink)' : 'var(--muted)'} />{t('Visibile all\'AI', 'Visible to AI')}
      </button>
    </div>
  );
}

/* ---------- Vouchers tab ---------- */
function stripV(d) { const { _new, ...rest } = d; return rest; }

function VouchersTab({ vouchers, setVouchers, t, lang, fireToast, clientName, clientId }) {
  const { loyalty, coupons } = useDk();
  const [edit, setEdit] = useStateDc(null);
  const [picker, setPicker] = useStateDc(false);
  const [giftView, setGiftView] = useStateDc(null); // gift card aperta in dettaglio
  const [gifts, setGifts] = useStateDc(() => seedGifts({ id: clientId, segment: (client(clientId) || {}).segment }));
  const seq = React.useRef(100);
  const available = vouchers.filter(v => !v.used).length;
  const used = vouchers.filter(v => v.used).length;
  const prog = clientLoyalty(clientId);
  const blank = () => ({ id: 'vc' + (seq.current++), code: 'YR' + Math.random().toString(36).slice(2, 6).toUpperCase(), desc: { it: 'Nuovo coupon', en: 'New coupon' }, kind: 'percent', amount: 10, giftText: { it: '', en: '' }, services: [], exp: { it: 'Scade tra 60 giorni', en: 'Expires in 60 days' }, used: false, origin: 'manual', _new: true });
  const fromTemplate = (ct) => { setVouchers(l => [{ id: 'vc' + (seq.current++), code: ct.code, desc: { ...ct.desc }, kind: ct.kind, amount: ct.amount, giftText: { ...(ct.giftText || { it: '', en: '' }) }, services: [...(ct.services || [])], exp: { it: ct.validity.it, en: ct.validity.en }, used: false, origin: ct.auto === 'loyalty' ? 'loyalty' : ct.auto !== 'none' ? 'auto' : 'manual' }, ...l]); setPicker(false); fireToast({ msg: t(`Coupon ${ct.code} assegnato`, `Coupon ${ct.code} assigned`), icon: 'coupon' }); };
  const save = (d) => { setVouchers(l => d._new ? [stripV(d), ...l] : l.map(v => v.id === d.id ? stripV(d) : v)); setEdit(null); fireToast({ msg: d._new ? t(`Coupon ${d.code} assegnato`, `Coupon ${d.code} assigned`) : t('Coupon aggiornato', 'Coupon updated'), icon: 'coupon' }); };
  const del = (id) => { setVouchers(l => l.filter(v => v.id !== id)); setEdit(null); fireToast({ msg: t('Coupon eliminato', 'Coupon deleted'), icon: 'x' }); };

  return (
    <div style={{ maxWidth: 660 }}>
      {/* —— 1 · COUPON: sconti percentuali o a importo —— */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="coupon" size={15} color="var(--clay-ink)" />
        <span className="t-meta">{t('Coupon · sconti', 'Coupons · discounts')}</span>
      </div>
      {/* summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div className="dk-card" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center' }}><Icon name="clock" size={19} color="var(--clay-ink)" /></div>
          <div><div className="t-num" style={{ fontSize: 22, lineHeight: 1 }}>{available}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('da usare', 'available')}</div></div>
        </div>
        <div className="dk-card" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--paper-2)', display: 'grid', placeItems: 'center' }}><Icon name="check" size={19} color="var(--muted)" /></div>
          <div><div className="t-num" style={{ fontSize: 22, lineHeight: 1, color: 'var(--muted)' }}>{used}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('usati', 'used')}</div></div>
        </div>
        <button className="dk-btn dk-btn--clay" style={{ height: 44 }} onClick={() => setPicker(true)}><Icon name="plus" size={16} color="#fff" />{t('Assegna coupon', 'Assign coupon')}</button>
      </div>

      {vouchers.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {vouchers.map(v => (
            <div key={v.id} className="dk-card dk-row" onClick={() => setEdit({ ...v, desc: { ...v.desc }, giftText: { ...(v.giftText || { it: '', en: '' }) }, exp: { ...v.exp }, services: [...(v.services || [])] })} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px 14px 18px', boxShadow: 'none', border: '1px solid var(--hair)', borderLeft: '3px solid ' + (v.used ? 'var(--faint)' : 'var(--clay)'), opacity: v.used ? 0.62 : 1 }}>
              <div style={{ width: 40, height: 40, borderRadius: 11, background: v.used ? 'var(--paper-2)' : 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <Icon name={v.kind === 'gift' ? 'gift' : 'coupon'} size={20} color={v.used ? 'var(--muted-2)' : 'var(--clay-ink)'} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{v.desc[lang]}</span>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 6 }}>{v.code}</span>
                  {v.origin === 'loyalty' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '2px 8px', borderRadius: 99 }}><Icon name="star" size={11} color="var(--clay-ink)" />{t('Fedeltà · premio punti', 'Loyalty · points reward')}</span>}
                  {v.origin === 'auto' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '2px 8px', borderRadius: 99 }}><Icon name="bolt" size={11} color="var(--ok)" />{t('Automatico', 'Automatic')}</span>}
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="calendar" size={13} color="var(--muted-2)" />{v.exp[lang]}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="tag" size={13} color="var(--muted-2)" />{voucherScope(v, t, lang)}</span>
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="t-num" style={{ fontSize: 18, color: v.used ? 'var(--muted-2)' : 'var(--clay-ink)' }}>{voucherValue(v, lang)}</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, marginTop: 3, color: v.used ? 'var(--muted-2)' : 'var(--ok)' }}>
                  <Icon name={v.used ? 'check' : 'clock'} size={12} color={v.used ? 'var(--muted-2)' : 'var(--ok)'} />{v.used ? t('Usato', 'Used') : t('Da usare', 'Available')}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button className="dk-iconbtn" style={{ width: 32, height: 32, borderRadius: 8 }} onClick={(e) => { e.stopPropagation(); setEdit({ ...v, desc: { ...v.desc }, giftText: { ...(v.giftText || { it: '', en: '' }) }, exp: { ...v.exp }, services: [...(v.services || [])] }); }}><Icon name="edit" size={15} /></button>
                <button className="dk-iconbtn" style={{ width: 32, height: 32, borderRadius: 8 }} onClick={(e) => { e.stopPropagation(); del(v.id); }}><Icon name="x" size={15} color="var(--danger)" /></button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon="coupon" title={t('Nessun coupon', 'No coupons')} sub={t('Assegna un coupon di benvenuto o fedeltà.', 'Assign a welcome or loyalty coupon.')} action={t('Assegna coupon', 'Assign coupon')} onAction={() => setEdit(blank())} />
      )}

      {/* —— 2 · FEDELTÀ: a che punto è la raccolta —— */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '26px 0 10px', paddingTop: 20, borderTop: '1px solid var(--hair)' }}>
        <Icon name="star" size={15} color="var(--clay-ink)" />
        <span className="t-meta">{t('Fedeltà · raccolta punti', 'Loyalty · points balance')}</span>
      </div>
      {loyalty.filter(p => p.active).length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loyalty.filter(p => p.active).map(p => { const val = (prog[p.id] != null ? prog[p.id] : 0); const pctDone = Math.min(100, Math.round(val / p.threshold * 100)); const reached = val >= p.threshold; const left = Math.max(0, p.threshold - val); const u = p.type === 'points' ? t('pt', 'pt') : t('timbri', 'stamps'); return (
            <div key={p.id} className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: p.type === 'points' ? 'var(--clay-tint)' : 'var(--ok-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={p.type === 'points' ? 'star' : 'check'} size={16} color={p.type === 'points' ? 'var(--clay-ink)' : 'var(--ok)'} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 14 }}>{p.name[lang]}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Premio: ', 'Reward: ')}{p.reward[lang]}</div></div>
                <div className="t-num" style={{ fontSize: 16 }}>{val}<span style={{ color: 'var(--muted-2)', fontSize: 13 }}>/{p.threshold}</span></div>
              </div>
              <ProgressBar value={pctDone} color={reached ? 'var(--ok)' : (p.type === 'points' ? 'var(--clay)' : 'var(--ok)')} />
              {reached
                ? <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, fontSize: 12, fontWeight: 700, color: 'var(--ok)' }}><Icon name="check" size={13} color="var(--ok)" stroke={2.4} />{t('Premio raggiunto → genera il coupon (compare qui sopra con origine Fedeltà)', 'Reward reached → generates the coupon (appears above with Loyalty origin)')}</div>
                : <div className="t-sm" style={{ marginTop: 8, color: 'var(--muted)' }}>{t(`Mancano ${left} ${u} al premio`, `${left} ${u} to the reward`)}</div>}
            </div>
          ); })}
        </div>
      ) : (
        <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '6px 2px 2px' }}>{t('Nessun programma fedeltà attivo.', 'No active loyalty program.')}</div>
      )}

      {/* —— 3 · GIFT CARD: ricevute in regalo o acquistate da regalare —— */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '26px 0 10px', paddingTop: 20, borderTop: '1px solid var(--hair)' }}>
        <Icon name="gift" size={15} color="var(--clay-ink)" />
        <span className="t-meta">{t('Gift card · buoni regalo', 'Gift cards')}</span>
        {gifts.filter(g => !g.used).length > 0 && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '2px 8px', borderRadius: 99 }}>{gifts.filter(g => !g.used).length} {t('attive', 'active')}</span>}
      </div>
      {gifts.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {gifts.map(g => (
            <div key={g.id} className="dk-card dk-row" onClick={() => setGiftView(g)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)', borderLeft: '3px solid ' + (g.used ? 'var(--faint)' : 'var(--ok)'), opacity: g.used ? 0.62 : 1, cursor: 'pointer' }}>
              <QrGlyph code={g.code} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{g.role === 'dest' ? t('Ricevuta in regalo', 'Received as a gift') : t('Acquistata · da regalare', 'Bought · to gift')}</span>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '2px 8px', borderRadius: 6 }}>{g.code}</span>
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="user" size={13} color="var(--muted-2)" />{g.role === 'dest' ? t('Regalata da ', 'From ') : t('Destinataria: ', 'For ')}{g.other}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="calendar" size={13} color="var(--muted-2)" />{g.exp[lang]}</span>
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="t-num" style={{ fontSize: 19, color: g.used ? 'var(--muted-2)' : 'var(--ok)' }}>{fmtEur(g.value, lang)}</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, marginTop: 3, color: g.used ? 'var(--muted-2)' : 'var(--ok)' }}>
                  <Icon name={g.used ? 'check' : 'clock'} size={12} color={g.used ? 'var(--muted-2)' : 'var(--ok)'} />{g.used ? t('Usata', 'Used') : t('Attiva', 'Active')}
                </span>
              </div>
              <Icon name="chevR" size={16} color="var(--faint)" />
            </div>
          ))}
        </div>
      ) : (
        <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '6px 2px 2px' }}>{t('Nessuna gift card collegata a questo cliente.', 'No gift cards linked to this client.')}</div>
      )}

      {giftView && (
        <DkModal open onClose={() => setGiftView(null)} title={t('Gift card', 'Gift card')} sub={giftView.code} width={420}
          foot={<React.Fragment>
            <button className="dk-btn dk-btn--ghost" onClick={() => setGiftView(null)}>{t('Chiudi', 'Close')}</button>
            {!giftView.used && <button className="dk-btn dk-btn--clay" onClick={() => fireToast({ msg: t('QR pronto per la stampa', 'QR ready to print'), icon: 'check' })}><Icon name="barcode" size={16} color="#fff" />{t('Stampa QR', 'Print QR')}</button>}
          </React.Fragment>}>
          {/* QR grande, da mostrare/scansionare in cassa */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '6px 0 16px' }}>
            <QrGlyph code={giftView.code} size={160} />
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted)', background: 'var(--paper-2)', padding: '4px 12px', borderRadius: 8 }}>{giftView.code}</span>
            <div className="t-num" style={{ fontSize: 32, color: giftView.used ? 'var(--muted-2)' : 'var(--ok)', lineHeight: 1 }}>{fmtEur(giftView.value, lang)}</div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 99, color: giftView.used ? 'var(--muted)' : 'var(--ok)', background: giftView.used ? 'var(--paper-2)' : 'var(--ok-tint)' }}>
              <Icon name={giftView.used ? 'check' : 'clock'} size={13} color={giftView.used ? 'var(--muted)' : 'var(--ok)'} />{giftView.used ? t('Usata', 'Used') : t('Attiva · da riscattare', 'Active · to redeem')}
            </span>
          </div>
          <div style={{ borderTop: '1px solid var(--hair)' }}>
            {[
              [t('Tipo', 'Type'), giftView.role === 'dest' ? t('Ricevuta in regalo', 'Received as a gift') : t('Acquistata · da regalare', 'Bought · to gift')],
              [giftView.role === 'dest' ? t('Regalata da', 'From') : t('Destinataria', 'For'), giftView.other],
              [t('Valore', 'Value'), fmtEur(giftView.value, lang)],
              [t('Scadenza', 'Expiry'), giftView.exp[lang]],
            ].map(([l, v], i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 2px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                <span className="t-sm" style={{ color: 'var(--muted)', width: 110, flexShrink: 0 }}>{l}</span>
                <span style={{ fontWeight: 700, fontSize: 14, flex: 1, textAlign: 'right' }}>{v}</span>
              </div>
            ))}
          </div>
        </DkModal>
      )}
      {edit && <VoucherEditModal draft={edit} setDraft={setEdit} onSave={save} onDelete={del} onClose={() => setEdit(null)} t={t} lang={lang} />}
      {picker && (
        <DkModal open onClose={() => setPicker(false)} title={t('Assegna coupon', 'Assign coupon')} sub={t('Scegli un coupon o creane uno su misura', 'Pick a coupon or create a custom one')} width={500}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {coupons.filter(ct => ct.active).map(ct => (
              <button key={ct.id} className="dk-row" onClick={() => fromTemplate(ct)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--hair)', textAlign: 'left' }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={ct.kind === 'gift' ? 'gift' : 'coupon'} size={18} color="var(--clay-ink)" /></div>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 14 }}>{ct.desc[lang]}</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{ct.code} · {couponScope(ct, t, lang)}</div></div>
                <span className="t-num" style={{ fontSize: 16, color: 'var(--clay-ink)' }}>{couponValue(ct, lang)}</span>
              </button>
            ))}
            {!coupons.filter(ct => ct.active).length && <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center', padding: 14 }}>{t('Nessun coupon attivo. Creane in Coupon & Fedeltà.', 'No active coupons. Create some in Coupons & Loyalty.')}</div>}
          </div>
          <button className="dk-btn dk-btn--ghost" style={{ width: '100%' }} onClick={() => { setPicker(false); setEdit(blank()); }}><Icon name="plus" size={16} />{t('Crea coupon su misura', 'Create custom coupon')}</button>
        </DkModal>
      )}
    </div>
  );
}

function VoucherEditModal({ draft, setDraft, onSave, onDelete, onClose, t, lang }) {
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setL = (key, v) => setDraft(d => ({ ...d, [key]: { ...d[key], [lang]: v } }));
  const toggleSvc = (id) => setDraft(d => ({ ...d, services: d.services.includes(id) ? d.services.filter(x => x !== id) : [...d.services, id] }));
  const kinds = [['percent', t('Percentuale', 'Percentage')], ['amount', t('Importo', 'Amount')], ['gift', t('Omaggio', 'Gift')]];
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%' };
  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Assegna coupon', 'Assign coupon') : t('Modifica coupon', 'Edit coupon')} sub={t('Valore, servizi e validità', 'Value, services and validity')} width={560}
      foot={<React.Fragment>
        {!draft._new && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={() => onDelete(draft.id)}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" onClick={() => onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>
      {/* desc + code */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 12, marginBottom: 16 }}>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Descrizione', 'Description')}</div><input value={draft.desc[lang] || ''} onChange={e => setL('desc', e.target.value)} style={inputCss} /></div>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Codice', 'Code')}</div><input value={draft.code} onChange={e => set({ code: e.target.value.toUpperCase() })} style={{ ...inputCss, fontFamily: 'ui-monospace, monospace', letterSpacing: '0.05em', fontWeight: 700 }} /></div>
      </div>

      {/* type */}
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Tipo di sconto', 'Discount type')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {kinds.map(([k, l]) => <button key={k} onClick={() => set({ kind: k })} style={{ flex: 1, padding: '10px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (draft.kind === k ? 'var(--ink)' : 'var(--hair)'), background: draft.kind === k ? 'var(--ink)' : 'var(--surface)', color: draft.kind === k ? '#fff' : 'var(--ink-2)' }}>{l}</button>)}
      </div>

      {/* value */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 12, marginBottom: 16 }}>
        {draft.kind === 'gift' ? (
          <div style={{ flex: 1 }}>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Servizio in omaggio', 'Free service / gift')}</div>
            <input value={(draft.giftText && draft.giftText[lang]) || ''} onChange={e => setL('giftText', e.target.value)} placeholder={t('es. Nail art', 'e.g. Nail art')} style={inputCss} />
          </div>
        ) : (
          <React.Fragment>
            <div style={{ flex: 1 }}>
              <div className="t-meta" style={{ marginBottom: 8 }}>{draft.kind === 'percent' ? t('Percentuale di sconto', 'Discount percentage') : t('Importo di sconto', 'Discount amount')}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)' }}>
                {draft.kind === 'amount' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>}
                <input type="number" value={draft.amount} onChange={e => set({ amount: Math.max(0, parseInt(e.target.value) || 0) })} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 70 }} />
                {draft.kind === 'percent' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Mostrato come', 'Shown as')}</div><div className="t-num" style={{ fontSize: 24, color: 'var(--clay-ink)' }}>{voucherValue(draft, lang)}</div></div>
          </React.Fragment>
        )}
      </div>

      {/* services */}
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Servizi applicabili', 'Applicable services')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 6 }}>
        <button onClick={() => set({ services: [] })} style={{ padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (!draft.services.length ? 'var(--ink)' : 'var(--hair)'), background: !draft.services.length ? 'var(--ink)' : 'var(--surface)', color: !draft.services.length ? '#fff' : 'var(--ink-2)' }}>{t('Tutti i servizi', 'All services')}</button>
        {SERVICES.map(s => { const on = draft.services.includes(s.id); return (
          <button key={s.id} onClick={() => toggleSvc(s.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{svcName(s, lang)}{on && <Icon name="check" size={12} color="#fff" />}</button>); })}
      </div>
      <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 16 }}>{t('Nessuna selezione = valido su tutti i servizi.', 'No selection = valid on all services.')}</div>

      {/* expiry + status */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div><div className="t-meta" style={{ marginBottom: 6 }}>{t('Scadenza', 'Expiry')}</div><input value={draft.exp[lang] || ''} onChange={e => setL('exp', e.target.value)} style={inputCss} /></div>
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Stato', 'Status')}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[[false, t('Da usare', 'Available')], [true, t('Usato', 'Used')]].map(([val, l]) => <button key={String(val)} onClick={() => set({ used: val })} style={{ flex: 1, padding: '10px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (draft.used === val ? 'var(--ink)' : 'var(--hair)'), background: draft.used === val ? 'var(--ink)' : 'var(--surface)', color: draft.used === val ? '#fff' : 'var(--ink-2)' }}>{l}</button>)}
          </div>
        </div>
      </div>
    </DkModal>
  );
}

/* ---------- Scheda tecnica (technical sheet) — generale, valida per qualsiasi categoria beauty ---------- */
const TECH_FIELDS = [
  { k: 'treatment', label: { it: 'Trattamento eseguito', en: 'Treatment performed' }, type: 'text', ph: { it: 'es. Gel, Balayage, Pulizia viso…', en: 'e.g. Gel, Balayage, Facial…' } },
  { k: 'area', label: { it: 'Zona / area trattata', en: 'Area treated' }, type: 'text', ph: { it: 'es. mani, viso, capelli, gambe', en: 'e.g. hands, face, hair, legs' } },
  { k: 'products', label: { it: 'Prodotti utilizzati', en: 'Products used' }, type: 'text', ph: { it: 'marca, linea, tonalità…', en: 'brand, line, shade…' } },
  { k: 'params', label: { it: 'Parametri / impostazioni', en: 'Parameters / settings' }, type: 'text', ph: { it: 'es. formula, vol., tempo di posa, potenza', en: 'e.g. formula, vol., processing, intensity' } },
  { k: 'outcome', label: { it: 'Esito', en: 'Outcome' }, type: 'select', opts: [{ it: 'Ottimo', en: 'Excellent' }, { it: 'Buono', en: 'Good' }, { it: 'Da monitorare', en: 'To monitor' }, { it: 'Reazione / problema', en: 'Reaction / issue' }] },
  { k: 'duration', label: { it: 'Durata / tenuta', en: 'Duration / hold' }, type: 'text', ph: { it: 'es. 90 min · tenuta 3 settimane', en: 'e.g. 90 min · holds 3 weeks' } },
  { k: 'advice', label: { it: 'Consigli post-trattamento', en: 'Aftercare advice' }, type: 'textarea' },
  { k: 'protocol', label: { it: 'Note di protocollo', en: 'Protocol notes' }, type: 'textarea' },
  { k: 'next', label: { it: 'Prossimo step consigliato', en: 'Recommended next step' }, type: 'text', ph: { it: 'es. richiamo a 4 settimane', en: 'e.g. follow-up in 4 weeks' } },
];
function techSchema() { return { label: { it: 'Trattamento', en: 'Treatment' }, fields: TECH_FIELDS }; }
function dkTechSeed(c) {
  if (c.id === 'c1') return [
    { id: 'ts_seed1', date: '2025-10-24T15:30', apptLabel: { it: '24 ott · Manicure + Gel', en: '24 Oct · Manicure + Gel' }, opId: 'sole', category: 'nail',
      values: { treatment: { it: 'Manicure + smalto gel', en: 'Manicure + gel polish' }, area: { it: 'Mani', en: 'Hands' }, products: 'Gel rosso "Carmine" · base rubber', params: { it: '2 mani colore + top no-wipe · lampada 60s', en: '2 colour coats + no-wipe top · 60s lamp' }, outcome: { it: 'Buono', en: 'Good' }, duration: { it: '60 min · tenuta 3 settimane', en: '60 min · holds 3 weeks' }, advice: { it: 'Olio cuticole 2x/die. Guanti per detersivi.', en: 'Cuticle oil 2x/day. Gloves for cleaning.' }, protocol: { it: 'Distacco dal 19° giorno sul mignolo.', en: 'Lifting from day 19 on pinky.' }, next: { it: 'Richiamo a 3 settimane', en: 'Follow-up in 3 weeks' } }, photos: [] },
    { id: 'ts_seed2', date: '2025-09-11T11:00', apptLabel: { it: '11 set · Ricostruzione', en: '11 Sep · Rebuild' }, opId: 'giulia', category: 'nail',
      values: { treatment: { it: 'Ricostruzione gel', en: 'Gel rebuild' }, area: { it: 'Mani', en: 'Hands' }, products: 'Cover peach · cartina', params: { it: 'Allungamento +3mm · forma mandorla', en: '+3mm extension · almond shape' }, outcome: { it: 'Da monitorare', en: 'To monitor' }, duration: { it: '90 min · tenuta 4 settimane', en: '90 min · holds 4 weeks' }, advice: { it: 'Rinforzo cheratina consigliato.', en: 'Keratin strengthening recommended.' }, protocol: { it: 'Unghie fragili: ridurre spessore al prossimo refill.', en: 'Fragile nails: reduce thickness next refill.' }, next: { it: 'Refill a 4 settimane', en: 'Refill in 4 weeks' } }, photos: [] },
  ];
  return [];
}
function dkTechSheets(clientId, c) {
  window.__techSheets = window.__techSheets || {};
  if (!window.__techSheets[clientId]) window.__techSheets[clientId] = dkTechSeed(c || { id: clientId });
  return window.__techSheets[clientId];
}
function dkAddTechSheet(clientId, sheet) {
  window.__techSheets = window.__techSheets || {};
  const arr = window.__techSheets[clientId] || [];
  window.__techSheets[clientId] = [sheet, ...arr];
}
function techDateLabel(iso, lang) {
  const d = new Date(iso); const hm = iso.slice(11, 16);
  const months = lang === 'en' ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] : ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' · ' + hm;
}
function techVal(v, lang) { return v == null ? '' : (typeof v === 'object' ? (v[lang] || v.it || '') : v); }

// read-only card for one saved sheet
function TechSheetCard({ sheet, t, lang, defaultOpen }) {
  const [open, setOpen] = useStateDc(!!defaultOpen);
  const o = op(sheet.opId); const sch = techSchema(sheet.category);
  return (
    <div className="dk-card" style={{ padding: 0, boxShadow: 'none', border: '1px solid var(--hair)', overflow: 'hidden' }}>
      <button className="dk-row" onClick={() => setOpen(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '14px 18px', width: '100%', textAlign: 'left', background: 'transparent', cursor: 'pointer' }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="edit" size={16} color="var(--clay-ink)" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{techVal(sheet.apptLabel, lang) || (sch.label[lang] || sch.label.it)}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            {o && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Avatar initials={o.initials} size={17} color={o.color} />{o.name}</span>}
            <span>· {techDateLabel(sheet.date, lang)}</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99 }}>{sch.label[lang] || sch.label.it}</span>
          </div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--muted-2)', flexShrink: 0 }}><Icon name="lock" size={12} color="var(--muted-2)" />{t('Sola lettura', 'Read-only')}</span>
        <Icon name="chevD" size={15} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ padding: '4px 18px 18px', borderTop: '1px solid var(--hair)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', paddingTop: 14 }}>
            {sch.fields.map(f => { const val = techVal(sheet.values[f.k], lang); return (
              <div key={f.k} style={{ gridColumn: f.type === 'textarea' ? '1 / -1' : 'auto' }}>
                <div className="t-meta" style={{ marginBottom: 4 }}>{f.label[lang] || f.label.it}</div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: val ? 'var(--ink-2)' : 'var(--muted-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{val || '—'}</div>
              </div>
            ); })}
          </div>
          {sheet.photos && sheet.photos.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="t-meta" style={{ marginBottom: 8 }}>{t('Foto', 'Photos')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {sheet.photos.map((src, i) => <img key={i} src={src} alt="" style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--hair)' }} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// editable form to create a new sheet
function TechSheetForm({ clientId, category, apptLabel, opId, onSaved, onCancel, t, lang }) {
  const sch = techSchema(category);
  const [values, setValues] = useStateDc({});
  const [photos, setPhotos] = useStateDc([]);
  const fileRef = React.useRef(null);
  const setV = (k, v) => setValues(o => ({ ...o, [k]: v }));
  const onFiles = (e) => {
    const files = [...(e.target.files || [])];
    files.forEach(f => { const r = new FileReader(); r.onload = ev => setPhotos(p => [...p, ev.target.result]); r.readAsDataURL(f); });
  };
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14, padding: '9px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%', boxSizing: 'border-box', color: 'var(--ink)' };
  const save = () => {
    const now = new Date(); const pad = n => String(n).padStart(2, '0');
    const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const sheet = { id: 'ts' + Date.now(), date: iso, apptLabel: apptLabel || null, opId: opId || 'sole', category, values: { ...values }, photos: [...photos] };
    dkAddTechSheet(clientId, sheet);
    onSaved && onSaved(sheet);
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--clay-tint)', borderRadius: 12, marginBottom: 16 }}>
        <Icon name="info" size={15} color="var(--clay-ink)" />
        <span className="t-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{t('Una volta salvata, la scheda diventa di sola lettura e resta nella cronologia.', 'Once saved, the sheet becomes read-only and stays in the history.')}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {sch.fields.map(f => (
          <div key={f.k} style={{ gridColumn: f.type === 'textarea' ? '1 / -1' : 'auto' }}>
            <div className="t-meta" style={{ marginBottom: 6 }}>{f.label[lang] || f.label.it}</div>
            {f.type === 'textarea' ? (
              <textarea value={values[f.k] || ''} onChange={e => setV(f.k, e.target.value)} rows={2} placeholder={f.ph ? (f.ph[lang] || f.ph.it) : ''} style={{ ...inputCss, resize: 'none', lineHeight: 1.5 }} />
            ) : f.type === 'select' ? (
              <select value={values[f.k] || ''} onChange={e => setV(f.k, e.target.value)} style={{ ...inputCss, cursor: 'pointer' }}>
                <option value="">{t('— seleziona —', '— select —')}</option>
                {f.opts.map((o, i) => <option key={i} value={o[lang] || o.it}>{o[lang] || o.it}</option>)}
              </select>
            ) : (
              <input value={values[f.k] || ''} onChange={e => setV(f.k, e.target.value)} placeholder={f.ph ? (f.ph[lang] || f.ph.it) : ''} style={inputCss} />
            )}
          </div>
        ))}
      </div>
      {/* photo upload */}
      <div style={{ marginTop: 16 }}>
        <div className="t-meta" style={{ marginBottom: 8 }}>{t('Foto', 'Photos')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {photos.map((src, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <img src={src} alt="" style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--hair)' }} />
              <button onClick={() => setPhotos(p => p.filter((_, j) => j !== i))} style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 99, background: 'var(--ink)', border: '2px solid var(--surface)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={11} color="#fff" stroke={2.6} /></button>
            </div>
          ))}
          <button onClick={() => fileRef.current && fileRef.current.click()} style={{ width: 84, height: 84, borderRadius: 10, border: '1px dashed var(--line-strong)', background: 'var(--surface-2)', cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}><Icon name="camera" size={22} color="var(--muted)" /></button>
          <input ref={fileRef} type="file" accept="image/*" multiple onChange={onFiles} style={{ display: 'none' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
        <button className="dk-btn dk-btn--ghost" style={{ flex: 1 }} onClick={onCancel}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" style={{ flex: 1 }} onClick={save}><Icon name="check" size={16} color="#fff" />{t('Salva scheda', 'Save sheet')}</button>
      </div>
    </div>
  );
}

// profile tab
function TechSheetTab({ c, t, lang, fireToast }) {
  const [, force] = useStateDc(0);
  const [adding, setAdding] = useStateDc(false);
  const sheets = dkTechSheets(c.id, c);
  const cat = c.techType === 'hair' ? 'hair' : c.techType === 'nail' ? 'nail' : 'default';
  if (adding) {
    return (
      <div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, marginBottom: 14 }}>{t('Nuova scheda tecnica', 'New technical sheet')}</div>
        <TechSheetForm clientId={c.id} category={cat} apptLabel={null} opId={(dkHist(c)[0] || [])[2] || 'sole'} t={t} lang={lang}
          onCancel={() => setAdding(false)}
          onSaved={() => { setAdding(false); force(x => x + 1); fireToast({ msg: t('Scheda tecnica salvata', 'Technical sheet saved'), icon: 'check' }); }} />
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Registro tecnico per trattamento. Una scheda per visita, con timestamp e sola lettura una volta salvata.', 'Technical record per treatment. One sheet per visit, timestamped and read-only once saved.')}</div>
        </div>
        <button className="dk-btn dk-btn--clay" style={{ flexShrink: 0 }} onClick={() => setAdding(true)}><Icon name="plus" size={16} color="#fff" />{t('Nuova scheda', 'New sheet')}</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sheets.map((s, i) => <TechSheetCard key={s.id} sheet={s} t={t} lang={lang} defaultOpen={i === 0} />)}
        {!sheets.length && <EmptyState icon="edit" title={t('Nessuna scheda tecnica', 'No technical sheets')} sub={t('Crea la prima scheda dopo un trattamento.', 'Create the first sheet after a treatment.')} />}
      </div>
    </div>
  );
}

// compact preview shown inline in the agenda appointment popup
function TechSheetPreview({ clientId, onOpen, onCreate, t, lang }) {
  const sheets = dkTechSheets(clientId, client(clientId));
  if (!sheets.length) {
    return (
      <button onClick={onCreate} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', padding: '13px 14px', borderRadius: 12, border: '1px dashed var(--line-strong)', background: 'var(--surface-2)', cursor: 'pointer' }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--surface)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="edit" size={15} color="var(--muted)" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t('Scheda tecnica', 'Technical sheet')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Nessuna scheda · aggiungi la prima', 'No sheet yet · add the first')}</div>
        </div>
        <Icon name="plus" size={16} color="var(--muted-2)" />
      </button>
    );
  }
  const s = sheets[0]; const sch = techSchema();
  const preview = sch.fields.filter(f => techVal(s.values[f.k], lang)).slice(0, 2);
  const o = op(s.opId);
  return (
    <button onClick={() => onOpen(s.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 0, borderRadius: 12, border: '1px solid var(--hair)', background: 'var(--surface)', cursor: 'pointer', overflow: 'hidden' }}>
      <div style={{ padding: '13px 14px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="edit" size={15} color="var(--clay-ink)" /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('Scheda tecnica', 'Technical sheet')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{techVal(s.apptLabel, lang) || (o ? o.name : '')} · {techDateLabel(s.date, lang)}</div>
          </div>
        </div>
        <div style={{ maxHeight: 42, overflow: 'hidden', WebkitMaskImage: 'linear-gradient(to bottom, #000 60%, transparent)', maskImage: 'linear-gradient(to bottom, #000 60%, transparent)' }}>
          {preview.map(f => (
            <div key={f.k} style={{ marginBottom: 5 }}>
              <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 600 }}>{f.label[lang] || f.label.it}: </span>
              <span className="t-sm" style={{ color: 'var(--ink-2)' }}>{techVal(s.values[f.k], lang)}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '9px', borderTop: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)' }}>{t('Vedi scheda completa', 'View full sheet')}</span>
        <Icon name="chevR" size={13} color="var(--clay-ink)" />
      </div>
    </button>
  );
}

// agenda-facing modal: view existing sheet for an appointment, or create a new one
function TechSheetModal({ clientId, apptId, apptLabel, opId, category, viewSheetId, onClose, t, lang, fireToast }) {
  const [, force] = useStateDc(0);
  const sheets = dkTechSheets(clientId, client(clientId));
  const existing = viewSheetId ? sheets.find(s => s.id === viewSheetId) : (apptId ? sheets.find(s => s.apptId === apptId) : null);
  const cl = client(clientId);
  return (
    <DkModal open onClose={onClose} title={t('Scheda tecnica', 'Technical sheet')} sub={(cl ? cl.name + ' · ' : '') + techVal(apptLabel, lang)} width={560}>
      {existing ? (
        <TechSheetCard sheet={existing} t={t} lang={lang} defaultOpen />
      ) : (
        <TechSheetForm clientId={clientId} category={category || 'default'} apptLabel={apptLabel} opId={opId} t={t} lang={lang}
          onCancel={onClose}
          onSaved={(s) => { s.apptId = apptId; force(x => x + 1); fireToast({ msg: t('Scheda tecnica salvata', 'Technical sheet saved'), icon: 'check' }); onClose(); }} />
      )}
    </DkModal>
  );
}

function ProfStat({ label, value }) {
  return <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}><div className="t-meta" style={{ marginBottom: 6 }}>{label}</div><div className="t-num" style={{ fontSize: 24 }}>{value}</div></div>;
}
function RelRing({ score, color }) {
  const r = 18, circ = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: 46, height: 46, flexShrink: 0 }}>
      <svg width="46" height="46" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="23" cy="23" r={r} fill="none" stroke="var(--paper-2)" strokeWidth="5" />
        <circle cx="23" cy="23" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - score / 100)} />
      </svg>
      <span className="t-num" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 13, color }}>{score}</span>
    </div>
  );
}

Object.assign(window, { DkClienti, NewClientModal, BulkClientImport, TechSheetModal, TechSheetPreview, dkTechSheets, techSchema, NotesTab });
