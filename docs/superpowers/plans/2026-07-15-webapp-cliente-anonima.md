# Webapp cliente anonima — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere la webapp cliente accessibile senza login (Home del centro + prenotazione), raccogliendo identità (nome/cognome/telefono) e creando/accedendo all'account via OTP all'ultimo step della prenotazione.

**Architecture:** L'app cliente non ha più il gate di login all'ingresso; `session` è opzionale. Da anonimo si naviga Home+Prenota con "Accedi" in alto a destra. La prenotazione anonima aggiunge uno step "I tuoi dati" → OTP che riusa gli endpoint esistenti (`request-otp`/`register`/`verify-otp`) e poi crea l'appuntamento (approccio A). Unico pezzo backend nuovo: un endpoint di disponibilità pubblico.

**Tech Stack:** Backend Django 5 + django-ninja (Python 3.12, venv in `backend/.venv`). Frontend React 18 + Vite (JS/JSX puro, nessun TypeScript, nessun test-runner JS → verifica frontend via build + Playwright sul Chrome di sistema). Pacchetto condiviso `@youty/shared`.

## Global Constraints

- Plain JavaScript/JSX only — no TypeScript.
- Riuso endpoint esistenti (approccio A): nessun endpoint atomico nuovo di booking.
- L'identità di prenotazione raccoglie **nome, cognome, telefono** — **niente email**.
- Caparra invariata: `compute_deposit` è già condizionale (nessuna `DepositRule` → deposito 0). Nessuna modifica alla logica caparra.
- Backend: eseguire test con `backend/.venv/bin/python manage.py test`.
- Dev locale: backend su **8080**, frontend con `VITE_API_URL=http://localhost:8080` (porta 8000 occupata da Docker). Dashboard 5173, client 5174.
- Login demo: `sole@theparlour.it` / `theparlour`. Cliente demo per OTP: numeri nel seed; il codice OTP appare nel **log del backend**.

---

### Task 1: Endpoint pubblico di disponibilità (backend)

**Files:**
- Modify: `backend/apps/agenda/api.py` (import `Salon`; nuovo endpoint dopo `client_availability`, ~riga 586)
- Test: `backend/apps/agenda/tests.py`

**Interfaces:**
- Produces: `GET /api/agenda/public/availability?salon=<slug>&date=<YYYY-MM-DD>&items=<json>` → `list[SlotOut]`, senza auth. `items` è lo stesso formato di `client/availability` (JSON array di `{service_id, operator_id?}`), parsato da `_parse_items_param`.

- [ ] **Step 1: Scrivere il test che fallisce**

In `backend/apps/agenda/tests.py`, aggiungere (in una TestCase con un salone `the-parlour` e almeno un servizio attivo — riusare il setup esistente se presente, altrimenti crearne uno con `seed`-like fixtures):

```python
import json

def test_public_availability_no_auth(self):
    # nessun header di auth
    items = json.dumps([{"service_id": self.service.id}])
    resp = self.client.get(
        f"/api/agenda/public/availability?salon={self.salon.slug}"
        f"&date={self.date_str}&items={items}"
    )
    self.assertEqual(resp.status_code, 200, resp.content)
    self.assertIsInstance(resp.json(), list)

def test_public_availability_unknown_salon_404(self):
    items = json.dumps([{"service_id": self.service.id}])
    resp = self.client.get(
        f"/api/agenda/public/availability?salon=inesistente"
        f"&date={self.date_str}&items={items}"
    )
    self.assertEqual(resp.status_code, 404, resp.content)
```

Se il file non ha un setup con salone+servizio+data, aggiungere un `setUp` minimale che crei `Salon(slug="the-parlour")`, un `ServiceCategory`, un `Service(active=True)` con `duration_min`, e imposti `self.date_str` a una data feriale futura; verificare come gli altri test dell'app costruiscono questi oggetti e replicare.

- [ ] **Step 2: Eseguire il test → deve fallire**

