"""Passo «sheets»: le schede tecniche NAILS e BROWS / LASHES.

Ogni riga della tabella «INFORMAZIONI AGGIUNTIVE» di AreaBeauty è una visita:
diventa una `TechnicalSheet` con la data della riga, agganciata
all'appuntamento della cliente in quel giorno (la riga non dice quale). Il
trattamento è quello scritto nella scheda (BROWS) oppure il servizio principale
di quel giorno; i campi senza un posto loro finiscono in `params`.
"""

import datetime as dt
from collections import defaultdict

from apps.agenda.models import Appointment
from apps.clients.models import TechnicalSheet

from ..source import ROME, local_dt
from ..util import clip, norm

TEMPLATES = {
    "1": {"category": "nail", "default": "Scheda unghie"},
    "4": {"category": "brows", "default": "Scheda ciglia e sopracciglia"},
}
# Campo di AreaBeauty (normalizzato) → campo della scheda beauty. Gli altri vanno in `params`.
FIELDS = {
    "colore": "products",
    "note": "protocol",
    "tempo tenuta": "duration_hold",
    "consigli": "advice",
    "consiglio prodotto": "advice",
    "trattamento": "treatment",
}
SKIP = {"foto"}


def run(ctx):
    clients = ctx.refs("cliente")
    visits = _visits(ctx)
    sheets, exts = [], []
    for client_ext, rec in ctx.source.client_details.items():
        client_pk = clients.get(client_ext)
        if not client_pk:
            continue
        for template_id, scheda in (rec.get("schede") or {}).items():
            spec = TEMPLATES.get(str(template_id))
            if spec is None:
                continue
            for table in scheda.get("TabellaCampiMultipli") or []:
                for riga in table.get("Righe") or []:
                    ext = f"{template_id}:{riga.get('IdRiga')}"
                    if ctx.ref("scheda", ext):
                        continue
                    sheet = _sheet(ctx, spec, client_pk, riga, visits)
                    if sheet is None:
                        ctx.count("righe vuote saltate")
                        continue
                    sheets.append(sheet)
                    exts.append(ext)
                    ctx.count(f"schede {spec['category']}")
    TechnicalSheet.objects.bulk_create(sheets, batch_size=1000)
    for sheet in sheets:
        sheet.created_at = sheet._date
    TechnicalSheet.objects.bulk_update(sheets, ["created_at"], batch_size=1000)
    ctx.link_many("scheda", list(zip(exts, sheets)))


def _visits(ctx) -> dict:
    """{(id cliente beauty, giorno): (appuntamento, nome del servizio principale)} delle visite fatte."""
    out = {}
    durations = defaultdict(int)
    qs = (
        Appointment.objects.filter(salon=ctx.salon, status__in=[Appointment.Status.CLOSED, Appointment.Status.CONFIRMED])
        .prefetch_related("items__service")
        .order_by("start")
    )
    for a in qs:
        key = (a.client_id, a.start.astimezone(ROME).date())
        for item in a.items.all():
            if item.duration_min > durations[key]:
                durations[key] = item.duration_min
                out[key] = (a, item.service.name_it)
        if key not in out:
            out[key] = (a, "")
    return out


def _sheet(ctx, spec, client_pk, riga, visits):
    values = {}
    for v in riga.get("Valori") or []:
        name = norm((v.get("Campo") or {}).get("Nome"))
        value = str(v.get("Valore") or "").strip()
        if value and name not in SKIP:
            values[(name, (v.get("Campo") or {}).get("Nome") or name)] = value
    if not values:
        return None
    when = local_dt(riga.get("Data")) or local_dt(riga.get("DataCreazione"))
    visit = visits.get((client_pk, when.date())) if when else None
    data = {"products": [], "protocol": [], "duration_hold": [], "advice": [], "treatment": []}
    params = {}
    for (key, label), value in values.items():
        target = FIELDS.get(key)
        if target:
            data[target].append(value)
        else:
            params[label.strip().lower()] = value
    treatment = " · ".join(data["treatment"]) or (visit[1] if visit else "") or spec["default"]
    sheet = TechnicalSheet(
        client_id=client_pk,
        appointment=visit[0] if visit else None,
        category=spec["category"],
        treatment=clip(treatment, 120),
        products="\n".join(data["products"]),
        protocol="\n".join(data["protocol"]),
        duration_hold=clip(" · ".join(data["duration_hold"]), 60),
        advice="\n".join(data["advice"]),
        params=params,
    )
    if visit:
        sheet._date = visit[0].start
    elif when:
        sheet._date = when.replace(hour=12) if when.time() == dt.time(0, 0) else when
    else:
        sheet._date = None
    if sheet._date is None:
        return None
    return sheet
