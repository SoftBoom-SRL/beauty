#!/usr/bin/env python3
"""E2E smoke test youty — prova che dashboard staff e web app cliente comunicano
attraverso lo stesso backend Django (stessa API, stesso DB).

Solo stdlib (urllib, json, sqlite3). Pensato per girare contro il server
throwaway avviato da run_e2e.sh (DB seminato con seed_demo --reset).

Uso:
    python scripts/e2e_smoke.py [--base-url http://localhost:8123] [--db <sqlite>]

Ogni step stampa [ok]/[FAIL] con evidenza; exit code != 0 se almeno uno step
fallisce. In coda: tabella di efficienza (endpoint, latenza).
"""

import argparse
import json
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

ROME = ZoneInfo("Europe/Rome")
CENT = Decimal("0.01")

SALON_SLUG = "the-parlour"
OWNER_EMAIL = "sole@theparlour.it"
OWNER_PASSWORD = "theparlour"
APP_CLIENT_PHONE = "+39 333 000 0001"

BOOK_SERVICE_NAME = "Semipermanente"     # 60 min, 35 €, operatrici sole+giulia
QUICK_SERVICE_NAME = "Manicure express"  # 25 min, 18 €, tre operatrici (slot facili)


def now_rome() -> datetime:
    return datetime.now(ROME)


def D(value) -> Decimal:
    return Decimal(str(value)).quantize(CENT)


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value)


def short(payload, limit=220) -> str:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[: limit - 1] + "…"


class StepFail(Exception):
    pass


class StepSkip(Exception):
    pass


class Http:
    """Client HTTP minimale con misura latenza per richiesta."""

    def __init__(self, base_url: str):
        self.base = base_url.rstrip("/")
        self.samples: list[dict] = []

    def request(self, method, path, *, token=None, body=None, params=None,
                expect=200, label=None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read()
        except OSError as exc:
            raise StepFail(f"{method} {url}: connessione fallita ({exc})")
        ms = (time.perf_counter() - t0) * 1000
        self.samples.append({"label": label or f"{method} {path}", "ms": ms, "status": status})
        try:
            payload = json.loads(raw.decode() or "null")
        except ValueError:
            payload = raw.decode(errors="replace")
        print(f"       {method} {path} -> {status} ({ms:.1f} ms)")
        if expect is not None and status != expect:
            raise StepFail(f"{method} {path}: atteso HTTP {expect}, ottenuto {status} — {short(payload)}")
        return status, payload

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, **kw):
        return self.request("POST", path, **kw)


# ---------------------------------------------------------------------------
# Helper di dominio
# ---------------------------------------------------------------------------


def read_latest_outbox(args, event_type: str) -> dict | None:
    """Ultimo OutboxEvent di un tipo: via sqlite (DB throwaway) o manage.py shell."""
    db = Path(args.db)
    if db.exists():
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            row = conn.execute(
                "SELECT payload FROM core_outboxevent WHERE event_type=? ORDER BY id DESC LIMIT 1",
                (event_type,),
            ).fetchone()
        finally:
            conn.close()
        return json.loads(row[0]) if row else None
    # fallback: manage.py shell (usa DATABASE_URL dell'ambiente)
    manage = Path(args.backend_dir) / "manage.py"
    code = (
        "import json;from apps.core.models import OutboxEvent;"
        f"e=OutboxEvent.objects.filter(event_type={event_type!r}).order_by('-id').first();"
        "print('@@'+json.dumps(e.payload if e else None))"
    )
    proc = subprocess.run([sys.executable, str(manage), "shell", "-c", code],
                          capture_output=True, text=True, cwd=args.backend_dir)
    if proc.returncode != 0:
        raise StepFail(f"lettura outbox fallita: {proc.stderr.strip()[:200]}")
    for line in proc.stdout.splitlines():
        if line.startswith("@@"):
            return json.loads(line[2:])
    return None


def find_public_service(catalog: list, name_it: str) -> dict | None:
    for category in catalog:
        for svc in category.get("services", []):
            if svc["name_it"] == name_it:
                return svc
    return None