Run: `backend/.venv/bin/python manage.py test apps.agenda -v1`
Expected: FAIL (404 su un endpoint inesistente → risposta ninja "Not Found" o 404 su tutte, comunque il test `no_auth` fallisce perché la rotta non esiste).

- [ ] **Step 3: Implementare l'endpoint**

In `backend/apps/agenda/api.py`, modificare l'import da core:

```python
from apps.core.models import Location, Salon
```

Aggiungere dopo `client_availability` (dopo la riga 586):

```python
@router.get("/public/availability", response=list[SlotOut])
def public_availability(request, salon: str, date: str, items: str):
    """Disponibilità pubblica (no auth): solo orari liberi, salone per slug."""
    try:
        s = Salon.objects.get(slug=salon)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")
    return services.get_free_slots(s, _parse_day(date), _parse_items_param(items))
```

(Nota: gli endpoint `/public/...` di `catalog` e `core` non specificano `auth=`, quindi sono pubblici — l'API non ha auth globale. Stesso pattern qui.)

- [ ] **Step 4: Eseguire i test → devono passare**

Run: `backend/.venv/bin/python manage.py test apps.agenda -v1`
Expected: PASS (tutti, inclusi i due nuovi).

- [ ] **Step 5: Verifica manuale rapida**

Con backend su 8080:
Run: `curl -s "http://localhost:8080/api/agenda/public/availability?salon=the-parlour&date=$(date -v+1d +%F)&items=%5B%7B%22service_id%22%3A1%7D%5D" -o /dev/null -w "%{http_code}\n"`
Expected: `200`

- [ ] **Step 6: Commit**

```bash
git add backend/apps/agenda/api.py backend/apps/agenda/tests.py
git commit -m "feat(agenda): endpoint pubblico di disponibilità (no auth)"
```

---

### Task 2: `ctx.jsx` — sessione opzionale + overlay di login a richiesta

**Files:**
- Modify: `frontend/apps/client-app/src/ctx.jsx`

**Interfaces:**
- Produces (nel valore di `useApp()`): in aggiunta agli attuali, `authOpen: bool`, `openAuth(onDone?)`, `closeAuth()`. `openAuth` apre l'overlay di login; alla comparsa di `session` esegue `onDone` (se passato) e chiude.

- [ ] **Step 1: Aggiungere stato e azioni auth**

In `frontend/apps/client-app/src/ctx.jsx`, importare `useRef`:

```js
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
```

Dopo il blocco `/* ---- session ---- */` (dopo la riga con `const client = ...`), aggiungere:

```js
  /* ---- login overlay a richiesta (l'app non ha più un gate d'ingresso) ---- */
  const [authOpen, setAuthOpen] = useState(false);
  const authResume = useRef(null);
  const openAuth = useCallback((onDone) => { authResume.current = onDone || null; setAuthOpen(true); }, []);
  const closeAuth = useCallback(() => { authResume.current = null; setAuthOpen(false); }, []);
  // quando la sessione compare mentre l'overlay è aperto → riprendi e chiudi
  useEffect(() => {
    if (session && authOpen) {
      const cb = authResume.current;
      authResume.current = null;
      setAuthOpen(false);
      if (cb) cb();
    }
  }, [session, authOpen]);
```

Aggiungere al literal `ctx` i nuovi campi:

```js
    authOpen, openAuth, closeAuth,
```

- [ ] **Step 2: Verifica build**

Run: `cd frontend && npm run build --workspace apps/client-app`
Expected: build OK (nessun errore).

- [ ] **Step 3: Commit**

```bash
git add frontend/apps/client-app/src/ctx.jsx
git commit -m "feat(client): sessione opzionale + overlay login a richiesta nel context"
```

---

### Task 3: `App.jsx` — niente gate; AuthFlow come overlay; guardia viste personali

**Files:**
- Modify: `frontend/apps/client-app/src/App.jsx`

**Interfaces:**
- Consumes: `authOpen`, `openAuth`, `closeAuth` da `useApp()` (Task 2); `AuthFlow` (esistente).
- Produces: app renderizzata anche con `session === null`; `AuthFlow` mostrato in overlay quando `authOpen`; viste personali reindirizzate al login se anonimo.

- [ ] **Step 1: Sostituire il gate con render sempre attivo**

In `frontend/apps/client-app/src/App.jsx`, dentro `Root`:
- Recuperare da `useApp()` anche `authOpen`, `openAuth`, `closeAuth`, `setView`.
- **Rimuovere** il blocco `if (!session) { … return <AuthFlow/> … }` (righe ~47-57).
- Aggiungere l'insieme delle viste personali e una guardia:

```js
  const PERSONAL_VIEWS = ['prenotazioni', 'wallet', 'profilo', 'waitlist', 'sposta', 'annulla', 'giftcard'];
  const gated = !session && PERSONAL_VIEWS.includes(view);
  useEffect(() => { if (gated) { openAuth(); setView('home'); } }, [gated]); // eslint-disable-line react-hooks/exhaustive-deps
```

- Nel return principale, calcolare la vista effettiva e mostrare l'overlay di login:

```js
  const Screen = SCREENS[view] || SCREENS.home;
  const showNav = NAV_VIEWS.includes(view);

  return (
    <div className="app-viewport">
      <div className="app-frame" style={{ ...vars, fontFamily: 'var(--sans)' }}>
        <div className="scroll" style={{ flex: 1, minHeight: 0, background: 'var(--paper-0)' }}>
          <div style={{ minHeight: '100%', paddingBottom: showNav ? 'calc(var(--safe-bottom) + 78px)' : 0 }}>
            <Screen />
          </div>
        </div>
        {showNav && <Utility />}
        {showNav && <NavBar />}
        {authOpen && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 200, background: 'var(--paper-0)' }}>
            <AuthFlow onClose={closeAuth} />
          </div>
        )}
        <Toast {...toastProps} />
      </div>
    </div>
  );
```

- [ ] **Step 2: Aggiungere il pulsante di chiusura all'AuthFlow (overlay)**

In `frontend/apps/client-app/src/screens/auth/AuthFlow.jsx`:
- Firma: `export default function AuthFlow({ onClose })`.
- Aggiungere, accanto al toggle lingua (dentro il primo `div` con `position: absolute … right: 14`), un pulsante di chiusura visibile solo se `onClose` è passato:

```jsx
        {onClose && (
          <button className="press" onClick={onClose} aria-label="Chiudi"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 99, background: 'rgba(255,255,255,0.92)', border: 'none', cursor: 'pointer', marginRight: 8, boxShadow: 'var(--sh-sm)' }}>
            <Icon name="x" size={16} />
          </button>
        )}
```

(Metterlo nello stesso contenitore in alto a destra, prima del toggle lingua; avvolgere i due in un `div` con `display:flex; gap:8` se necessario.)

- [ ] **Step 3: Verifica build**

Run: `cd frontend && npm run build --workspace apps/client-app`
Expected: build OK.

- [ ] **Step 4: Verifica browser (ingresso anonimo)**

Con i dev server attivi, script Playwright (Chrome di sistema) su `http://localhost:5174`:
- Aspettato: la pagina mostra la **Home del centro** (nome brand, CTA prenota) **senza** form telefono/OTP di ingresso.
- Osservazione da loggare: presenza del testo del brand e assenza dell'input `type=tel` iniziale.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/client-app/src/App.jsx frontend/apps/client-app/src/screens/auth/AuthFlow.jsx
git commit -m "feat(client): rimosso il gate di login; AuthFlow come overlay a richiesta"
```

---

### Task 4: `NavBar.jsx` — barra snella da anonimo

**Files:**
- Modify: `frontend/apps/client-app/src/NavBar.jsx`

**Interfaces:**
- Consumes: `session` da `useApp()`.
- Produces: se `!session`, barra con solo **Home** + **FAB Prenota**; se `session`, barra completa attuale.

- [ ] **Step 1: Rendere la lista item dipendente dalla sessione**

In `frontend/apps/client-app/src/NavBar.jsx`, dentro il componente:

```jsx
  const { t, view, setView, session } = useApp();
  const full = [
    { key: 'home', icon: 'home', label: t('Home', 'Home') },
    { key: 'prenotazioni', icon: 'calendar', label: t('Prenotazioni', 'Bookings') },
    { key: 'prenota', icon: 'plus', label: t('Prenota', 'Book'), center: true },
    { key: 'wallet', icon: 'wallet', label: t('Portafoglio', 'Wallet') },
    { key: 'profilo', icon: 'user', label: t('Profilo', 'Profile') },
  ];
  const slim = [
    { key: 'home', icon: 'home', label: t('Home', 'Home') },
    { key: 'prenota', icon: 'plus', label: t('Prenota', 'Book'), center: true },
  ];
  const items = session ? full : slim;
```

(Il resto del render invariato: usa `items`.)

- [ ] **Step 2: Verifica build**

Run: `cd frontend && npm run build --workspace apps/client-app`
Expected: build OK.

- [ ] **Step 3: Commit**

```bash
git add frontend/apps/client-app/src/NavBar.jsx
git commit -m "feat(client): navbar snella (Home + Prenota) per utente anonimo"
```

---

### Task 5: `Home.jsx` — variante anonima + accesso in alto a destra

**Files:**
- Modify: `frontend/apps/client-app/src/screens/Home.jsx`

**Interfaces:**
- Consumes: `session`, `openAuth`, `setView` da `useApp()`.
- Produces: Home che, se `!session`, mostra intro centro + CTA Prenota + "Accedi" in alto a destra; se `session`, comportamento attuale. Nessuna chiamata autenticata quando anonimo.

- [ ] **Step 1: Evitare la fetch autenticata da anonimo**

In `frontend/apps/client-app/src/screens/Home.jsx`:
- Recuperare `session`, `openAuth` da `useApp()`.
- Chiamare `useClientAppointments` **solo** se loggati. Poiché è un hook, non condizionarne la chiamata; invece renderla no-op da anonimo. Approccio: avvolgere la Home in due return.

Struttura:

```jsx
export default function Home() {
  const { t, lang, brand, client, session, openAuth, setView, fireToast } = useApp();

  /* ---- HOME ANONIMA ---- */
  if (!session) {
    return (
      <div style={{ paddingBottom: 40, position: 'relative' }}>
        {/* accesso in alto a destra */}
        <div style={{ position: 'absolute', top: 'calc(var(--safe-top) + 8px)', right: 16, zIndex: 30 }}>
          <button className="press" onClick={() => openAuth()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 99, background: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: 700, color: 'var(--brand-ink)', border: 'none', cursor: 'pointer', boxShadow: 'var(--sh-sm)' }}>
            <Icon name="user" size={15} color="var(--brand-ink)" />{t('Accedi', 'Sign in')}
          </button>
        </div>
        <Cover brand={brand} t={t} />
        <div style={{ padding: '20px 22px 0' }} className="stagger">
          <div style={{ fontFamily: headFont(brand), fontSize: 24, fontWeight: brand.type === 'serif' ? 500 : 800, lineHeight: 1.15, marginBottom: 8 }}>
            {t('Prenota il tuo appuntamento', 'Book your appointment')}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 18, maxWidth: 300 }}>
            {t(`Scegli il servizio e l'orario da ${brand.name}. Ti bastano un minuto e il tuo numero.`,
               `Pick a service and time at ${brand.name}. It only takes a minute and your phone number.`)}
          </div>
          <button className="btn btn--brand btn--block press" style={{ marginBottom: 18, height: 54 }} onClick={() => setView('prenota')}>
            <Icon name="plus" size={18} color="var(--brand-on)" />{t('Prenota ora', 'Book now')}
          </button>
          <SalonFooter brand={brand} t={t} />
        </div>
      </div>
    );
  }

  /* ---- HOME LOGGATA (comportamento attuale) ---- */
  return <HomeLogged />;
}
```

- Estrarre il corpo attuale di `Home` (da `const { data, error } = useClientAppointments();` fino alla fine del return attuale) in un componente interno `function HomeLogged() { … }` nello stesso file, che usa `useApp()` per i suoi dati. In `HomeLogged`, aggiungere anche l'accesso al profilo in alto a destra (avatar/nome → `setView('profilo')`) se non già presente altrove.

- [ ] **Step 2: Verifica build**

Run: `cd frontend && npm run build --workspace apps/client-app`
Expected: build OK.

- [ ] **Step 3: Verifica browser (Home anonima + Accedi)**

Playwright su `http://localhost:5174`:
- Aspettato: Home anonima con CTA "Prenota ora" e pulsante "Accedi" in alto a destra.
- Cliccando "Accedi": compare l'overlay `AuthFlow` (input `type=tel`).
- Chiudendo l'overlay (X): torna alla Home anonima.
- Loggare le osservazioni + screenshot.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/client-app/src/screens/Home.jsx
git commit -m "feat(client): Home anonima del centro con accesso in alto a destra"
```

---

### Task 6: `Prenota.jsx` — disponibilità pubblica + step "I tuoi dati" + OTP (approccio A)

**Files:**
- Modify: `frontend/apps/client-app/src/screens/Prenota.jsx`

**Interfaces:**
- Consumes: `session`, `openAuth` da `useApp()`; `clientAuth` da `@youty/shared`; `SALON_SLUG`; endpoint `GET /api/agenda/public/availability` (Task 1); endpoint esistenti `client/register`, `client/request-otp`, `client/verify-otp`, `POST /api/agenda/client/appointments`.
- Produces: flusso di prenotazione utilizzabile da anonimo; alla conferma anonima, orchestra OTP+account e poi crea l'appuntamento.

- [ ] **Step 1: Usare la disponibilità pubblica**

In `frontend/apps/client-app/src/screens/Prenota.jsx`, in `loadSlots`, sostituire l'URL autenticato con quello pubblico (funziona in entrambi i casi):

```js
      const list = await api.get('/api/agenda/public/availability', {
        params: { salon: SALON_SLUG, date: toDateStr(days[dIdx]), items },
        auth: false,
      });
