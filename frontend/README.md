# Frontend

Monorepo npm con due app React 18 + Vite e un pacchetto condiviso. JavaScript e
JSX, senza TypeScript: la rete che ferma un identificatore sbagliato è ESLint
(`npm run lint`), che il build di Vite non sostituisce.

```
frontend/
  apps/dashboard/      gestionale staff (porta 5173)
  apps/client-app/     web app delle clienti, su /<slug-del-salone> (porta 5174)
  packages/shared/     @youty/shared: client API, sessioni, date, soldi, telefoni, UI di base (ESM senza build)
  test/                caricatore dei test e sostituto di @youty/shared per node --test
```

Il backend è l'API Django su `VITE_API_URL` (in sviluppo `http://localhost:8000`,
CORS aperto; documentazione interattiva su `/api/docs`). Le variabili `VITE_*`
sono scritte nel bundle al build: cambiarle richiede un build nuovo.

## Comandi

```sh
npm ci                   # la prima volta
npm run dev:dashboard    # http://localhost:5173 (anteprima dell'agenda con dati finti: /preview.html)
npm run dev:client       # http://localhost:5174/the-parlour
npm run lint             # ESLint: identificatori non definiti anche nel JSX, import inutilizzati, regole degli hook
npm test                 # node --test
npm run build            # entrambe le app
```

Per avviare tutto insieme (backend compreso) c'è `../start-dev.sh`. Dati demo:
`manage.py seed_demo --reset --password <scelta>` (salone `the-parlour`,
titolare `sole@theparlour.it`); in sviluppo il codice OTP delle clienti è nel
log del backend.

## Dove sta cosa

**Dashboard** (`apps/dashboard/src`)

| Percorso | Cosa |
|---|---|
| `main.jsx`, `App.jsx`, `LoginPage.jsx` | avvio, sessione, accesso |
| `ctx.jsx` | il contesto (`DashboardProvider`, `useDash`, `useLive`): una facciata che mette insieme i pezzi di `app/` |
| `app/` | feed live (`liveFeed.js`), cataloghi di base (`useCatalogs.js`), sede attiva, colori delle operatrici, schermate di avvio |
| `api/<dominio>.js` | una funzione per endpoint (core, staff, catalog, clients, inventory, sales, marketing, automations, insights, team, integrations) |
| `hooks/` | hook generici: `useResource`, `useLatestRequest`, `useDebounced`, `useClickAway`, `useStoredState`, `useOnModalClosed` |
| `ui/` | componenti comuni: `DkModal`, `DkDrawer`, `DkPanel`, `DkConfirm`, `DkToast`, `DkSeg`, `DkDrop`, `SubTabs`, `DrawerHead`, `SearchToolbar`, `PaletteGrid`, `HexInput`, …; `layers.js` è lo stack unico del tasto Esc |
| `shell/` | barra laterale, barra in alto, ritorno a Yourang, ricarica dei chunk |
| `modals/` | `registry.js` (nome → modale) e `DkModals.jsx` (chi li apre) |
| `oauth/` | finestre di collegamento a Yourang e Stripe (`popup.js`) |
| `sections/<sezione>/` | una cartella per sezione; `sections/registry.js` le carica pigramente |
| `styles/` | `desktop.css` è l'elenco ordinato dei fogli della dashboard; la base comune è `@youty/shared/styles/base.css` |

La sezione **agenda** è la più grande e ha una struttura sua:
`agendaApi.js` (tutti i suoi endpoint), `lib.js` (facciata che ri-esporta i
moduli puri di `lib/`: date, griglia, orari, lista d'attesa, trascinamento,
settimana, testi degli avvisi, «409 → riprova forzando», colonne del filtro
«Team» in `team.js`, testo leggibile sui colori in `colors.js`), `constants.js`,
`hooks/` (dati, live, undo, gesti, zoom in altezza e in larghezza, scroll,
trascinamento comune a giorno e settimana), `grid/` e `parts/` (pezzi della griglia e della barra; la barra
sta su una riga con i gradini di `.dk-agbar` in `styles/agenda.css`), `month/`,
`modals/` (dettaglio appuntamento con `detail/`, nuova prenotazione con
`newappt/`, `rules.js` con le regole pure dei pannelli).

