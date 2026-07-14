// insight/index.jsx — ANALISI DATI section, ported from desktop-insight.jsx
// (DkInsight) and wired to the real /api/insights/* endpoints (owner-only).
//
// Adaptations vs the prototype (see final report):
// - "custom" period dropped — the API only supports month|quarter|year.
// - Scope selector (all clients / by category / single client) dropped — the API
//   has no scope filter on the insights endpoints.
// - AI suggestion cards (INSIGHTS mock) replaced by one static "fase 2" card.
// - Analyst drawer wired to POST /api/insights/ask which 501s until fase 2.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, Icon, fmtEur } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { buildAllKpis, loadFavs, saveFavs, prevPeriodAnchor, DEFAULT_FAVS } from './kpiDefs.js';
import KpiBand from './KpiBand.jsx';
import { BarTrend, CategoryBars, OccupancyByWeekday, NewVsReturning, ClientsByCategory } from './Charts.jsx';
import AskYoutyPanel from './AskYoutyPanel.jsx';
import AnalystDrawer from './AnalystDrawer.jsx';

const GRANULARITY = { month: 'day', quarter: 'week', year: 'month' };

export default function InsightSection() {
  const { t, lang, session, clientCategories, fireToast, setDrawer } = useDash();

  if (!session?.is_owner) return <OwnerLock t={t} />;
  return <InsightOwner t={t} lang={lang} clientCategories={clientCategories} fireToast={fireToast} setDrawer={setDrawer} />;
}

/* ---------------- non-owner lock state ---------------- */
function OwnerLock({ t }) {
  return (
    <div className="dk-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div className="dk-card" style={{ padding: '48px 56px', textAlign: 'center', maxWidth: 440 }}>
        <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}>
          <Icon name="lock" size={28} color="var(--clay-ink)" />
        </div>
        <div className="t-title" style={{ marginBottom: 8 }}>{t('Funzione riservata al titolare', 'Owner-only feature')}</div>
        <div className="t-body" style={{ color: 'var(--muted)' }}>
          {t('L’analisi dati del salone è visibile solo al titolare. Chiedi al titolare se ti serve un report.', 'Salon analytics are visible to the owner only. Ask the owner if you need a report.')}
        </div>
      </div>
    </div>
  );
}