```

- [ ] **Step 2: Aggiungere stato identità/OTP**

In cima al componente, con gli altri `useState`:

```js
  const { t, lang, brand, session, openAuth, setView, fireToast } = useApp();
  ...
  const [ident, setIdent] = React.useState({ first_name: '', last_name: '', phone: '' });
  const [otp, setOtp] = React.useState('');
  const [otpErr, setOtpErr] = React.useState(null);
```

- [ ] **Step 3: Ramo conferma per anonimo vs loggato**

Modificare la logica del pulsante conferma nello **step 2 (riepilogo)**: se loggato → `confirm()`; se anonimo → vai allo step identità (`setStep(3)`).

Nel render dello step 2, il bottone `StickyCta`:

```jsx
        <button className="btn btn--brand btn--block press" disabled={booking} style={{ opacity: booking ? 0.6 : 1 }}
          onClick={() => (session ? confirm() : setStep(3))}>
          <Icon name="check" size={18} color="var(--brand-on)" />
          {booking ? t('Prenotazione…', 'Booking…') : t('Conferma prenotazione', 'Confirm booking')}
        </button>
```

- [ ] **Step 4: Orchestrazione OTP + account + prenotazione**

Aggiungere le funzioni (dopo `confirm`):

```js
  /* invio OTP: numero noto → request-otp; sconosciuto (404) → register con nome/cognome */
  const sendBookingOtp = async () => {
    setOtpErr(null);
    const phone = ident.phone.trim();
    if (!ident.first_name.trim() || !ident.last_name.trim() || !phone) return;
    setBooking(true);
    try {
      try {
        await clientAuth.requestOtp(SALON_SLUG, phone);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          await clientAuth.register({
            salon_slug: SALON_SLUG,
            first_name: ident.first_name.trim(),
            last_name: ident.last_name.trim(),
            phone,
            lang,
          });
        } else { throw err; }
      }
      setStep(4);
    } catch (err) {
      errToast(err, fireToast, t);
    } finally { setBooking(false); }
  };

  /* verifica OTP → sessione → crea appuntamento */
  const verifyAndBook = async () => {
    setOtpErr(null);
    if (otp.length !== 6 || booking) return;
    setBooking(true);
    try {
      await clientAuth.verifyOtp(SALON_SLUG, ident.phone.trim(), otp);
      const appt = await api.post('/api/agenda/client/appointments', { items, start: slot.start });
      setBooked(appt);
      setStep(9);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setOtpErr(t('Codice non valido o scaduto', 'Invalid or expired code'));
      } else if (err instanceof ApiError && err.status === 409) {
        fireToast({ msg: t('Questo orario è appena stato preso: scegline un altro.', 'That time was just taken: pick another.'), icon: 'alert' });
        setStep(1); loadSlots(dayIdx);
      } else {
        errToast(err, fireToast, t);
      }
    } finally { setBooking(false); }
  };
