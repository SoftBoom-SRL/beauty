// desktop-insight.jsx — KPI dashboard + charts + suggestions + analyst drawer
const { useState: useStateDi, useEffect: useEffectDi, useRef: useRefDi } = React;

function DkInsight() {
  const { t, lang, fireToast, clientCats } = useDk();
  const S = STATS;
  const maxSvc = Math.max(...S.byService.map(s => s.val));
  const [period, setPeriod] = useStateDi('month');
  const periods = [['month', t('Mese', 'Month')], ['quarter', t('Trimestre', 'Quarter')], ['year', t('Anno', 'Year')], ['custom', t('Periodo', 'Custom')]];
  const pf = { month: 1, quarter: 3, year: 12, custom: 1 }[period];
  const [cFrom, setCFrom] = useStateDi('2026-06-01');
  const [cTo, setCTo] = useStateDi('2026-06-30');
  const [scope, setScope] = useStateDi('all');
  const [scopeOpen, setScopeOpen] = useStateDi('');
  const [scopeQ, setScopeQ] = useStateDi('');
  const _scTag = scope.startsWith('tag:') ? clientCats.find(c => c.id === scope.slice(4)) : null;
  const scopeLabel = scope === 'all' ? t('Tutti i clienti', 'All clients')
    : _scTag ? (_scTag.name[lang] || _scTag.name.it)
    : (client(scope.slice(7)) || {}).name || t('Cliente', 'Client');
  const eur = (n) => fmtEur(Math.round(n), lang);
  // all configurable KPIs
  const ALL_KPIS = {
    retention: { label: t('Tasso di ritorno', 'Retention'), value: S.retention + '%', goal: S.retentionGoal, raw: S.retention, delta: S.retentionDelta },
    rebooking: { label: t('Rebooking', 'Rebooking'), value: S.rebooking + '%', goal: S.rebookingGoal, raw: S.rebooking, delta: S.rebookingDelta },
    ticket: { label: t('Scontrino medio', 'Avg ticket'), value: eur(S.avgTicket), delta: S.avgDelta },
    occupancy: { label: t('Occupazione', 'Occupancy'), value: S.occupancy + '%', goal: S.occupancyGoal, raw: S.occupancy },
    revenue: { label: t('Incasso', 'Revenue'), value: eur(S.monthRevenue * pf), delta: S.monthDelta, spark: S.trend },
    clients: { label: t('Clienti serviti', 'Clients served'), value: S.clientsMonth * pf, delta: S.clientsDelta },
    retail: { label: t('Vendita prodotti', 'Retail sales'), value: eur(S.retailRevenue * pf), delta: S.retailDelta, sub: S.retailAttach + '% ' + t('acquista', 'buy') },
    noshow: { label: t('No-show', 'No-show'), value: S.noShowRate + '%', delta: S.noShowDelta, invert: true },
    gap: { label: t('Tra le visite', 'Visit gap'), value: S.avgGapDays + 'g', delta: S.avgGapDelta, invert: true },
  };
  const [favs, setFavs] = useStateDi(['retention', 'rebooking', 'ticket', 'occupancy']);
  const [cfgOpen, setCfgOpen] = useStateDi(false);
  const toggleFav = (k) => setFavs(f => f.includes(k) ? f.filter(x => x !== k) : (f.length < 4 ? [...f, k] : [...f.slice(1), k]));
  const [askText, setAskText] = useStateDi('');
  const [showAllIns, setShowAllIns] = useStateDi(false);
  const visIns = showAllIns ? INSIGHTS : INSIGHTS.slice(0, 3);
  return (
    <div className="dk-page" style={{ maxWidth: 1240 }}>
      {/* period selector + KPI config */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4 }}>
          {periods.map(([k, l]) => { const on = period === k; return <button key={k} onClick={() => setPeriod(k)} style={{ padding: '8px 16px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: on ? 'var(--ink)' : 'transparent', color: on ? '#fff' : 'var(--ink)' }}>{l}</button>; })}
        </div>
        {period === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="date" value={cFrom} max={cTo} onChange={e => setCFrom(e.target.value)} style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)' }} />
            <span className="t-sm" style={{ color: 'var(--muted-2)' }}>→</span>
            <input type="date" value={cTo} min={cFrom} onChange={e => setCTo(e.target.value)} style={{ border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)' }} />
          </div>
        )}
        {/* scope: all / by category / by single client */}
        <div style={{ position: 'relative' }}>
          <button className="dk-btn dk-btn--ghost" onClick={() => setScopeOpen(o => o ? '' : 'menu')} style={{ maxWidth: 220 }}><Icon name="clients" size={16} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scopeLabel}</span><Icon name="chevD" size={14} color="var(--muted)" /></button>
          {scopeOpen && (<React.Fragment>
            <div onClick={() => setScopeOpen('')} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
            <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 31, padding: 8, width: 270, boxShadow: 'var(--sh-pop)', maxHeight: 380, overflowY: 'auto' }}>
              <button className="dk-row" onClick={() => { setScope('all'); setScopeOpen(''); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '9px 9px', borderRadius: 8, textAlign: 'left', fontWeight: 600, fontSize: 13.5 }}>{scope === 'all' && <Icon name="check" size={14} color="var(--clay-ink)" />}{t('Tutti i clienti', 'All clients')}</button>
              <div className="t-meta" style={{ padding: '10px 8px 5px' }}>{t('Per categoria', 'By category')}</div>
              {clientCats.map(cat => { const on = scope === 'tag:' + cat.id; return (
                <button key={cat.id} className="dk-row" onClick={() => { setScope('tag:' + cat.id); setScopeOpen(''); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: cat.color, flexShrink: 0 }} /><span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{cat.name[lang] || cat.name.it}</span>{on && <Icon name="check" size={14} color="var(--clay-ink)" />}
                </button>); })}
              <div className="t-meta" style={{ padding: '10px 8px 5px' }}>{t('Singolo cliente', 'Single client')}</div>
              <div className="dk-search" style={{ width: '100%', height: 34, marginBottom: 4 }}>
                <Icon name="search" size={15} color="var(--muted-2)" />
                <input value={scopeQ} onChange={e => setScopeQ(e.target.value)} placeholder={t('Cerca cliente…', 'Search client…')} />
              </div>
              {CLIENTS.filter(c => !scopeQ || c.name.toLowerCase().includes(scopeQ.toLowerCase())).slice(0, 6).map(c => { const on = scope === 'client:' + c.id; return (
                <button key={c.id} className="dk-row" onClick={() => { setScope('client:' + c.id); setScopeOpen(''); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 9px', borderRadius: 8, textAlign: 'left' }}>
                  <Avatar initials={c.initials} size={24} color="var(--clay)" /><span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{c.name}</span>{on && <Icon name="check" size={14} color="var(--clay-ink)" />}
                </button>); })}
            </div>
          </React.Fragment>)}
        </div>
        {scope !== 'all' && <button onClick={() => setScope('all')} className="t-sm" style={{ cursor: 'pointer', background: 'transparent', border: 'none', fontWeight: 700, color: 'var(--clay-ink)' }}>{t('Azzera', 'Clear')}</button>}
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <button className="dk-btn dk-btn--ghost" onClick={() => setCfgOpen(o => !o)}><Icon name="settings" size={16} />{t('Personalizza', 'Customize')}</button>
          {cfgOpen && (<React.Fragment>
            <div onClick={() => setCfgOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
            <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 31, padding: 10, width: 250, boxShadow: 'var(--sh-pop)' }}>
              <div className="t-meta" style={{ padding: '2px 6px 8px' }}>{t('Scegli fino a 4 KPI', 'Pick up to 4 KPIs')}</div>
              {Object.entries(ALL_KPIS).map(([k, m]) => { const on = favs.includes(k); return (
                <button key={k} className="dk-row" onClick={() => toggleFav(k)} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 8px', borderRadius: 8, textAlign: 'left' }}>
                  <span style={{ width: 17, height: 17, borderRadius: 5, border: '1.6px solid ' + (on ? 'var(--clay)' : 'var(--faint)'), background: on ? 'var(--clay)' : 'transparent', display: 'grid', placeItems: 'center', flexShrink: 0 }}>{on && <Icon name="check" size={11} color="#fff" stroke={2.6} />}</span>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{m.label}</span>
                </button>); })}
            </div>
          </React.Fragment>)}
        </div>
      </div>

      {/* ── BAND 1 · actionable favorites ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 24 }}>
        {favs.map(k => { const m = ALL_KPIS[k]; const accent = 'var(--clay)'; return (
          <div key={k} className="dk-card" style={{ padding: 0, overflow: 'hidden', display: 'flex' }}>
            <span style={{ width: 4, flexShrink: 0, background: accent }} />
            <div style={{ flex: 1, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span className="t-meta">{m.label}</span>
                {m.delta != null && <Delta value={m.delta} invert={m.invert} />}
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
                <div className="t-num" style={{ fontSize: 30, lineHeight: 1 }}>{m.value}</div>
                {m.spark && <Sparkline data={m.spark} w={70} h={32} />}
              </div>
              {m.sub ? <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{m.sub}</div> : null}
            </div>
          </div>
        ); })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* left: composition + new/returning + per-stylist + charts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* new vs returning */}
          <div className="dk-card" style={{ padding: 22 }}>
            <div className="t-meta" style={{ marginBottom: 14 }}>{t('Nuovi vs di ritorno', 'New vs returning')}</div>
            {(() => { const nw = S.newClients, rt = S.returningClients, tot = nw + rt; return (
              <React.Fragment>
                <div style={{ display: 'flex', height: 16, borderRadius: 99, overflow: 'hidden', marginBottom: 12 }}>
                  <div style={{ width: (rt / tot * 100) + '%', background: 'var(--clay)' }} />
                  <div style={{ width: (nw / tot * 100) + '%', background: 'var(--op-asia, #C2E8CB)' }} />
                </div>
                <div style={{ display: 'flex', gap: 24 }}>
                  <div><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 99, background: 'var(--clay)' }} /><span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Di ritorno', 'Returning')}</span></div><div className="t-num" style={{ fontSize: 20, marginTop: 3 }}>{rt} <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{Math.round(rt / tot * 100)}%</span></div></div>
                  <div><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 99, background: 'var(--op-asia, #C2E8CB)' }} /><span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Nuovi', 'New')}</span></div><div className="t-num" style={{ fontSize: 20, marginTop: 3 }}>{nw} <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{Math.round(nw / tot * 100)}%</span></div></div>
                  <div style={{ marginLeft: 'auto', textAlign: 'right' }}><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Frequenza media', 'Avg frequency')}</div><div className="t-num" style={{ fontSize: 20, marginTop: 3 }}>{S.avgGapDays} {t('giorni', 'days')}</div></div>
                </div>
              </React.Fragment>
            ); })()}
          </div>

          {/* per-stylist productivity removed */}

          {/* client category breakdown */}
          <div className="dk-card" style={{ padding: 22 }}>
            <div className="t-meta" style={{ marginBottom: 14 }}>{t('Clienti per categoria', 'Clients by category')}</div>
            {(() => {
              const tags = window.dkClientTags;
              const counts = clientCats.map(cc => ({ cc, n: CLIENTS.filter(c => tags ? tags(c, clientCats).includes(cc.id) : false).length }));
              const tot = counts.reduce((a, x) => a + x.n, 0) || 1;
              return (
                <React.Fragment>
                  <div style={{ display: 'flex', height: 16, borderRadius: 99, overflow: 'hidden', marginBottom: 14 }}>
                    {counts.map(x => x.n > 0 && <div key={x.cc.id} title={x.cc.name[lang]} style={{ width: (x.n / tot * 100) + '%', background: x.cc.color }} />)}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
                    {counts.map(x => (
                      <div key={x.cc.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 99, background: x.cc.color, flexShrink: 0 }} />
                        <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, color: 'var(--ink-2)' }}>{x.cc.name[lang] || x.cc.name.it}</span>
                        <span className="t-num" style={{ fontSize: 14 }}>{x.n}</span>
                        <span className="t-sm" style={{ color: 'var(--muted-2)', minWidth: 34, textAlign: 'right' }}>{Math.round(x.n / tot * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </React.Fragment>
              );
            })()}
          </div>

          {/* ── BAND 2 · volume & composition (existing charts) ── */}
          <div className="dk-card" style={{ padding: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div><div className="t-meta" style={{ whiteSpace: 'nowrap' }}>{t('Andamento · 10 settimane', 'Trend · 10 weeks')}</div><div className="t-num" style={{ fontSize: 28, marginTop: 6 }}>{eur(S.monthRevenue * pf)}</div></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Delta value={S.monthDelta} /><span className="t-sm" style={{ color: 'var(--muted)' }}>{t('vs prec.', 'vs prev.')}</span></div>
            </div>
            <BarTrend data={S.trend} lang={lang} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="dk-card" style={{ padding: 20 }}>
              <div className="t-meta" style={{ marginBottom: 16 }}>{t('Per categoria', 'By category')}</div>
              {S.byService.map((s, i) => (
                <div key={s.id} style={{ marginTop: i ? 13 : 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}><span style={{ fontWeight: 600, fontSize: 13.5 }}>{s.label[lang]}</span><span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><span className="t-num" style={{ fontSize: 14 }}>{fmtEur(s.val, lang)}</span><Delta value={s.delta} /></span></div>
                  <ProgressBar value={(s.val / maxSvc) * 100} color={['var(--op-mara)', 'var(--clay)', 'var(--op-lina)', 'var(--op-asia)'][i]} />
                </div>
              ))}
            </div>
            <div className="dk-card" style={{ padding: 20 }}>
              <div className="t-meta" style={{ marginBottom: 16 }}>{t('Occupazione per giorno', 'Occupancy by day')}</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, height: 140 }}>
                {(() => { const vals = S.weekday.map(w => w.v); const lo = Math.min(...vals); const hi = Math.max(...vals); return S.weekday.map(w => {
                  const barCol = w.v === lo ? '#F4A6A6' : w.v >= hi - 5 ? '#BCE3C0' : '#CBCED8';
                  const numCol = w.v === lo ? '#C0524F' : w.v >= hi - 5 ? '#3F8A50' : 'var(--muted-2)';
                  return (
                  <div key={w.d.it} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, height: '100%', justifyContent: 'flex-end' }}>
                    <span className="t-sm" style={{ fontSize: 10.5, fontWeight: 700, color: numCol }}>{w.v}</span>
                    <div style={{ width: '64%', maxWidth: 26, height: w.v + '%', minHeight: 5, borderRadius: 6, background: barCol, transition: 'height 600ms var(--ease-emph)' }} />
                    <span className="t-sm" style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{w.d[lang]}</span>
                  </div>
                ); }); })()}
              </div>
              <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center', marginTop: 12 }}>{t('Il martedì è il giorno più scarico', 'Tuesday is the quietest day')}</div>
            </div>
          </div>
        </div>

        {/* right: AI — ask bar + max 3 cards + see all */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignSelf: 'stretch' }}>
          {/* prominent ask bar */}
          <div style={{ padding: 16, borderRadius: '24px 24px 24px 10px', background: 'linear-gradient(120deg, #A78BFA, #C9B8F2)', boxShadow: '0 12px 30px rgba(167,139,250,0.32)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ width: 34, height: 34, borderRadius: '12px 12px 6px 12px', background: 'rgba(255,255,255,0.28)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="sparkle" size={18} color="#fff" /></div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 16, fontWeight: 700, color: '#fff', lineHeight: 1.1 }}>{t('Chiedi a Youty', 'Ask Youty')}</div><div style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', marginTop: 1 }}>{t('Interroga i tuoi dati a parole', 'Query your data in plain words')}</div></div>
            </div>
            <div style={{ display: 'flex', gap: 8, background: '#fff', borderRadius: 12, padding: '5px 5px 5px 14px', alignItems: 'center' }}>
              <input value={askText} onChange={e => setAskText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { window.__openAnalyst && window.__openAnalyst(); } }} placeholder={t('es. Qual è il giorno più scarico?', 'e.g. Which day is quietest?')} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, fontFamily: 'var(--sans)', minWidth: 0 }} />
              <button onClick={() => window.__openAnalyst && window.__openAnalyst()} style={{ width: 34, height: 34, borderRadius: 99, background: 'var(--ink)', display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}><Icon name="send" size={15} color="#fff" /></button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="t-meta">{t('Suggerimenti', 'Suggestions')}</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: '#7C3AED', background: 'var(--clay-tint)', minWidth: 22, height: 20, padding: '0 7px', borderRadius: 99, display: 'inline-grid', placeItems: 'center' }}>{INSIGHTS.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {visIns.map((ins, i) => <DkInsightCard key={ins.id} ins={ins} idx={i} t={t} lang={lang} fireToast={fireToast} />)}
          </div>
          {INSIGHTS.length > 3 && <button className="dk-btn dk-btn--ghost" style={{ width: '100%' }} onClick={() => setShowAllIns(v => !v)}>{showAllIns ? t('Mostra meno', 'Show less') : t('Vedi tutti', 'See all') + ' (' + INSIGHTS.length + ')'}</button>}
        </div>
      </div>
    </div>
  );
}

