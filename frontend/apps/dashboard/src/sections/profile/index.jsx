// profile/index.jsx — owner/staff profile page. Lean port of OwnerProfilePage
// from desktop-shell.jsx: identity from session.user + salon from ctx, real
// this-month KPI snapshot from /api/insights/kpis (owner-only — hidden for
// staff), locations from ctx, logout via staffAuth.logout().
//
// Adaptations vs the prototype (see final report): the mocked multi-location
// consolidated report (DK_LOC_REPORT) and cross-location staff leaderboard
// (DK_OWNER_STAFF) were dropped — the API has no per-location report endpoint;
// KPIs shown are salon-wide, locations render as a plain list.
import React, { useEffect, useState } from 'react';
import { api, ApiError, staffAuth, Icon, Avatar, fmtEur } from '@youty/shared';
import { useDash } from '../../ctx.jsx';

export default function ProfileSection() {
  const { t, lang, session, salon, locations, fireToast } = useDash();
  const isOwner = !!session?.is_owner;

  const [kpis, setKpis] = useState(null);
  const [kpisLoading, setKpisLoading] = useState(isOwner);

  useEffect(() => {
    if (!isOwner) return undefined;
    let alive = true;
    setKpisLoading(true);
    api.get('/api/insights/kpis', { params: { period: 'month' } })
      .then((k) => { if (alive) setKpis(k); })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' });
        else fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
      })
      .finally(() => { if (alive) setKpisLoading(false); });
    return () => { alive = false; };
  }, [isOwner, fireToast, t]);

  const name = session?.user?.name || '';
  const initials = name.split(/\s+/).map((w) => w.charAt(0)).slice(0, 2).join('').toUpperCase() || '?';
  // fmtEur(0) says "Gratis" (price convention) — for KPI money we want "€0".
  const eur = (n) => {
    const v = Math.round(Number(n) || 0);
    return v === 0 ? '€0' : fmtEur(v, lang);
  };

  const kpiCards = kpis ? [
    [t('Incasso del mese', 'Month revenue'), eur(kpis.revenue), 'wallet'],
    [t('Appuntamenti completati', 'Completed appts'), String(kpis.appointments_count), 'calendar'],
    [t('Occupazione', 'Occupancy'), Math.round(kpis.occupancy_pct) + '%', 'target'],
    [t('Scontrino medio', 'Avg ticket'), eur(kpis.avg_ticket), 'clients'],
  ] : [];

  return (
    <div className="dk-page" style={{ maxWidth: 1180 }}>
      {/* identity header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <Avatar initials={initials} size={60} color="var(--clay-tint2)" ring />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, lineHeight: 1.1 }}>{name}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>
            {(isOwner ? t('Titolare', 'Owner') : t('Staff', 'Staff'))
              + (salon?.name ? ' · ' + salon.name : '')
              + (session?.user?.email ? ' · ' + session.user.email : '')}
          </div>
        </div>
        <button className="dk-btn dk-btn--ghost" onClick={() => staffAuth.logout()} style={{ color: 'var(--danger)' }}>
          <Icon name="x" size={16} color="var(--danger)" />{t('Esci', 'Log out')}
        </button>
      </div>

      {/* this-month KPI snapshot (owner only) */}
      {isOwner && (
        <React.Fragment>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Il tuo salone · questo mese', 'Your salon · this month')}</div>
          {kpisLoading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
              {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 82, borderRadius: 16 }} />)}
            </div>
          ) : kpis && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
              {kpiCards.map(([l, v, ic], i) => (
                <div key={i} className="dk-card" style={{ padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                    <Icon name={ic} size={15} color="var(--clay-ink)" />
                    <span className="t-meta">{l}</span>
                  </div>
                  <div className="t-num" style={{ fontSize: 22, fontWeight: 800 }}>{v}</div>
                </div>
              ))}
            </div>
          )}
        </React.Fragment>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, alignItems: 'start' }}>
        {/* locations */}
        <div>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Sedi', 'Locations')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {locations.map((l) => (
              <div key={l.id} className="dk-card" style={{ padding: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name="mapPin" size={16} color="var(--clay-ink)" />
                  <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{l.name}</span>
                  {l.is_default && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 10px', borderRadius: 99 }}>
                      {t('Principale', 'Default')}
                    </span>
                  )}
                </div>
                {(l.address || l.phone) && (
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
                    {l.address && <span className="t-sm" style={{ color: 'var(--muted)' }}>{l.address}</span>}
                    {l.phone && <span className="t-sm" style={{ color: 'var(--muted)' }}>{l.phone}</span>}
                  </div>
                )}
              </div>
            ))}
            {!locations.length && (
              <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessuna sede configurata', 'No locations configured')}</div>
            )}
          </div>
        </div>

        {/* account card */}
        <div>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Account', 'Account')}</div>
          <div className="dk-card" style={{ padding: 6, boxShadow: 'none', border: '1px solid var(--hair)' }}>
            {[
              [t('Nome', 'Name'), name],
              [t('Email', 'Email'), session?.user?.email || '—'],
              [t('Salone', 'Salon'), salon?.name || '—'],
              [t('Ruolo', 'Role'), isOwner ? t('Titolare', 'Owner') : (session?.scopes || []).join(', ') || t('Staff', 'Staff')],
            ].map(([l, v], i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 12px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                <span className="t-sm" style={{ color: 'var(--muted)', width: 90, flexShrink: 0 }}>{l}</span>
                <span style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, padding: '11px 14px', background: 'var(--surface-2)', borderRadius: 12 }}>
            <Icon name="sparkle" size={15} color="var(--clay-ink)" />
            <span className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.45 }}>
              {t('Tutti i dati del tuo salone — fatturato, staff e magazzino — in un unico posto.', 'All your salon data — revenue, staff and inventory — in one place.')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