```

Assicurarsi che `clientAuth` sia importato:

```js
import { ApiError, Icon, api, clientAuth, fmtEur, fmtDur, minutesOfDay, timeLabel } from '@youty/shared';
```

- [ ] **Step 5: Render step 3 (I tuoi dati) e step 4 (OTP)**

Aggiungere prima del return dello step 2 (o come rami `if (step === 3)` / `if (step === 4)`), riusando `ClientSubHead`/`StickyCta`:

```jsx
  /* ============ STEP 3: I tuoi dati (solo anonimo) ============ */
  if (step === 3) {
    const okData = ident.first_name.trim() && ident.last_name.trim() && ident.phone.trim();
    return (
      <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        {head(t('I tuoi dati', 'Your details'))}
        <div style={{ padding: '4px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>
            {t('Ti inviamo un codice via WhatsApp per confermare la prenotazione.', 'We send a WhatsApp code to confirm your booking.')}
          </div>
          <input className="ca-input" placeholder={t('Nome', 'First name')} autoComplete="given-name"
            value={ident.first_name} onChange={(e) => setIdent((v) => ({ ...v, first_name: e.target.value }))} />
          <input className="ca-input" placeholder={t('Cognome', 'Last name')} autoComplete="family-name"
            value={ident.last_name} onChange={(e) => setIdent((v) => ({ ...v, last_name: e.target.value }))} />
          <input className="ca-input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+39 333 000 0000"
            value={ident.phone} onChange={(e) => setIdent((v) => ({ ...v, phone: e.target.value }))} />
        </div>
        <div style={{ flex: 1 }} />
        <StickyCta>
          <button className="btn btn--brand btn--block press" disabled={!okData || booking} style={{ opacity: okData && !booking ? 1 : 0.5 }} onClick={sendBookingOtp}>
            {booking ? t('Invio…', 'Sending…') : t('Invia codice', 'Send code')}
          </button>
        </StickyCta>
      </div>
    );
  }

  /* ============ STEP 4: OTP (solo anonimo) ============ */
  if (step === 4) {
    return (
      <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        {head(t('Conferma il numero', 'Confirm your number'))}
        <div style={{ padding: '4px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>
            {t('Inserisci il codice a 6 cifre inviato al ', 'Enter the 6-digit code sent to ')}<b>{ident.phone}</b>.
          </div>
          {otpErr && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{otpErr}</div>}
          <input className="ca-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="······"
            value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => { if (e.key === 'Enter' && otp.length === 6) verifyAndBook(); }} />
          <button className="press" style={{ alignSelf: 'flex-start', fontSize: 13, fontWeight: 700, color: 'var(--brand-ink)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={sendBookingOtp} disabled={booking}>{t('Reinvia codice', 'Resend code')}</button>
        </div>
        <div style={{ flex: 1 }} />
        <StickyCta>
          <button className="btn btn--brand btn--block press" disabled={otp.length !== 6 || booking} style={{ opacity: otp.length === 6 && !booking ? 1 : 0.5 }} onClick={verifyAndBook}>
            <Icon name="check" size={18} color="var(--brand-on)" />
            {booking ? t('Conferma…', 'Confirming…') : t('Conferma prenotazione', 'Confirm booking')}
          </button>
        </StickyCta>
      </div>
    );
  }
```

Nota: `head(...)` usa `setStep(step - 1)` per il back — da step 3 torna al riepilogo (2), da 4 torna a 3. Va bene.

- [ ] **Step 6: Verifica build**

Run: `cd frontend && npm run build --workspace apps/client-app`
Expected: build OK.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/client-app/src/screens/Prenota.jsx
git commit -m "feat(client): prenotazione anonima con step dati + OTP che crea/accede l'account"
```

---

### Task 7: Verifica end-to-end in browser (i 4 scenari)

**Files:**
- Nessuna modifica di prodotto. Script Playwright temporaneo nello scratchpad.

**Interfaces:**
- Consumes: dev server attivi (backend 8080, client 5174), OTP dal log backend.

- [ ] **Step 1: Preparare un numero "nuovo" e uno "esistente"**

Recuperare dal seed un numero cliente esistente (es. via admin o API) e scegliere un numero non presente per lo scenario "nuovo".

- [ ] **Step 2: Scenario ingresso anonimo**

Playwright: apri `http://localhost:5174` → verifica Home del centro senza gate; "Accedi" presente.

- [ ] **Step 3: Scenario prenotazione numero NUOVO**

Guida: Prenota → servizio → orario (pubblico) → riepilogo → "Conferma" → step "I tuoi dati" (nome/cognome/telefono nuovo) → "Invia codice" → leggi OTP dal log backend (`tasks/<id>.output` o log runserver) → inserisci → "Conferma prenotazione".
Aspettato: schermata di successo; dopo "Torna alla home" compaiono le tab personali (sessione creata). Screenshot.

- [ ] **Step 4: Scenario prenotazione numero ESISTENTE**

Ripeti con un numero già registrato: dopo l'OTP la prenotazione è sul suo account; nome/cognome digitati non creano un doppione (verifica in dashboard che il cliente sia quello esistente). Screenshot.

- [ ] **Step 5: Scenario accesso dal top-right**

Da anonimo → "Accedi" → numero esistente → OTP → profilo/prenotazioni visibili. Screenshot.

- [ ] **Step 6: Riepilogo verifica**

Loggare l'esito dei 4 scenari. Nessun commit (solo verifica).

---

## Self-review (esito)

- **Copertura spec:** ingresso anonimo (T3), nav anonima (T4), Home anonima + accesso top-right (T5), prenotazione pubblica + identità/OTP + account (T6), disponibilità pubblica backend (T1), sessione opzionale/overlay (T2), verifica 4 scenari (T7). Caparra: nessun task perché già condizionale (da spec). Toggle dashboard: fuori scope (da spec).
- **Placeholder:** nessuno; ogni step ha codice/comando reali.
- **Coerenza tipi/nomi:** `openAuth/closeAuth/authOpen` (T2) usati in T3/T5; `sendBookingOtp`/`verifyAndBook` locali a T6; endpoint `public/availability` (T1) consumato in T6; `clientAuth.requestOtp/register/verifyOtp` (firme da `packages/shared/src/clientAuth.js`).