function BigStat({ label, value, delta, spark, sub }) {
  return (
    <div className="dk-card" style={{ padding: 20 }}>
      <div className="t-meta" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div className="t-num" style={{ fontSize: 30, lineHeight: 1 }}>{value}</div>
        {spark && <Sparkline data={spark} w={84} h={36} />}
      </div>
      <div style={{ marginTop: 8 }}>{delta != null ? <Delta value={delta} /> : <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{sub}</span>}</div>
    </div>
  );
}

function BarTrend({ data, lang }) {
  const max = Math.max(...data);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 150 }}>
      {data.map((v, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, height: '100%', justifyContent: 'flex-end' }}>
          <div style={{ width: '100%', maxWidth: 40, height: (v / max) * 100 + '%', borderRadius: '7px 7px 0 0', background: i === data.length - 1 ? 'var(--clay)' : 'var(--paper-2)', transition: 'height 700ms var(--ease-emph)', position: 'relative' }}>
            {i === data.length - 1 && <span className="t-num" style={{ position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%)', fontSize: 12, color: 'var(--clay-ink)', whiteSpace: 'nowrap' }}>{v}k</span>}
          </div>
          <span className="t-sm" style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>{i === 0 ? 'S1' : i === data.length - 1 ? t_now(lang) : 'S' + (i + 1)}</span>
        </div>
      ))}
    </div>
  );
}
function t_now(lang) { return lang === 'en' ? 'now' : 'ora'; }