**Web app clienti** (`apps/client-app/src`): `routes.js` (tutte le viste, con
`personal` e `nav`), `ctx.jsx` (brand, sessione, vista corrente), `api/client.js`
(una funzione per endpoint), `hooks/` (`useApiData`, `useOtpFlow`, …), `lib/`
(funzioni pure: date nel fuso del salone, appuntamenti, catalogo, portafoglio,
link), `components/`, `screens/` (la prenotazione è divisa per passi in
`screens/prenota/`), `theme.js`.

**Pacchetto condiviso** (`packages/shared/src`): `api.js` (client HTTP),
`apiErrors.js` (`ApiError`, `apiErrorText`, `toastApiError`), `staffAuth.js` /
`clientAuth.js` (sessioni), `salon.js`, `i18n.jsx`, `format.js` (date nel fuso
del salone, euro, durate), `labels.js` (`nameIn`, mesi e giorni), `phone.js`,
`clipboard.js` (`copyText`: copia negli appunti con un ripiego, e dice se è riuscita),
`ui/` (Icon, NumInput, PhoneInput, primitive, metadati degli stati,
`useToastHost`), `styles/base.css`. Ogni nome esportato da `index.js` va
esportato anche dal sostituto dei test (`frontend/test/shared-shim.mjs`), altrimenti
i test passano e il build si rompe o viceversa (un test lo controlla).

## Chiamate all'API

I componenti non chiamano `api.*` direttamente: usano la funzione del modulo del
dominio, che ha lo stesso percorso, gli stessi parametri e lo stesso corpo e
restituisce la promessa di `api.*`.

```js
import { api } from '@youty/shared';
api.get('/api/agenda/availability', { params: { date: '2026-07-03', items } }); // oggetti e array in JSON
api.post(url, body); api.put(url, body); api.patch(url, body); api.del(url);
api.postForm(url, { qty: 5, invoice: file });                                    // multipart
```

- Autenticazione automatica (i token li installa `main.jsx` di ogni app).
  Dashboard: 401 → rinnovo silenzioso → riprova, altrimenti uscita. Web app:
  401 → uscita.
- Liste paginate: `?limit=&offset=` → `{ items, count }` (le vendite hanno
  `{ count, kpi, items }`).
- URL dei file (logo, foto, fatture) relativi: `mediaUrl(path)`.
- Errori: `toastApiError(err, fireToast, t)` mostra il messaggio del server
  (`ApiError`) o «Errore di rete»; `apiErrorText(err, t)` dà solo il testo.
  `err.status` distingue i casi: 409 slot occupato (l'agenda può riprovare con
  `force`, vedi `sections/agenda/lib/retry.js`), 412 copia vecchia (si ricarica,
  non si forza), 422 pagamenti che non tornano, 400/403/404.

## Permessi (dashboard)

`const { hasScope, session } = useDash()`; `hasScope('agenda')` è vero per il
titolare e per chi ha quel permesso. Permessi: agenda, clients, sales,
inventory, pricing, marketing, team, activity_log, insights. Le azioni di
scrittura senza permesso si nascondono o si disattivano; i dati che il server
nasconde arrivano `null` con `*_hidden: true` e si mostrano «•••».

## Stati e valori (API)

| Concetto | Valori |
|---|---|
| stato dell'appuntamento | `confirmed`, `checked_in`, `in_progress`, `closed`, `no_show`, `cancelled` |
| caparra | `none`, `required`, `paid`, `refunded`, `forfeited` |
| origine | `created_via`: `dashboard` \| `app` |
| righe di vendita | `line_type`: `service` \| `product` \| `gift_card` |
| pagamenti | `method`: `cash` \| `card` \| `other` \| `gift_card` |

`statusMeta(status, t)` e `depositMeta(dep, t)` di `@youty/shared` danno etichetta
e colore.

## Date e soldi

- Le date arrivano in ISO (`YYYY-MM-DD`, datetime con offset). Tutti i conti
  passano dagli aiuti di `format.js` nel **fuso del salone** (`setSalonTz` lo
  imposta all'avvio): `salonDateParts`, `toDateStr`, `todayStr`, `isoAtMin`,
  `minutesOfDay` (la griglia dell'agenda posiziona i blocchi coi minuti dalla
  mezzanotte del salone), `addDays`. Mai il fuso del dispositivo.
- Gli importi arrivano come stringhe decimali (`"35.00"`). Per mostrarli
  `fmtEur(Number(x), lang)`; `fmtEurOrZero` e `fmtEurNoFree` quando lo zero va
  scritto «€0» (le due differiscono sul valore mancante). I conti si fanno in
  centesimi interi con l'arrotondamento del server (vedi
  `sections/pos/money.js`).

