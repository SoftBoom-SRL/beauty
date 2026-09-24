// Profilo.jsx — identity + contacts (GET/PUT /api/auth/client/me), language
// toggle, WhatsApp reminders toggle, waitlist summary, loyalty snapshot, logout.
import React from 'react';
import { Icon, Toggle, toastApiError } from '@youty/shared';
import { useApp } from '../ctx.jsx';
import { getMe, getWaitlist, getWallet, setMarketingConsent, updateMe } from '../api/client.js';
import { useApiData } from '../hooks/useApiData.js';
import { headFont, headWeight } from '../theme.js';
import { ClientSubHead } from '../components/ClientSubHead.jsx';

export default function Profilo() {
  const { t, lang, setLang, brand, client, setView, fireToast, logout } = useApp();
  const { data: me, setData: setMe } = useApiData(getMe, [], { onError: (e) => toastApiError(e, fireToast, t) });
  // Richieste attive in lista d'attesa e punti fedeltà sono un di più: se non
  // arrivano si legge 0, senza toast. Il conto si fa appena arriva la risposta.
  const waitlist = useApiData(() => getWaitlist().then((l) => (l || []).filter((w) => w.status === 'active').length), []);
  const loyalty = useApiData(() => getWallet().then((w) => (w?.loyalty || []).reduce((s, p) => s + Number(p.points || 0), 0)), []);
  const wlCount = waitlist.error ? 0 : waitlist.data;
  const points = loyalty.error ? 0 : loyalty.data;
  const [saving, setSaving] = React.useState(false);
  const [consentBusy, setConsentBusy] = React.useState(false);
  // La lingua toccata mentre un altro salvataggio era in corso (vedi chooseLang).
  const [langQueued, setLangQueued] = React.useState(null);

  /* `onFail(prev)`: dopo che la scheda è tornata com'era (`prev`). */
  const saveMe = async (patch, localToo, onFail) => {
    if (saving) return;
    setSaving(true);
    const prev = me;
    setMe((m) => (m ? { ...m, ...patch } : m)); // optimistic
    try {
      const updated = await updateMe(patch);
      setMe(updated);
      if (localToo) localToo(updated);
    } catch (err) {
      setMe(prev);
      if (onFail) onFail(prev);
      toastApiError(err, fireToast, t);
    } finally {
      setSaving(false);
    }
  };

  /* Lingua: cambia subito a schermo e si salva sulla scheda, perché conferme e
   * promemoria WhatsApp partono nella lingua della scheda. Toccata mentre un
   * altro salvataggio era in corso, saveMe usciva senza fare niente: EN e
   * subito dopo IT, e l'app era in italiano con «en» sul server, senza che la
   * cliente potesse accorgersene (voce 34). Ora la scelta aspetta la fine del
   * salvataggio in corso e poi si salva l'ultima. Se il salvataggio della
   * lingua non riesce, a schermo torna quella salvata (la scelta in coda cade
   * con lui: la cliente vede l'errore e riprova). */
  const saveLang = (l) => saveMe({ lang: l }, null, (prev) => {
    setLangQueued(null);
    setLang(prev?.lang || lang);   // scheda non ancora letta: la lingua di prima
  });
  const chooseLang = (l) => {
    if (l === lang) return;
    setLang(l);
    if (saving) setLangQueued(l);
    else saveLang(l);
  };
  React.useEffect(() => {
    if (saving || langQueued === null) return;
    setLangQueued(null);
    // già quella della scheda (EN, IT, EN col primo EN salvato): niente da salvare
    if (langQueued !== me?.lang) saveLang(langQueued);
  }, [saving, langQueued]); // eslint-disable-line react-hooks/exhaustive-deps -- saveLang e me sono quelli di questo render

  /* Consenso alle comunicazioni promozionali (contratto C12). Dato dal form
   * pubblico o in salone, finora non si poteva più togliere dall'app: nessuna
   * schermata lo mostrava e la cliente restava nelle campagne (06-17). Si
   * cambia con l'endpoint del consenso, che tiene traccia di quando. Il
   * backend che non manda ancora `marketing_consent` non mostra la riga: un
   * interruttore che non sa da che parte stare direbbe il falso. */
  const setConsent = async (accepted) => {
    if (consentBusy || !me) return;
    setConsentBusy(true);
    const prev = me.marketing_consent;
    setMe((m) => (m ? { ...m, marketing_consent: accepted } : m)); // optimistic
    try {
      await setMarketingConsent(accepted);
      fireToast({
        msg: accepted
          ? t('Riceverai offerte e novità dal salone', 'You will receive offers and news from the salon')
          : t('Non riceverai più offerte e promozioni', 'You will no longer receive offers and promotions'),
        icon: 'check',
      });
    } catch (err) {
      setMe((m) => (m ? { ...m, marketing_consent: prev } : m));
      toastApiError(err, fireToast, t);
    } finally {
      setConsentBusy(false);
    }
  };

  const firstName = me?.first_name || client?.first_name || '';
  const lastName = me?.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const initials = ((firstName[0] || '') + (lastName[0] || '')).toUpperCase() || (firstName.slice(0, 2) || '·').toUpperCase();
  const waOn = !!me?.whatsapp_reminders;

  return (
    <div style={{ paddingBottom: 30 }}>
      <ClientSubHead brand={brand} title={t('Profilo', 'Profile')} onBack={() => setView('home')} />
      <div style={{ padding: '4px 22px' }} className="stagger">

        {/* identity card */}
        <div className="card" style={{ padding: 20, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 15 }}>
          <div style={{ width: 60, height: 60, borderRadius: 99, background: 'var(--brand)', color: 'var(--brand-on)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 22, flexShrink: 0 }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {fullName
              ? <div style={{ fontFamily: headFont(brand), fontSize: 22, fontWeight: headWeight(brand), lineHeight: 1.1 }}>{fullName}</div>
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
                  onClick={() => chooseLang(l)}
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
          {typeof me?.marketing_consent === 'boolean' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 13px', borderTop: '1px solid var(--hair)' }}>
              <Icon name="gift" size={18} color="var(--brand)" />
              <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Offerte e promozioni', 'Offers and promotions')}</span>
              <Toggle on={me.marketing_consent} onChange={setConsent} />
            </div>
          )}
        </div>

        {/* uscita: prima la home, poi il logout (vedi logout in ctx.jsx, 16-09) */}
        <button className="press"
          onClick={() => logout()}
          style={{ width: '100%', textAlign: 'center', padding: 13, borderRadius: 'var(--r-pill)', color: 'var(--muted)', fontWeight: 600, fontSize: 14 }}>
          {t('Esci', 'Log out')}
        </button>
      </div>
    </div>
  );
}