def pick_slot(api, path, token, service, days, *, min_start=None, max_start=None, label):
    """Primo slot disponibile su una lista di giorni, con vincoli di orario."""
    items = json.dumps([{"service_id": service["id"], "operator_id": None}],
                       separators=(",", ":"))
    for day in days:
        _, slots = api.get(path, token=token, label=label,
                           params={"date": day.isoformat(), "items": items})
        for slot in slots:
            start = parse_iso(slot["start"])
            if min_start and start < min_start:
                continue
            if max_start and start >= max_start:
                continue
            return day, slot
    return None, None


def create_via_staff(api, ctx, service, days, *, min_start=None, max_start=None):
    """Lo staff crea un appuntamento per il cliente app al primo slot valido (retry su 409)."""
    items = json.dumps([{"service_id": service["id"], "operator_id": None}],
                       separators=(",", ":"))
    for day in days:
        _, slots = api.get("/api/agenda/availability", token=ctx["staff_token"],
                           label="GET /api/agenda/availability",
                           params={"date": day.isoformat(), "items": items})
        for slot in slots[:6]:
            start = parse_iso(slot["start"])
            if min_start and start < min_start:
                continue
            if max_start and start >= max_start:
                continue
            status, appt = api.post(
                "/api/agenda/appointments", token=ctx["staff_token"], expect=None,
                label="POST /api/agenda/appointments",
                body={
                    "client_id": ctx["app_client_id"],
                    "items": [{"service_id": service["id"],
                               "operator_id": slot["assignment"][0]["operator_id"]}],
                    "start": slot["start"],
                },
            )
            if status == 200:
                return appt
            if status != 409:  # 409 = corsa sullo slot: prova il successivo
                raise StepFail(f"creazione staff fallita: HTTP {status} — {short(appt)}")
    return None


def flatten_day(day_payload):
    for group in day_payload:
        for appt in group["appointments"]:
            yield group["operator"], appt


def checkout_body_from_items(items, payments_total: Decimal, method="cash"):
    blocks: dict[int, dict] = {}
    for item in items:
        block = blocks.setdefault(item["operator_id"],
                                  {"operator_id": item["operator_id"], "lines": []})
        block["lines"].append({
            "line_type": "service",
            "service_id": item["service_id"],
            "qty": 1,
            "unit_price": str(D(item["price"])),
        })
    return {"blocks": list(blocks.values()),
            "payments": [{"method": method, "amount": str(payments_total)}]}


# ---------------------------------------------------------------------------
# Step
# ---------------------------------------------------------------------------


def need(ctx, *keys):
    for key in keys:
        if key not in ctx:
            raise StepSkip(f"prerequisito mancante da uno step precedente: {key}")


def step_01_staff_login(api, ctx, args):
    _, auth = api.post("/api/auth/staff/login",
                       body={"email": OWNER_EMAIL, "password": OWNER_PASSWORD},
                       label="POST /api/auth/staff/login")
    if not auth.get("access") or not auth.get("refresh"):
        raise StepFail(f"token mancanti nella risposta: {short(auth)}")
    if not auth.get("is_owner"):
        raise StepFail("l'utente seed non risulta owner")
    ctx["staff_token"] = auth["access"]
    ctx["staff_refresh"] = auth["refresh"]
    _, me = api.get("/api/auth/me", token=ctx["staff_token"], label="GET /api/auth/me")
    if me.get("salon", {}).get("slug") != SALON_SLUG:
        raise StepFail(f"/auth/me salone inatteso: {short(me)}")
    return f"login owner ok, salone={me['salon']['slug']}, scopes owner, access+refresh emessi"


def step_02_staff_refresh(api, ctx, args):
    need(ctx, "staff_refresh")
    _, auth = api.post("/api/auth/staff/refresh",
                       body={"refresh": ctx["staff_refresh"]},
                       label="POST /api/auth/staff/refresh")
    if not auth.get("access") or not auth.get("refresh"):
        raise StepFail(f"refresh senza nuovi token: {short(auth)}")
    ctx["staff_token"] = auth["access"]  # da qui in poi si usa il token rinnovato
    return "refresh ok: nuova coppia access+refresh, il nuovo access viene usato negli step successivi"


