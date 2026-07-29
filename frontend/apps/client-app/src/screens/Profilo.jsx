// Profilo.jsx — identity + contacts (GET/PUT /api/auth/client/me), language
// toggle, WhatsApp reminders toggle, waitlist summary, loyalty snapshot, logout.
import React from 'react';
import { Icon, Toggle, api, clientAuth } from '@youty/shared';
import { useApp } from '../ctx.jsx';
import { headFont } from '../theme.js';
import { ClientSubHead, errToast } from './lib.jsx';

export default function Profilo() {
  const { t, lang, setLang, brand, client, setView, fireToast } = useApp();
  const [me, setMe] = React.useState(null);
  const [wlCount, setWlCount] = React.useState(null);
  const [points, setPoints] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    api.get('/api/auth/client/me')
      .then((d) => { if (alive) setMe(d); })
      .catch((e) => { if (alive) errToast(e, fireToast, t); });
    api.get('/api/agenda/client/waitlist')
      .then((l) => { if (alive) setWlCount((l || []).filter((w) => w.status === 'active').length); })
      .catch(() => { if (alive) setWlCount(0); });
    api.get('/api/marketing/client/wallet')
      .then((w) => { if (alive) setPoints((w?.loyalty || []).reduce((s, p) => s + Number(p.points || 0), 0)); })
      .catch(() => { if (alive) setPoints(0); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMe = async (patch, localToo) => {
    if (saving) return;
    setSaving(true);
    const prev = me;
    setMe((m) => (m ? { ...m, ...patch } : m)); // optimistic
    try {
      const updated = await api.put('/api/auth/client/me', patch);
      setMe(updated);
      if (localToo) localToo(updated);
    } catch (err) {
      setMe(prev);
      errToast(err, fireToast, t);
    } finally {
      setSaving(false);
    }
  };

  const firstName = me?.first_name || client?.first_name || '';
  const lastName = me?.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const initials = ((firstName[0] || '') + (lastName[0] || '')).toUpperCase() || (firstName.slice(0, 2) || '·').toUpperCase();
  const waOn = !!me?.whatsapp_reminders;
  const hasCard = !!me?.has_saved_card;
  const cardConsent = !!me?.card_charge_consent;

  /* Salvataggio carta: pagina ospitata da Stripe, in modalità "solo salvataggio"
     (nessun addebito). Sostituiamo la pagina invece di aprire una scheda: da
     telefono il ritorno con `?card=ok` riporta la cliente qui. */
  const [savingCard, setSavingCard] = React.useState(false);
  const saveCard = async () => {
    if (savingCard) return;
    setSavingCard(true);
    try {
      const res = await api.post('/api/sales/client/save-card-checkout');
      if (res.checkout_url) window.location.assign(res.checkout_url);
      else throw new Error('missing checkout url');
    } catch (err) {
      setSavingCard(false);
      // 412/503 = il salone non ha i pagamenti attivi: non è colpa della cliente.
      if (err?.status === 412 || err?.status === 503) {
        fireToast({
          msg: t('Pagamenti non disponibili: contatta il salone',
                 'Payments unavailable: please contact the salon'),
          icon: 'info',
        });
      } else {
        errToast(err, fireToast, t);
      }
    }
  };

  return (
    <div style={{ paddingBottom: 30 }}>
      <ClientSubHead brand={brand} title={t('Profilo', 'Profile')} onBack={() => setView('home')} />
      <div style={{ padding: '4px 22px' }} className="stagger">

        {/* identity card */}
        <div className="card" style={{ padding: 20, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 15 }}>
          <div style={{ width: 60, height: 60, borderRadius: 99, background: 'var(--brand)', color: 'var(--brand-on)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 22, flexShrink: 0 }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {fullName
              ? <div style={{ fontFamily: headFont(brand), fontSize: 22, fontWeight: brand.type === 'serif' ? 500 : 800, lineHeight: 1.1 }}>{fullName}</div>
              : <div className="skel" style={{ height: 24, width: 140 }} />}
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Cliente di', 'Client of')} {brand.name}</div>
          </div>
        </div>

        {/* contact details + loyalty snapshot */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('I tuoi dati', 'Your details')}</div>
        <div className="card" style={{ padding: 4, marginBottom: 20, boxShadow: 'none', border: '1px solid var(--hair)' }}>
          {[
            ['phone', t('Telefono', 'Phone'), me ? (me.phone || '—') : null],
            ['mail', 'Email', me ? (me.email || '—') : null],
            ['star', t('Punti fedeltà', 'Loyalty points'), points === null ? null : Math.round(points) + ' pt'],
          ].map(([ic, l, v], i) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
              <Icon name={ic} size={18} color="var(--brand)" />
              <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{l}</span>
              {v === null
                ? <span className="skel" style={{ height: 16, width: 90, display: 'inline-block' }} />
                : <span style={{ fontWeight: 700, fontSize: 14 }}>{v}</span>}
            </div>
          ))}
        </div>

        {/* gestione — waitlist */}
        <div className="t-meta" style={{ marginBottom: 10 }}>{t('Gestione', 'Manage')}</div>
        <button className="press" onClick={() => setView('waitlist')}
          style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14, padding: 16, borderRadius: 'var(--r-md)', background: 'var(--brand)', color: 'var(--brand-on)', marginBottom: 10, boxShadow: 'var(--sh-card)' }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: 'rgba(255,255,255,0.18)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Icon name="clock" size={22} color="var(--brand-on)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{t('Lista d’attesa', 'Waiting list')}</div>
            <div style={{ fontSize: 13, opacity: 0.85, marginTop: 2 }}>
              {wlCount > 0
                ? wlCount + ' ' + t('richieste attive · ti avvisiamo su WhatsApp', 'active requests · we’ll ping you on WhatsApp')
                : t('Nessuno slot libero? Mettiti in lista', 'No free slot? Join the list')}
            </div>
          </div>
          <Icon name="chevR" size={20} color="var(--brand-on)" />
        </button>

        {/* preferences */}
        <div className="t-meta" style={{ margin: '18px 0 10px' }}>{t('Preferenze', 'Preferences')}</div>
        <div className="card" style={{ padding: 4, marginBottom: 20, boxShadow: 'none', border: '1px solid var(--hair)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px' }}>
            <Icon name="globe" size={18} color="var(--brand)" />
            <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Lingua', 'Language')}</span>
            <div style={{ display: 'flex', gap: 4, background: 'var(--paper-2)', borderRadius: 99, padding: 3 }}>
              {['it', 'en'].map((l) => (
                <button key={l} className="press"
                  onClick={() => { if (l !== lang) { setLang(l); saveMe({ lang: l }); } }}
                  style={{ padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 700, background: lang === l ? 'var(--brand)' : 'transparent', color: lang === l ? 'var(--brand-on)' : 'var(--muted)' }}>
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px', borderTop: '1px solid var(--hair)' }}>
            <Icon name="whatsapp" size={18} color="#3F9D58" />
            <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Promemoria WhatsApp', 'WhatsApp reminders')}</span>
            {me
              ? <Toggle on={waOn} onChange={(v) => saveMe({ whatsapp_reminders: v }, () => fireToast({ msg: v ? t('Promemoria WhatsApp attivi', 'WhatsApp reminders on') : t('Promemoria WhatsApp disattivati', 'WhatsApp reminders off'), icon: 'check' }))} />
              : <span className="skel" style={{ height: 28, width: 46, borderRadius: 99, display: 'inline-block' }} />}
          </div>
        </div>

        {/* ---- Metodo di pagamento ------------------------------------------
            La carta serve alle caparre e, se il salone lo prevede, all'addebito
            in caso di mancata presentazione. Si salva sulla pagina di Stripe:
            qui dentro non passa mai un numero di carta.
            Il consenso è separato e revocabile: senza consenso nessun addebito
            è possibile, anche con la carta salvata. */}
        <div className="t-meta" style={{ margin: '18px 0 10px' }}>{t('Pagamenti', 'Payments')}</div>
        <div className="card" style={{ padding: 4, marginBottom: 20, boxShadow: 'none', border: '1px solid var(--hair)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px' }}>
            <Icon name="wallet" size={18} color="var(--brand)" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t-sm" style={{ color: 'var(--muted)' }}>
                {t('Metodo di pagamento', 'Payment method')}
              </div>
              {me && (
                <div style={{ fontSize: 11.5, color: hasCard ? '#3F9D58' : 'var(--muted-2)', fontWeight: 600, marginTop: 2 }}>
                  {hasCard ? t('Carta salvata', 'Card saved') : t('Nessuna carta', 'No card')}
                </div>
              )}
            </div>
            {me
              ? (
                <button className="press" onClick={saveCard} disabled={savingCard}
                  style={{ padding: '8px 14px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand-ink)', opacity: savingCard ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                  {savingCard
                    ? t('Apertura…', 'Opening…')
                    : hasCard ? t('Sostituisci', 'Replace') : t('Salva carta', 'Save card')}
                </button>
              )
              : <span className="skel" style={{ height: 30, width: 88, borderRadius: 99, display: 'inline-block' }} />}
          </div>

          {hasCard && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px', borderTop: '1px solid var(--hair)' }}>
              <Icon name="shield" size={18} color="var(--muted)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="t-sm" style={{ color: 'var(--muted)' }}>
                  {t('Autorizzo l’addebito', 'Allow charges')}
                </span>
                <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 2, lineHeight: 1.35 }}>
                  {t('Per caparre e mancata presentazione, secondo le regole del salone. Puoi revocarlo quando vuoi.',
                     'For deposits and no-shows, per the salon’s policy. You can revoke it any time.')}
                </div>
              </div>
              <Toggle on={cardConsent}
                onChange={(v) => saveMe({ card_charge_consent: v }, () => fireToast({
                  msg: v ? t('Addebito autorizzato', 'Charges allowed')
                         : t('Autorizzazione revocata', 'Authorisation revoked'),
                  icon: 'check',
                }))} />
            </div>
          )}
        </div>

        <button className="press"
          onClick={() => { clientAuth.logout(); }}
          style={{ width: '100%', textAlign: 'center', padding: 13, borderRadius: 'var(--r-pill)', color: 'var(--muted)', fontWeight: 600, fontSize: 14 }}>
          {t('Esci', 'Log out')}
        </button>
      </div>
    </div>
  );
}