/* ---------------- owner view ---------------- */
function InsightOwner({ t, lang, clientCategories, fireToast, setDrawer }) {
  const [period, setPeriod] = useState('month');
  const [mode, setMode] = useState('period');   // 'period' | 'custom'
  const [rFrom, setRFrom] = useState('');        // data iniziale intervallo (YYYY-MM-DD)
  const [rTo, setRTo] = useState('');            // data finale intervallo
  const [applied, setApplied] = useState(null);  // { from, to } dopo "Applica" → guida la fetch
  const dateCss = { border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, padding: '7px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', color: 'var(--ink)' };
  const [loading, setLoading] = useState(true);
  const [kpis, setKpis] = useState(null);
  const [prevKpis, setPrevKpis] = useState(null);
  const [series, setSeries] = useState([]);
  const [byCategory, setByCategory] = useState([]);
  const [weekday, setWeekday] = useState([]);

  const [favs, setFavs] = useState(loadFavs);
  const toggleFav = useCallback((k) => {
    setFavs((f) => {
      let next = f.includes(k) ? f.filter((x) => x !== k)
        : f.length < 4 ? [...f, k] : [...f.slice(1), k];
      if (!next.length) next = DEFAULT_FAVS;
      saveFavs(next);
      return next;
    });
  }, []);

  // granularità dell'intervallo personalizzato in base all'ampiezza (giorni)
  const customGranularity = (from, to) => {
    const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    return days <= 45 ? 'day' : days <= 190 ? 'week' : 'month';
  };
  const isCustom = mode === 'custom' && !!applied;
  const granularity = isCustom ? customGranularity(applied.from, applied.to) : GRANULARITY[period];

  useEffect(() => {
    if (mode === 'custom' && !applied) return; // intervallo scelto ma non ancora confermato: attende "Applica"
    let alive = true;
    setLoading(true);
    const base = isCustom ? { date_from: applied.from, date_to: applied.to } : { period };
    Promise.all([
      api.get('/api/insights/kpis', { params: base }),
      // confronto col periodo precedente solo per i periodi standard (per un intervallo libero non è definito)
      isCustom ? Promise.resolve(null)
        : api.get('/api/insights/kpis', { params: { period, date: prevPeriodAnchor(period) } }).catch(() => null),
      api.get('/api/insights/revenue-series', { params: { ...base, granularity } }),
      api.get('/api/insights/revenue-by-category', { params: base }),
      api.get('/api/insights/occupancy-by-weekday', { params: base }),
    ]).then(([k, pk, rs, rc, ow]) => {
      if (!alive) return;
      setKpis(k); setPrevKpis(pk); setSeries(rs || []); setByCategory(rc || []); setWeekday(ow || []);
    }).catch((err) => {
      if (!alive) return;
      if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' });
      else fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [period, mode, applied, granularity, isCustom, fireToast, t]);

  // fmtEur(0) says "Gratis" (price convention) — for KPI money we want "€0".
  const eur = useCallback((n) => {
    const v = Math.round(Number(n) || 0);
    return v === 0 ? '€0' : fmtEur(v, lang);
  }, [lang]);
  const allKpis = useMemo(() => buildAllKpis(kpis, prevKpis, t, lang, eur), [kpis, prevKpis, t, lang, eur]);

  const totalRevenue = Number(kpis?.revenue || 0);
  const revenueDelta = allKpis.revenue?.delta;

  const openAnalyst = useCallback((initialQuestion) => {
    setDrawer(
      <AnalystDrawer t={t} lang={lang} fireToast={fireToast} onClose={() => setDrawer(null)} initialQuestion={initialQuestion} />
    );
  }, [setDrawer, t, lang, fireToast]);

  const periods = [
    ['month', t('Mese', 'Month')],
    ['quarter', t('Trimestre', 'Quarter')],
    ['year', t('Anno', 'Year')],
  ];

  const trendTitle = isCustom
    ? t('Andamento · intervallo scelto', 'Trend · selected range')
    : {
      month: t('Andamento · giorno per giorno', 'Trend · day by day'),
      quarter: t('Andamento · per settimana', 'Trend · by week'),
      year: t('Andamento · per mese', 'Trend · by month'),
    }[period];

  return (
    <div className="dk-page" style={{ maxWidth: 1240 }}>
      {/* period selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4 }}>
          {periods.map(([k, l]) => {
            const on = mode === 'period' && period === k;
            return (
              <button key={k} onClick={() => { setMode('period'); setPeriod(k); }} style={{ padding: '8px 16px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: on ? 'var(--ink)' : 'transparent', color: on ? '#fff' : 'var(--ink)' }}>
                {l}
              </button>
            );
          })}
          <button onClick={() => setMode('custom')} style={{ padding: '8px 16px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: mode === 'custom' ? 'var(--ink)' : 'transparent', color: mode === 'custom' ? '#fff' : 'var(--ink)' }}>
            {t('Personalizzato', 'Custom')}
          </button>
        </div>

        {/* intervallo di date personalizzato — si aggiorna solo premendo "Applica" */}
        {mode === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="t-meta">{t('Dal', 'From')}</span>
            <input type="date" value={rFrom} max={rTo || undefined} onChange={(e) => setRFrom(e.target.value)} style={dateCss} />
            <span className="t-meta">{t('al', 'to')}</span>
            <input type="date" value={rTo} min={rFrom || undefined} onChange={(e) => setRTo(e.target.value)} style={dateCss} />
            <button className="dk-btn dk-btn--clay" style={{ height: 38 }}
              disabled={!rFrom || !rTo || rFrom > rTo || (!!applied && applied.from === rFrom && applied.to === rTo)}
              onClick={() => setApplied({ from: rFrom, to: rTo })}>
              <Icon name="search" size={15} color="#fff" />{t('Applica', 'Apply')}
            </button>
            {!applied && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Scegli le date e premi Applica', 'Pick the dates and press Apply')}</span>}
            {!!applied && (applied.from !== rFrom || applied.to !== rTo) && (
              <span className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600 }}>{t('Premi Applica per aggiornare', 'Press Apply to refresh')}</span>
            )}
          </div>
        )}
        <div style={{ flex: 1 }} />
      </div>

      {loading ? <InsightSkeleton /> : (
        <React.Fragment>
          {/* BAND 1 · customizable favourites */}
          <KpiBand allKpis={allKpis} favs={favs} onToggleFav={toggleFav} t={t} />

          <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16, alignItems: 'start' }}>
            {/* left column: composition + charts */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="dk-card" style={{ padding: 22 }}>
                <div className="t-meta" style={{ marginBottom: 14 }}>{t('Nuovi vs di ritorno', 'New vs returning')}</div>
                <NewVsReturning cur={kpis} t={t} />
              </div>

              <div className="dk-card" style={{ padding: 22 }}>
                <div className="t-meta" style={{ marginBottom: 14 }}>{t('Clienti per categoria', 'Clients by category')}</div>
                <ClientsByCategory rows={kpis?.clients_by_category || []} clientCategories={clientCategories} lang={lang} t={t} />
              </div>

              <div className="dk-card" style={{ padding: 22 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
                  <div>
                    <div className="t-meta" style={{ whiteSpace: 'nowrap' }}>{trendTitle}</div>
                    <div className="t-num" style={{ fontSize: 28, marginTop: 6 }}>{eur(totalRevenue)}</div>
                  </div>
                  {revenueDelta != null && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: revenueDelta >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                        {(revenueDelta >= 0 ? '+' : '') + revenueDelta + '%'}
                      </span>
                      <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('vs prec.', 'vs prev.')}</span>
                    </div>
                  )}
                </div>
                <BarTrend points={series} granularity={granularity} lang={lang} t={t} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div className="dk-card" style={{ padding: 20 }}>
                  <div className="t-meta" style={{ marginBottom: 16 }}>{t('Per categoria', 'By category')}</div>
                  <CategoryBars rows={byCategory} lang={lang} />
                </div>
                <div className="dk-card" style={{ padding: 20 }}>
                  <div className="t-meta" style={{ marginBottom: 16 }}>{t('Occupazione per giorno', 'Occupancy by day')}</div>
                  <OccupancyByWeekday rows={weekday} lang={lang} t={t} />
                </div>
              </div>
            </div>

            {/* right column: Ask Youty + fase-2 suggestions card */}
            <AskYoutyPanel t={t} onOpenAnalyst={openAnalyst} />
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

function InsightSkeleton() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 24 }}>
        {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 108, borderRadius: 16 }} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="skel" style={{ height: 130, borderRadius: 16 }} />
          <div className="skel" style={{ height: 160, borderRadius: 16 }} />
          <div className="skel" style={{ height: 260, borderRadius: 16 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="skel" style={{ height: 220, borderRadius: 16 }} />
            <div className="skel" style={{ height: 220, borderRadius: 16 }} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="skel" style={{ height: 130, borderRadius: 24 }} />
          <div className="skel" style={{ height: 200, borderRadius: 24 }} />
        </div>
      </div>
    </div>
  );
}