def step_03_public_surface(api, ctx, args):
    _, branding = api.get("/api/core/public/branding",
                          params={"salon": SALON_SLUG},
                          label="GET /api/core/public/branding")
    if branding.get("slug") != SALON_SLUG:
        raise StepFail(f"branding inatteso: {short(branding)}")
    _, catalog = api.get("/api/catalog/public/services",
                         params={"salon": SALON_SLUG},
                         label="GET /api/catalog/public/services")
    n_services = sum(len(c.get("services", [])) for c in catalog)
    if not catalog or n_services == 0:
        raise StepFail("listino pubblico vuoto")
    ctx["catalog"] = catalog
    svc = find_public_service(catalog, BOOK_SERVICE_NAME)
    if svc is None:  # fallback: primo servizio a pagamento
        svc = next(s for c in catalog for s in c["services"] if D(s["price"]) > 0)
    quick = find_public_service(catalog, QUICK_SERVICE_NAME)
    if quick is None:
        quick = next((s for c in catalog for s in c["services"]
                      if D(s["price"]) > 0 and s["duration_min"] <= 30), svc)
    ctx["svc_book"], ctx["svc_quick"] = svc, quick
    return (f"branding '{branding['name']}' + listino pubblico con {n_services} servizi "
            f"(booking test: {svc['name_it']} €{svc['price']})")


def step_04_client_register_otp(api, ctx, args):
    status, resp = api.post(
        "/api/auth/client/register", expect=None,
        label="POST /api/auth/client/register",
        body={"salon_slug": SALON_SLUG, "first_name": "Elisa", "last_name": "Test",
              "phone": APP_CLIENT_PHONE, "email": "elisa.test@example.com", "lang": "it"})
    registered = status == 200
    if status == 400 and "registrato" in str(resp):
        # rilancio senza DB fresco: si passa da request-otp (stesso flusso OTP)
        api.post("/api/auth/client/request-otp",
                 body={"salon_slug": SALON_SLUG, "phone": APP_CLIENT_PHONE},
                 label="POST /api/auth/client/request-otp")
    elif status != 200:
        raise StepFail(f"register: HTTP {status} — {short(resp)}")

    otp = read_latest_outbox(args, "client.otp")
    if not otp or otp.get("phone") != APP_CLIENT_PHONE or not otp.get("code"):
        raise StepFail(f"OTP non trovato in OutboxEvent (client.otp): {short(otp)}")
    _, auth = api.post("/api/auth/client/verify-otp",
                       body={"salon_slug": SALON_SLUG, "phone": APP_CLIENT_PHONE,
                             "code": otp["code"]},
                       label="POST /api/auth/client/verify-otp")
    if not auth.get("access"):
        raise StepFail(f"verify-otp senza access token: {short(auth)}")
    ctx["client_token"] = auth["access"]
    ctx["app_client_id"] = auth["client"]["id"]
    _, me = api.get("/api/auth/client/me", token=ctx["client_token"],
                    label="GET /api/auth/client/me")
    if me.get("phone") != APP_CLIENT_PHONE:
        raise StepFail(f"client/me telefono inatteso: {short(me)}")
    return (f"{'registrazione' if registered else 'request-otp (cliente già presente)'} → "
            f"OTP {otp['code']} letto da OutboxEvent → verify-otp → token cliente, "
            f"client_id={ctx['app_client_id']}")


def step_05_client_books(api, ctx, args):
    need(ctx, "client_token", "svc_book")
    today = now_rome().date()
    days = [today + timedelta(days=off) for off in (1, 2, 3)]
    min_start = now_rome() + timedelta(hours=25)  # garantisce cancel ≥24h allo step 11
    day, slot = pick_slot(api, "/api/agenda/client/availability", ctx["client_token"],
                          ctx["svc_book"], days, min_start=min_start,
                          label="GET /api/agenda/client/availability")
    if slot is None:
        raise StepFail("nessuno slot ≥ now+25h nei prossimi 3 giorni")
    operator_id = slot["assignment"][0]["operator_id"]
    _, appt = api.post("/api/agenda/client/appointments", token=ctx["client_token"],
                       label="POST /api/agenda/client/appointments",
                       body={"items": [{"service_id": ctx["svc_book"]["id"],
                                        "operator_id": operator_id}],
                             "start": slot["start"]})
    if appt.get("created_via") != "app":
        raise StepFail(f"created_via atteso 'app', ottenuto {appt.get('created_via')!r}")
    ctx["appt_a"] = {"id": appt["id"], "date": day, "start": slot["start"],
                     "operator_id": appt["operator_id"],
                     "service_id": ctx["svc_book"]["id"]}
    note = "" if day == today + timedelta(days=1) else f" (adattato: {day} per rispettare policy 24h)"
    return (f"appuntamento #{appt['id']} {ctx['svc_book']['name_it']} il {day} "
            f"{slot['start'][11:16]} op={appt['operator_id']}, created_via=app{note}")