## Modali, drawer, contesto

```js
const { openModal, closeModal } = useDash();
openModal('newappt', { prefill: { start, operatorId } });
```

- Modali registrati: `newappt`, `apptdetail`, `freedslot`, `waitlist`,
  `opportunity` (agenda), `sell` (cassa), `newclient`, `bulkimport`,
  `techsheet` (clienti), `catsmgr` (impostazioni). Ogni `openModal` monta
  un'istanza nuova: riaprire con altri dati non si porta dietro il modulo di
  prima.
- `newappt` è l'unico modo di creare un appuntamento: è un drawer a destra
  senza velo, e mentre è aperto l'agenda è in «scelta orario» (un clic su uno
  slot libero chiama `setAgendaPick`). Per scegliere una cliente c'è
  `sections/agenda/ClientPicker.jsx`.
- `useDash()` espone: `t, lang, setLang, session, hasScope, salon, settings,
  locations, locationId, setLocationId, location, operators, services,
  serviceCategories, clientCategories, reload.*(), tab, setTab(id, sub?), subTab,
  setSubTab, openModal, closeModal, modal, drawer, setDrawer, fireToast,
  toastProps, live, search, setSearch, selClient, setSelClient, deepLink,
  setDeepLink, agendaPick, setAgendaPick, agendaDate, setAgendaDate,
  showRevenue, setShowRevenue, opColors, setOpColor, opPalette`.
- **I dati condivisi restano aggiornati**: una sezione che mostra dati che
  un'altra postazione può cambiare chiama `useLive(/^(product|stock)\./, refetch)`
  (arriva, raggruppato, quando il feed live porta eventi di quel tipo; niente
  toast per le modifiche degli altri). I cataloghi di base del contesto si
  aggiornano da soli; dopo una propria scrittura che li cambia si chiama
  `reload.<catalogo>()`. Il feed può consegnare due volte lo stesso evento
  (contratto C20): si deduplica per id.
- Web app: `useApp()` espone `t, lang, setLang, brand, session, client,
  fireToast, view, setView(view, params?), viewParams, logout`.

## Interfaccia

- Tutto bilingue: `t('Italiano', 'English')` (anche `t({ it, en })`).
- Caricamento: scheletri con la classe `.skel`, mai spinner.
- Toast: `fireToast({ msg, icon: 'check', undo: t('Annulla', 'Undo'), undoFn })`.
- Chip selezionabili: `.dk-pill` (`--on`, `--tint` con `--pill-c`, `--muted`);
  orari: `.dk-slot` / `.dk-slot--on`. Lo stato «scelto» deve essere
  inequivocabile (bordo scuro, grassetto, spunta), mai solo una tinta.
- Il pulsante principale non si spegne in silenzio: `aria-disabled` e, al clic,
  un toast che dice cosa manca (vedi la lista di controllo di `NewApptModal`).
- Colori solo da variabili CSS (`var(--clay)`, `var(--ok-tint)`, …): il
  cambio di token su `.dk-root` è il meccanismo dei temi; i colori delle
  operatrici da `opColors[operator.id]`. Le pagine della dashboard stanno in
  `<div className="dk-page">`. Nella web app i colori del salone sono
  `--brand`, `--brand-ink`, `--brand-tint`, `--brand-on`, con i margini sicuri
  `--safe-top` / `--safe-bottom`.

## Test

- `npm test` esegue `node --test` sui moduli **puri**: la logica che si vuole
  provare va in un `.js` accanto al componente, senza DOM né `import.meta.env`.
- `@youty/shared` nei test è sostituito da `test/shared-shim.mjs` (le funzioni
  pure vere, un `api` finto che registra le chiamate su `globalThis.__api`).
- `apps/dashboard/test/grid-harness.mjs` compila con esbuild e un React finto i
  componenti della griglia dell'agenda e simula i gesti del puntatore
  (`expand` per i sotto-componenti senza hook). Il React finto ha solo
  useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo e memo
  (senza memoria): i componenti che monta devono restare in questo insieme.
  `installDom` dà anche un `localStorage` finto (vuoto a ogni installazione).
- `apps/client-app/test/load.mjs` fa lo stesso per hook e schermi della web
  app (`renderHook`, `mount`).
- Il JSX in generale non è coperto dai test: per i cambiamenti che toccano
  molte schermate c'è il test di fumo nel browser di `../tools/smoke/`.
