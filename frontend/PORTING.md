# PORTING.md — conventions for section agents

You are porting ONE section of the Babel-standalone prototype (repo root `.jsx` files) into this
Vite monorepo. The scaffold, shared package, shell, contexts and registries already exist.
**Plain JavaScript/JSX only — no TypeScript.**

```
frontend/
  packages/shared/          @youty/shared — api, auth, i18n, format, base UI (raw ESM, no build)
  apps/dashboard/           staff dashboard (port 5173)
  apps/client-app/          client mobile web app (port 5174)
```

Backend: Django Ninja at `VITE_API_URL` (dev: http://localhost:8000, CORS open). Interactive API
docs at `http://localhost:8000/api/docs`.

---

## 1. Folder ownership — the one hard rule

**You may ONLY create/edit files inside your own section folder:**

- Dashboard: `apps/dashboard/src/sections/<yourSection>/` (your `index.jsx` is already stubbed;
  your modals are pre-created as stubs in `<yourSection>/modals/` — fill them in place).
- Client app: your screen file(s) in `apps/client-app/src/screens/` (already stubbed).

**NEVER edit:** `sections/registry.js`, `modals/registry.js`, `modals/DkModals.jsx`,
`shell/*`, `ctx.jsx`, `App.jsx`, `main.jsx`, `ui/*`, `styles/*`, anything in `packages/shared`,
or another section's folder. If you believe something is missing or wrong in those files,
**do not touch them — note it in your final report** so the integrator can fix it once.

You may add as many files as you want inside your own folder (sub-components, hooks, helpers).

## 2. Imports

```js
// shared package (works in both apps)
import {
  api, ApiError, qs, mediaUrl,                       // http
  staffAuth, clientAuth,                             // namespaced session stores
  useT, LangProvider,                                // i18n
  fmtEur, timeLabel, fmtDur, todayStr, toDateStr,
  parseISO, minutesOfDay, addDays, fmtDateIt,        // format
  Icon, Avatar, Chip, SegBar, Toggle, Sheet, Toast,
  Sparkline, ProgressBar, Delta, SectionLabel,
  EmptyState, SubHeader, useToastHost,
  statusMeta, depositMeta, segMeta,                  // UI + enum metadata
} from '@youty/shared';

// dashboard-local shell UI (from a section folder: ../../ui/...)
import { DkModal, DkDrawer, DkToast, DkSeg, FilterMenu, GroupedFilterMenu, HexInput } from '../../ui/index.js';

// dashboard context (from sections/<name>/index.jsx)
import { useDash } from '../../ctx.jsx';
// from sections/<name>/modals/X.jsx it's ../../../ctx.jsx

// client-app context (from screens/X.jsx)
import { useApp } from '../ctx.jsx';
```

## 3. API usage

```js
// GET with query params — objects/arrays are JSON-encoded automatically
const slots = await api.get('/api/agenda/availability', {
  params: { date: '2026-07-03', items: [{ service_id: 1, operator_id: null }] },
});

// POST / PUT / DELETE
const appt = await api.post('/api/agenda/appointments', { client_id, items, start });
await api.put(`/api/catalog/services/${id}`, payload);
await api.del(`/api/agenda/pauses/${id}`);

// multipart (file uploads): pass FormData or a plain object
await api.postForm(`/api/inventory/products/${id}/load`, { qty: 5, invoice: file });

// error handling → toast
import { ApiError } from '@youty/shared';
try {
  await api.post(...);
} catch (err) {
  if (err instanceof ApiError) {
    // err.status (409 slot taken, 422 payment mismatch, 400/403/404...), err.message = Ninja "detail"
    fireToast({ msg: err.message, icon: 'alert' });
  } else {
    fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
  }
}
```

- Auth headers are automatic (token providers are installed in each app's `main.jsx`).
  Dashboard: 401 → silent refresh → retry → else logout. Client app: 401 → logout.
- **Pagination envelope**: Ninja-paginated lists accept `?limit=&offset=` and return
  `{ items: [...], count: N }`. Exception: `GET /api/sales/` has its own envelope
  `{ count, kpi, items }`.
- **Media URLs** (`logo_url`, sheet photos, invoices) come back relative — wrap with
  `mediaUrl(path)` before using in `src=`.

## 4. Auth & scope gating (dashboard)

```js
const { hasScope, session } = useDash();
hasScope('agenda')   // true for owner or membership scope; scopes:
// agenda, clients, sales, inventory, pricing, marketing, team, activity_log, insights
session.is_owner     // insights endpoints are owner-only (403 otherwise)
```
Hide/disable write actions the user lacks the scope for. Reads generally only need staff auth.

## 5. Enum mappings (prototype → API)

| Concept | Prototype key | API enum |
|---|---|---|
| appointment status | `checkin` | `checked_in` |
| | `corso` | `in_progress` |
| | `arrivo`, `confermato` | `confirmed` |
| | `noshow` | `no_show` |
| | — (new) | `closed`, `cancelled` |
| deposit | `paid` | `paid` |
| | `req` | `required` |
| | `none` | `none` |
| | — (new) | `refunded`, `forfeited` |

`statusMeta(status, t)` / `depositMeta(dep, t)` from `@youty/shared` already speak the API enums
(and tolerate legacy keys). Other enums: `created_via ∈ dashboard|app`,
sale `line_type ∈ service|product|gift_card`, payment `method ∈ cash|card|other|gift_card`.

## 6. Date & money model

- **Dates**: the API sends ISO strings — `YYYY-MM-DD` for dates, full ISO8601 (with offset) for
  datetimes. Do all math with `format.js` helpers; **the agenda grid positions blocks with
  `minutesOfDay(iso)`** (minutes from local midnight; backend slot math is Europe/Rome local).
  The prototype's "minutes from midnight" APPTS model maps 1:1 through `minutesOfDay`.
  Shift `windows` come as `[["09:00","13:00"], ...]`; weekly-shift times are minutes ints.
- **Money**: decimal **strings** from the API ("35.00"). Display with `fmtEur(Number(x), lang)`;
  when sending, format strings with 2 decimals, e.g. `Number(x).toFixed(2)`.

## 7. Modals (dashboard)

```js
const { openModal, closeModal } = useDash();
openModal('newappt', { prefill: { start, operatorId } });  // props reach your component
// your modal component receives ...props plus onClose — render with <DkModal open onClose={onClose}>
```
Registered names → files (all pre-stubbed in the owning section's folder):
`newappt, apptdetail, freedslot, waitlist, opportunity` (agenda) · `sell` (pos) ·
`newclient, bulkimport, techsheet` (clienti) · `catsmgr` (impostazioni).
Need a NEW modal name? You can't add it to the registry — render it locally inside your section
(just `<DkModal>` in your own tree) or note it in your report.

## 8. Context contracts

`useDash()` (dashboard) exposes: `t, lang, setLang, session, hasScope, salon, settings, locations,
operators, services, serviceCategories, clientCategories, reload.{salon|operators|services|
serviceCategories|clientCategories}(), tab, setTab(id, sub?), subTab, setSubTab, openModal,
closeModal, modal, drawer, setDrawer(<element>|null), fireToast, search, setSearch, selClient,
setSelClient, deepLink, setDeepLink, showRevenue, setShowRevenue, opColors, setOpColor, opPalette`.

- Base catalogs are loaded once at boot; call `reload.<collection>()` after your writes mutate them.
- Everything else (appointments, sales, products, ...) is **your section's own state** — fetch it
  yourself inside your section.
- `drawer`: pass a React element; the shell renders it inside `<DkDrawer>`.
- Topbar `search` force-switches to the clienti tab — clienti filters its list with it.
- `deepLink`: cross-section jump payload (e.g. agenda cash-up sets `'log-today'` then
  `setTab('impostazioni')`; impostazioni consumes and clears it).
- `subTab` may be `null` — treat `null` as your first sub-tab (`subTab || 'prodotti'`).

`useApp()` (client app) exposes: `t, lang, setLang, brand {color,ink,tint,on,name,slug,logo,type},
session, client, fireToast, view, setView(view, params?), viewParams`.

## 9. UI conventions

- **Bilingual everywhere**: `const { t } = useT()` (or from ctx) — `t('Italiano', 'English')`.
  Object form also works: `t({ it, en })`.
- **Loading**: skeletons with the `.skel` class (`<div className="skel" style={{height: 90}}/>`),
  never spinners.
- **Toasts**: `fireToast({ msg, icon: 'check', undo: t('Annulla','Undo'), undoFn })` from ctx.
- **Styling**: keep the prototype look — CSS classes from `styles.css`/`desktop.css`
  (`.dk-card .dk-btn .dk-btn--clay .dk-row .dk-iconbtn .dk-page .t-title .t-meta ...`) plus inline
  styles referencing CSS variables (`var(--clay)`, `var(--ok-tint)`, ...). Do NOT hardcode colors;
  the `.dk-root` token remap is the theming mechanism. Operator colors: `opColors[operator.id]`.
- Dashboard sections render inside `.dk-content` — wrap your page in `<div className="dk-page">`.
- Client app: brand CSS vars (`--brand`, `--brand-ink`, `--brand-tint`, `--brand-on`) are already
  applied on the app frame; respect `--safe-top`/`--safe-bottom` paddings.

## 10. Reference data (seed)

Salon `the-parlour`, owner login `sole@theparlour.it` / `theparlour`. 9 operators, 14 services,
10 clients, 8 appointments today. Client OTP codes: read from backend console log (DEBUG) or the
`core.OutboxEvent` row with `event_type="client.otp"`. Don't start/stop the Django server yourself.

## 11. Workflow

```bash
cd frontend
npm install                      # once
npm run dev:dashboard            # http://localhost:5173
npm run dev:client               # http://localhost:5174
npm run build                    # both apps must build clean before you finish
```
Port from the prototype file(s) for YOUR section only (see prototype-map). Drop `window.*`
globals, hook aliases (`useStateDk` → `useState`), mock data (`data.jsx`) and dev chrome
(ios-frame, tweaks-panel) — replace data with API calls.