def step_06_dashboard_sees_it(api, ctx, args):
    need(ctx, "staff_token", "appt_a")
    a = ctx["appt_a"]
    _, day_view = api.get("/api/agenda/day", token=ctx["staff_token"],
                          params={"date": a["date"].isoformat()},
                          label="GET /api/agenda/day")
    hit = next((appt for op, appt in flatten_day(day_view)
                if appt["id"] == a["id"] and op["id"] == a["operator_id"]), None)
    if hit is None:
        raise StepFail(f"appuntamento #{a['id']} non presente sotto l'operatrice {a['operator_id']} in /agenda/day")
    _, week = api.get("/api/agenda/week", token=ctx["staff_token"],
                      params={"start": a["date"].isoformat()},
                      label="GET /api/agenda/week")
    in_week = any(appt["id"] == a["id"]
                  for day in week for appt in day["appointments"])
    if not in_week:
        raise StepFail(f"appuntamento #{a['id']} assente da /agenda/week")
    return (f"#{a['id']} (prenotato dall'APP) visibile in dashboard: /agenda/day sotto op "
            f"{a['operator_id']} (status {hit['status']}) e in /agenda/week")


def step_07_conflict(api, ctx, args):
    need(ctx, "client_token", "appt_a")
    a = ctx["appt_a"]
    status, resp = api.post("/api/agenda/client/appointments", token=ctx["client_token"],
                            expect=409, label="POST /api/agenda/client/appointments (conflitto)",
                            body={"items": [{"service_id": a["service_id"],
                                             "operator_id": a["operator_id"]}],
                                  "start": a["start"]})
    return f"doppia prenotazione stesso slot/operatrice → 409 «{resp.get('detail', '')}»"


def step_08_lifecycle_checkout(api, ctx, args):
    need(ctx, "staff_token")
    today = now_rome().date().isoformat()
    _, day_view = api.get("/api/agenda/day", token=ctx["staff_token"],
                          params={"date": today}, label="GET /api/agenda/day")
    open_statuses = ("confirmed", "checked_in", "in_progress")
    target = next((appt for _, appt in flatten_day(day_view)
                   if appt["deposit_status"] == "paid" and appt["status"] in open_statuses),
                  None)
    if target is None:  # fallback: un appuntamento aperto qualsiasi del seed
        target = next((appt for _, appt in flatten_day(day_view)
                       if appt["status"] in open_statuses), None)
    if target is None:
        raise StepFail("nessun appuntamento seed aperto oggi")
    aid = target["id"]
    api.post(f"/api/agenda/appointments/{aid}/check-in", token=ctx["staff_token"],
             body={}, label="POST /api/agenda/appointments/{id}/check-in")
    api.post(f"/api/agenda/appointments/{aid}/start", token=ctx["staff_token"],
             body={}, label="POST /api/agenda/appointments/{id}/start")

    total = D(target["total_price"])
    deposit = D(target["deposit_amount"]) if target["deposit_status"] == "paid" else D(0)
    due = total - deposit

    # negativo: pagamenti che NON tornano col totale → 422
    bad = checkout_body_from_items(target["items"], due + Decimal("10.00"))
    api.post(f"/api/sales/checkout/{aid}", token=ctx["staff_token"], body=bad,
             expect=422, label="POST /api/sales/checkout/{id} (422 negativo)")

    good = checkout_body_from_items(target["items"], due)
    _, out = api.post(f"/api/sales/checkout/{aid}", token=ctx["staff_token"], body=good,
                      label="POST /api/sales/checkout/{id}")
    sale = out["sale"]
    if D(sale["total"]) != total or D(sale["deposit_deducted"]) != deposit:
        raise StepFail(f"sale total/deposit errati: {short(sale)}")
    if not out.get("breakdown"):
        raise StepFail("breakdown per operatrice vuoto")
    _, day_after = api.get("/api/agenda/day", token=ctx["staff_token"],
                           params={"date": today}, label="GET /api/agenda/day")
    closed = next((appt for _, appt in flatten_day(day_after) if appt["id"] == aid), None)
    if closed is None or closed["status"] != "closed":
        raise StepFail(f"appuntamento #{aid} non risulta closed dopo il checkout")
    ctx["sale_step8"] = sale["id"]
    return (f"#{aid}: check-in → start → 422 su pagamenti sbagliati → checkout ok "
            f"(sale #{sale['id']}, totale €{total}, caparra dedotta €{deposit}, "
            f"incassato €{due}) → status closed")