function DkInsightCard({ ins, idx, t, lang, fireToast }) {
  const [open, setOpen] = useStateDi(false);
  const [gone, setGone] = useStateDi(false);
  if (gone) return null;
  // per-card purple/lilac gradient + asymmetric "blob" radii + varied sizing
  const themes = [
    { grad: 'linear-gradient(135deg, #C9B8F2, #DDD6FE)', radius: '28px 14px 28px 14px', glow: 'rgba(201,184,242,0.45)' },
    { grad: 'linear-gradient(135deg, #C3CDF7, #E9E4FB)', radius: '14px 30px 16px 30px', glow: 'rgba(195,205,247,0.45)' },
    { grad: 'linear-gradient(135deg, #A78BFA, #C9B8F2)', radius: '30px 18px 30px 18px', glow: 'rgba(167,139,250,0.4)' },
    { grad: 'linear-gradient(135deg, #D8CBF0, #DDD6FE)', radius: '16px 28px 28px 14px', glow: 'rgba(216,203,240,0.45)' },
    { grad: 'linear-gradient(135deg, #B3B0F0, #C3CDF7)', radius: '26px 14px 22px 28px', glow: 'rgba(179,176,240,0.42)' },
  ];
  const th = themes[idx % themes.length];
  const pad = idx % 2 === 0 ? 22 : 18;
  return (
    <div style={{ background: th.grad, borderRadius: th.radius, boxShadow: `0 10px 26px ${th.glow}`, padding: pad, position: 'relative', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ width: 38, height: 38, borderRadius: '14px 10px 14px 10px', background: 'rgba(255,255,255,0.55)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="bulb" size={19} color="#7C3AED" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: idx % 2 === 0 ? 15.5 : 14.5, lineHeight: 1.38, color: '#2A2150' }}>{ins.text[lang]}</div>
          <button onClick={() => setOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 9, padding: '5px 12px', borderRadius: 99, background: 'rgba(255,255,255,0.5)', fontSize: 12.5, fontWeight: 700, color: '#5B3FA8', cursor: 'pointer' }}>{t('Perché', 'Why')}<Icon name={open ? 'chevU' : 'chevD'} size={13} color="#5B3FA8" /></button>
          {open && <div style={{ marginTop: 10, padding: '11px 13px', background: 'rgba(255,255,255,0.6)', borderRadius: '14px 14px 14px 6px', fontSize: 13, color: '#473b6e', lineHeight: 1.5 }}>{ins.why[lang]}<div style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, color: '#3F8A50', fontWeight: 700 }}><Icon name="trend" size={14} color="#3F8A50" />{ins.expected[lang]}</div></div>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
        <button onClick={() => fireToast({ msg: ins.action[lang], icon: 'wand' })} style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 8, height: 42, padding: '0 8px 0 16px', borderRadius: 99, background: 'rgba(44,33,80,0.9)', color: '#fff', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', justifyContent: 'space-between' }}>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ins.action[lang]}</span>
          <span style={{ width: 30, height: 30, borderRadius: 99, background: 'rgba(255,255,255,0.22)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="chevR" size={16} color="#fff" /></span>
        </button>
        <button onClick={() => setGone(true)} title={t('Ignora', 'Dismiss')} style={{ width: 42, height: 42, borderRadius: 99, background: 'rgba(255,255,255,0.55)', display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}><Icon name="x" size={17} color="#5B3FA8" /></button>
      </div>
    </div>
  );
}

/* ---------- Analyst drawer ---------- */
function dkAnswer(qIdx, t, lang) {
  const A = ANALYST_REPLY;
  switch (qIdx) {
    case 0: return { number: A.number, delta: A.delta, spark: A.spark, interp: A.interp[lang], period: A.period[lang], followups: [1, 4, 3] };
    case 1: return { number: t('Martedì', 'Tuesday'), interp: t('Il martedì è pieno solo al 41%, contro il 96% del sabato. Ideale per promo o riattivazione dormienti.', 'Tuesday is only 41% full vs 96% on Saturday. Ideal for a promo or dormant win-back.'), bars: STATS.weekday, period: t('Ultime 8 settimane', 'Last 8 weeks'), followups: [4, 2], action: t('Crea offerta per il martedì', 'Create a Tuesday offer') };
    case 2: return { list: [['Valentina Russo', 4980], ['Giada Bellini', 3260], ['Sofia Ricci', 2140], ['Federica Mancini', 1870], ['Elena Conti', 1490]], interp: t('Le tue 5 clienti top valgono €13.740, il 28% del fatturato annuo.', 'Your top 5 clients are worth €13,740 — 28% of yearly revenue.'), period: t('Ultimi 12 mesi', 'Last 12 months'), followups: [4, 5] };
    case 3: return { number: fmtEur(8200, lang), delta: '+9%', interp: t('Il colore ha incassato €8.200 (+9%), il nail €6.100 (-6%). Vale la pena rilanciare gli smalti.', 'Colour took €8,200 (+9%), nails €6,100 (-6%). Worth a gel-polish push.'), spark: [6.9, 7.1, 7.4, 7.0, 7.6, 7.9, 8.0, 8.2], period: t('Ottobre 2025', 'Oct 2025'), followups: [0, 5], action: t('Riattiva le clienti smalto', 'Win back gel-polish clients') };
    case 4: return { number: fmtEur(54, lang), delta: '+3%', interp: t('Lo scontrino medio è €54 (+3%). Chi aggiunge nail art spende €18 in più.', 'Average ticket €54 (+3%). Clients adding nail art spend €18 more.'), spark: [49, 51, 50, 52, 53, 52, 54], period: t('Ottobre 2025', 'Oct 2025'), followups: [0, 3] };
    case 5: return { honest: true, number: '23', interp: t('Hai 23 clienti senza visite da oltre 90 giorni. Per il dettaglio per operatrice mi servirebbe qualche dato in più — preparo la lista per la riattivazione?', 'You have 23 clients with no visit in 90+ days. For a per-stylist breakdown I’d need more data — shall I prepare the win-back list?'), period: t('Aggiornato a oggi', 'As of today'), followups: [1], action: t('Prepara riattivazione', 'Prepare win-back') };
    case 6: return { number: fmtEur(4300, lang), delta: '+11%', interp: t('Il retail ha incassato €4.300 (24% del totale), i servizi €13.700. Il retail cresce del +11%: spingi i prodotti al check-out.', 'Retail took €4,300 (24% of total), services €13,700. Retail is up +11%: push products at check-out.'), spark: [3.2, 3.5, 3.4, 3.8, 4.0, 3.9, 4.1, 4.3], period: t('Ottobre 2025', 'Oct 2025'), followups: [4, 2] };
    case 7: return { honest: true, number: '4', interp: t('4 prodotti sono sotto la soglia minima: Smalto gel "Carmine", Tinta 6.0, Cotone in dischetti e Maschera viso. Preparo l’ordine ai fornitori?', '4 products are below their minimum: Gel polish "Carmine", Colour 6.0, Cotton pads and Face mask. Shall I draft the supplier order?'), period: t('Aggiornato a oggi', 'As of today'), followups: [6], action: t('Vai agli ordini magazzino', 'Go to inventory orders') };
    default: return { honest: true, interp: t('Non ho ancora abbastanza dati per rispondere con precisione. Prova una di queste domande.', 'Not enough data to answer precisely yet. Try one of these.'), followups: [0, 1, 4] };
  }
}

function DkAnalyst({ open, onClose }) {
  const { t, lang, fireToast } = useDk();
  const [msgs, setMsgs] = useStateDi([]);
  const [typing, setTyping] = useStateDi(false);
  const [text, setText] = useStateDi('');
  const [listening, setListening] = useStateDi(false);
  const scroller = useRefDi(null);
  useEffectDi(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [msgs, typing]);
  function ask(qIdx, label) { setMsgs(m => [...m, { role: 'user', text: label }]); setTyping(true); setText(''); setTimeout(() => { setTyping(false); setMsgs(m => [...m, { role: 'ai', ans: dkAnswer(qIdx, t, lang) }]); }, 900); }
  function sendTyped() { if (!text.trim()) return; const idx = ASK_CHIPS.findIndex(c => c.it.toLowerCase().includes(text.toLowerCase().slice(0, 6)) || c.en.toLowerCase().includes(text.toLowerCase().slice(0, 6))); ask(idx >= 0 ? idx : 99, text); }
  function voice() { setListening(true); setTimeout(() => { setListening(false); ask(0, ASK_CHIPS[0][lang]); }, 1500); }
  return (
    <DkDrawer open={open} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px', borderBottom: '1px solid var(--hair)' }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center' }}><Icon name="sparkle" size={20} color="var(--clay-ink)" /></div>
        <div style={{ flex: 1 }}><div className="t-h3">Youty</div><div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Il tuo analista AI', 'Your AI analyst')}</div></div>
        <button className="dk-iconbtn" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div ref={scroller} className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        {!msgs.length && (
          <div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>{t('Ciao, sono Youty 👋 Chiedimi qualsiasi cosa sui tuoi numeri e ti dirò cosa conviene fare. Parla o scrivi.', 'Hi, I’m Youty 👋 Ask me anything about your numbers and I’ll tell you what to do next. Speak or type.')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ASK_CHIPS.map((c, i) => <button key={i} className="dk-row" onClick={() => ask(i, c[lang])} style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--hair)', fontWeight: 600, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 9 }}><Icon name="search" size={14} color="var(--clay)" />{c[lang]}</button>)}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {msgs.map((m, i) => m.role === 'user'
            ? <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--ink)', color: '#fff', padding: '10px 14px', borderRadius: '16px 16px 4px 16px', fontSize: 14, fontWeight: 500 }}>{m.text}</div>
            : <DkAnswerBubble key={i} ans={m.ans} t={t} lang={lang} onFollow={ask} onAction={(a) => { onClose(); fireToast({ msg: a, icon: 'wand' }); }} />)}
          {typing && <div style={{ alignSelf: 'flex-start', background: 'var(--surface-2)', border: '1px solid var(--hair)', padding: '12px 14px', borderRadius: '16px 16px 16px 4px', display: 'flex', gap: 5, alignItems: 'center' }}><span className="t-sm" style={{ color: 'var(--muted)', marginRight: 3 }}>{t('Sto pensando', 'Thinking')}</span><span className="tdot" /><span className="tdot" /><span className="tdot" /></div>}
        </div>
      </div>
      <div style={{ padding: '12px 18px 16px', borderTop: '1px solid var(--hair)' }}>
        {listening && <div className="t-sm" style={{ textAlign: 'center', color: 'var(--clay-ink)', marginBottom: 8, fontWeight: 600 }}>{t('Ti ascolto…', 'Listening…')}</div>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="dk-search" style={{ flex: 1, width: 'auto', paddingRight: 6 }}>
            <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendTyped()} placeholder={t('Scrivi una domanda…', 'Type a question…')} />
            <button onClick={sendTyped} style={{ width: 32, height: 32, borderRadius: 99, background: text.trim() ? 'var(--clay)' : 'var(--paper-2)', display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}><Icon name="send" size={15} color={text.trim() ? '#fff' : 'var(--muted-2)'} /></button>
          </div>
          <button onClick={voice} className="dk-iconbtn" style={{ background: listening ? 'var(--clay)' : 'var(--ink)', borderColor: 'transparent' }}><Icon name="mic" size={19} color="#fff" /></button>
        </div>
      </div>
    </DkDrawer>
  );
}

function DkAnswerBubble({ ans, t, lang, onFollow, onAction }) {
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: '16px 16px 16px 4px', padding: 15, boxShadow: 'var(--sh-sm)' }}>
      {ans.number && <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 7 }}><span className="t-num" style={{ fontSize: 28 }}>{ans.number}</span>{ans.delta && <Delta value={parseInt(ans.delta)} />}</div>}
      {ans.spark && <div style={{ margin: '2px 0 10px' }}><Sparkline data={ans.spark} w={220} h={44} /></div>}
      {ans.bars && <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 62, margin: '2px 0 10px' }}>{ans.bars.map(b => <div key={b.d.it} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, justifyContent: 'flex-end', height: '100%' }}><div style={{ width: '62%', height: b.v + '%', borderRadius: 4, background: b.v < 50 ? 'var(--warn)' : 'var(--ink)' }} /><span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--muted-2)' }}>{b.d[lang]}</span></div>)}</div>}
      {ans.list && <div style={{ margin: '2px 0 10px' }}>{ans.list.map(([n, v], i) => <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', borderTop: i ? '1px solid var(--hair)' : 'none' }}><span className="t-num" style={{ fontSize: 13, color: 'var(--muted-2)', width: 14 }}>{i + 1}</span><Avatar initials={n.split(' ').map(w => w[0]).join('')} size={28} /><span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{n}</span><span className="t-num" style={{ fontSize: 13.5 }}>{fmtEur(v, lang)}</span></div>)}</div>}
      <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--ink-2)' }}>{ans.interp}</div>
      {ans.period && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 7, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="info" size={12} color="var(--muted-2)" />{ans.period}</div>}
      {ans.action && <button className="dk-btn dk-btn--clay" style={{ height: 40, marginTop: 11, width: '100%', fontSize: 13.5 }} onClick={() => onAction(ans.action)}><Icon name="wand" size={15} color="#fff" />{ans.action}</button>}
      {ans.followups && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 11 }}>{ans.followups.map(fi => <button key={fi} onClick={() => onFollow(fi, ASK_CHIPS[fi][lang])} style={{ fontSize: 12, fontWeight: 600, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '6px 11px', borderRadius: 99, cursor: 'pointer' }}>{ASK_CHIPS[fi][lang]}</button>)}</div>}
    </div>
  );
}

Object.assign(window, { DkInsight, DkAnalyst });