def step_09_cross_surface_loyalty(api, ctx, args):
    need(ctx, "staff_token", "client_token", "app_client_id", "svc_quick")
    _, programs = api.get("/api/marketing/loyalty-programs", token=ctx["staff_token"],
                          label="GET /api/marketing/loyalty-programs")
    program = next((p for p in programs if p.get("active", True)), None)
    if program is None:
        raise StepFail("nessun programma fedeltà attivo (il seed ne crea uno)")

    today = now_rome().date()
    appt = create_via_staff(api, ctx, ctx["svc_quick"],
                            [today, today + timedelta(days=1), today + timedelta(days=2)])
    if appt is None:
        raise StepFail("nessuno slot libero per l'appuntamento creato dallo staff")
    bid = appt["id"]
    ctx["appt_b"] = {"id": bid, "start": appt["start"]}
    api.post(f"/api/agenda/appointments/{bid}/check-in", token=ctx["staff_token"],
             body={}, label="POST /api/agenda/appointments/{id}/check-in")
    total = D(appt["total_price"])  # cliente nuovo: reliability 100 → nessuna caparra
    body = checkout_body_from_items(appt["items"], total, method="cash")
    _, out = api.post(f"/api/sales/checkout/{bid}", token=ctx["staff_token"], body=body,
                      label="POST /api/sales/checkout/{id}")

    _, wallet = api.get("/api/marketing/client/wallet", token=ctx["client_token"],
                        label="GET /api/marketing/client/wallet")
    entry = next((l for l in wallet.get("loyalty", [])
                  if l["program_id"] == program["id"]), None)
    if entry is None:
        raise StepFail(f"wallet cliente senza il programma '{program['name']}': {short(wallet)}")
    if entry["points"] <= 0:
        raise StepFail(f"punti fedeltà non accreditati dopo il checkout: {short(entry)}")
    return (f"programma '{program['name']}' visto dallo staff; checkout cash €{total} "
            f"dell'appuntamento staff #{bid} → wallet APP del cliente mostra "
            f"{entry['points']} punti ({entry['progress_pct']}% soglia {entry['threshold']})")


def step_10_client_sees_dashboard_appt(api, ctx, args):
    need(ctx, "client_token", "appt_b")
    _, mine = api.get("/api/agenda/client/appointments", token=ctx["client_token"],
                      label="GET /api/agenda/client/appointments")
    bid = ctx["appt_b"]["id"]
    where = ("upcoming" if any(a["id"] == bid for a in mine["upcoming"])
             else "past" if any(a["id"] == bid for a in mine["past"]) else None)
    if where is None:
        raise StepFail(f"appuntamento staff #{bid} non visibile nella lista del cliente: {short(mine)}")
    a_ok = ""
    if "appt_a" in ctx:
        if not any(a["id"] == ctx["appt_a"]["id"] for a in mine["upcoming"]):
            raise StepFail(f"appuntamento app #{ctx['appt_a']['id']} sparito dagli upcoming")
        a_ok = f"; #{ctx['appt_a']['id']} (app) tra gli upcoming"
    return f"appuntamento creato in DASHBOARD #{bid} visibile nell'APP tra i '{where}'{a_ok}"


def step_11_cancel_slot_freed_waitlist(api, ctx, args):
    need(ctx, "client_token", "staff_token", "appt_a")
    a = ctx["appt_a"]
    _, entry = api.post("/api/agenda/client/waitlist", token=ctx["client_token"],
                        body={"service_id": a["service_id"], "preference": "any"},
                        label="POST /api/agenda/client/waitlist")
    wid = entry["id"]
    _, cancelled = api.post(f"/api/agenda/client/appointments/{a['id']}/cancel",
                            token=ctx["client_token"],
                            label="POST /api/agenda/client/appointments/{id}/cancel")
    if cancelled["status"] != "cancelled":
        raise StepFail(f"status atteso cancelled: {short(cancelled)}")
    _, day_view = api.get("/api/agenda/day", token=ctx["staff_token"],
                          params={"date": a["date"].isoformat()},
                          label="GET /api/agenda/day")
    if any(appt["id"] == a["id"] for _, appt in flatten_day(day_view)):
        raise StepFail(f"#{a['id']} ancora presente in /agenda/day dopo la cancellazione")
    freed = read_latest_outbox(args, "slot.freed")
    if not freed or freed.get("appointment_id") != a["id"]:
        raise StepFail(f"OutboxEvent slot.freed non trovato per #{a['id']}: {short(freed)}")
    if wid not in freed.get("matching_waitlist", []):
        raise StepFail(f"waitlist #{wid} assente da matching_waitlist: {short(freed)}")
    _, waitlist = api.get("/api/agenda/waitlist", token=ctx["staff_token"],
                          label="GET /api/agenda/waitlist")
    if not any(w["id"] == wid for w in waitlist):
        raise StepFail(f"waitlist #{wid} non visibile allo staff")
    _, contacted = api.post(f"/api/agenda/waitlist/{wid}/contacted",
                            token=ctx["staff_token"],
                            label="POST /api/agenda/waitlist/{id}/contacted")
    if contacted["status"] != "contacted":
        raise StepFail(f"contacted non applicato: {short(contacted)}")
    return (f"waitlist #{wid} creata dall'APP → cancel #{a['id']} ok (≥24h) → sparito da "
            f"/agenda/day → slot.freed con matching_waitlist=[{wid}…] → staff lo vede e marca contattata")


def step_12_kpis_summary(api, ctx, args):
    need(ctx, "staff_token")
    _, kpis = api.get("/api/insights/kpis", token=ctx["staff_token"],
                      params={"period": "month"}, label="GET /api/insights/kpis")
    for key in ("revenue", "sales_count", "appointments_count", "occupancy_pct"):
        if key not in kpis:
            raise StepFail(f"KPI mancante '{key}': {short(kpis)}")
    _, summary = api.get("/api/sales/today-summary", token=ctx["staff_token"],
                         label="GET /api/sales/today-summary")
    if D(summary["total"]) <= 0 or D(summary["checkout_total"]) <= 0:
        raise StepFail(f"today-summary non riflette i checkout: {short(summary)}")
    return (f"kpis mese: revenue €{kpis['revenue']}, vendite {kpis['sales_count']}, "
            f"app.ti {kpis['appointments_count']}, occupazione {kpis['occupancy_pct']}% — "
            f"today-summary: totale €{summary['total']} su {summary['count']} vendite")


def step_13_policy_negative(api, ctx, args):
    need(ctx, "staff_token", "client_token", "app_client_id", "svc_quick")
    today = now_rome().date()
    limit = now_rome() + timedelta(hours=23, minutes=30)  # start sicuro < 24h
    appt = create_via_staff(api, ctx, ctx["svc_quick"],
                            [today, today + timedelta(days=1)], max_start=limit)
    if appt is None:
        raise StepSkip("nessuno slot <24h disponibile a quest'ora (rieseguire in orario di apertura)")
    cid = appt["id"]
    status, resp = api.post(f"/api/agenda/client/appointments/{cid}/cancel",
                            token=ctx["client_token"], expect=400,
                            label="POST /api/agenda/client/appointments/{id}/cancel (<24h)")
    _, moved = api.post(f"/api/agenda/client/appointments/{cid}/move",
                        token=ctx["client_token"], expect=400,
                        body={"start": appt["start"]},
                        label="POST /api/agenda/client/appointments/{id}/move (<24h)")
    return (f"appuntamento staff #{cid} a {appt['start'][11:16]} (<24h): cancel → 400 "
            f"«{resp.get('detail', '')[:40]}…», move → 400 (policy {24}h rispettata)")


def step_14_placeholders(api, ctx, args):
    need(ctx, "staff_token", "client_token")
    _, ask = api.post("/api/insights/ask", token=ctx["staff_token"], expect=501,
                      body={"question": "Quanto ho incassato oggi?"},
                      label="POST /api/insights/ask")
    _, intent = api.post("/api/sales/client/setup-intent", token=ctx["client_token"],
                         expect=503, label="POST /api/sales/client/setup-intent")
    return (f"insights/ask → 501 «{ask.get('detail', '')[:45]}» ; "
            f"setup-intent → 503 «{intent.get('detail', '')[:30]}» (Stripe non configurato)")


STEPS = [
    ("Staff login (dashboard) + /auth/me", step_01_staff_login),
    ("Staff refresh token", step_02_staff_refresh),
    ("Superficie pubblica app cliente (branding + listino)", step_03_public_surface),
    ("Registrazione cliente + OTP da OutboxEvent + client/me", step_04_client_register_otp),
    ("Cliente prenota dall'app (availability → booking, created_via=app)", step_05_client_books),
    ("La dashboard vede la prenotazione dell'app (day + week)", step_06_dashboard_sees_it),
    ("Doppia prenotazione stesso slot → 409", step_07_conflict),
    ("Ciclo staff: check-in → start → checkout (con 422 negativo)", step_08_lifecycle_checkout),
    ("Fedeltà cross-surface: checkout staff → punti nel wallet app", step_09_cross_surface_loyalty),
    ("Il cliente vede l'appuntamento creato dalla dashboard", step_10_client_sees_dashboard_appt),
    ("Cancellazione app → slot.freed + waitlist vista dallo staff", step_11_cancel_slot_freed_waitlist),
    ("KPI owner + incassi di oggi", step_12_kpis_summary),
    ("Policy 24h: cancel/move cliente <24h → 400", step_13_policy_negative),
    ("Placeholder: insights/ask 501, setup-intent 503", step_14_placeholders),
]


def print_latency_table(samples):
    agg: dict[str, list[float]] = {}
    for s in samples:
        agg.setdefault(s["label"], []).append(s["ms"])
    width = max(len(label) for label in agg) + 2
    print("\nTabella di efficienza (latency per endpoint)")
    print(f"{'endpoint':<{width}}{'n':>4}{'avg ms':>10}{'min ms':>10}{'max ms':>10}")
    print("-" * (width + 34))
    for label, values in sorted(agg.items()):
        print(f"{label:<{width}}{len(values):>4}{sum(values)/len(values):>10.1f}"
              f"{min(values):>10.1f}{max(values):>10.1f}")
    total_ms = sum(s["ms"] for s in samples)
    print("-" * (width + 34))
    print(f"{'TOTALE':<{width}}{len(samples):>4}{total_ms:>10.1f} ms complessivi\n")


def main():
    backend_dir = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="E2E smoke test youty (dashboard ↔ app cliente)")
    parser.add_argument("--base-url", default="http://localhost:8123")
    parser.add_argument("--db", default=str(backend_dir / "e2e_db.sqlite3"),
                        help="sqlite throwaway per leggere OutboxEvent (OTP, slot.freed)")
    parser.add_argument("--backend-dir", default=str(backend_dir))
    args = parser.parse_args()

    api = Http(args.base_url)
    ctx: dict = {}
    results = []
    print(f"E2E smoke — base_url={args.base_url} db={args.db}")
    print(f"ora locale salone (Europe/Rome): {now_rome():%Y-%m-%d %H:%M}\n")

    for index, (title, func) in enumerate(STEPS, start=1):
        print(f"--- step {index:02d}: {title}")
        try:
            evidence = func(api, ctx, args)
            results.append(("ok", index, title, evidence))
            print(f"[ok]   {index:02d} {title}\n       {evidence}\n")
        except StepSkip as exc:
            results.append(("skip", index, title, str(exc)))
            print(f"[skip] {index:02d} {title} — {exc}\n")
        except StepFail as exc:
            results.append(("FAIL", index, title, str(exc)))
            print(f"[FAIL] {index:02d} {title}\n       {exc}\n")
        except Exception as exc:  # bug dello script: comunque FAIL esplicito
            results.append(("FAIL", index, title, f"{type(exc).__name__}: {exc}"))
            print(f"[FAIL] {index:02d} {title} — errore inatteso {type(exc).__name__}: {exc}\n")

    print("=" * 72)
    for outcome, index, title, detail in results:
        tag = {"ok": "[ok]  ", "skip": "[skip]", "FAIL": "[FAIL]"}[outcome]
        print(f"{tag} {index:02d} {title}")
        if outcome == "FAIL":
            print(f"        {detail}")
    failed = [r for r in results if r[0] == "FAIL"]
    skipped = [r for r in results if r[0] == "skip"]
    print(f"\nEsito: {len(results) - len(failed) - len(skipped)} ok, "
          f"{len(skipped)} skip, {len(failed)} FAIL su {len(results)} step")

    if api.samples:
        print_latency_table(api.samples)

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
