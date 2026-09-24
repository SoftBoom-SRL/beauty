"""Storico della cliente: le sue visite e la timeline unificata della scheda.

Visite, vendite, note e schede tecniche in una lista sola. Le visite escono con
la serializzazione dell'agenda (`apps.agenda.api._appointment_out`) e le
vendite con quella della cassa (`apps.sales.serializers.sale_out`), importate
pigramente: clients non importa le altre app di dominio a livello di modulo.
"""

from django.utils import timezone

from common.permissions import has_scope

from .records import note_out, sheet_out


def client_appointments_qs(salon, client):
    """Appuntamenti della cliente nel salone, con ciò che la serializzazione dell'agenda legge."""
    from apps.agenda.models import Appointment  # lazy: evita import cross-app a livello modulo

    return (
        Appointment.objects.filter(salon=salon, client=client)
        .select_related("client", "operator", "salon")
        .prefetch_related("items__service", "items__operator")
    )


def client_appointments(ctx, client) -> list[dict]:
    """Visite della cliente (passate e future) in ordine cronologico, come le serializza l'agenda."""
    from apps.agenda.api import _appointment_out, gift_index  # lazy: riuso serializzazione esistente

    appointments = client_appointments_qs(ctx.salon, client).order_by("start")
    # Indice delle gift card calcolato una volta sola: senza, _appointment_out
    # ne interroga una per appuntamento (più una SELECT sul salone, che non era
    # in select_related). Una cliente con 80 visite costava 160 query in più.
    gifts = gift_index(ctx.salon, [client.id])
    # `viewer`: chi non ha i permessi marketing o vendite vede i codici delle
    # gift card mascherati, come in agenda (contratto C21).
    return [_appointment_out(a, gifts, viewer=ctx) for a in appointments]


def build_history(ctx, client) -> dict:
    """La timeline della cliente, più recente prima (vedi l'endpoint GET …/history).

    `ctx` decide cosa si vede: senza il permesso «vendite» niente incassi
    (`sales_hidden`), e i codici delle gift card mascherati come in agenda.
    """
    from apps.agenda.api import _appointment_out, gift_index  # lazy: riuso serializzazione
    from apps.sales.serializers import sale_out  # lazy
    from apps.sales.models import Sale  # lazy

    # Gli incassi di ogni visita sono dati di cassa: senza il permesso
    # «vendite» la timeline resta completa ma senza importi, come la lista
    # degli incassi che a quel ruolo è già preclusa.
    can_read_sales = has_scope(ctx, "sales")

    appointments = list(client_appointments_qs(ctx.salon, client).order_by("-start"))
    # Una lista sola: la stessa query girava due volte, e l'indice delle gift
    # card va calcolato una volta per tutte (vedi `client_appointments`).
    gifts = gift_index(ctx.salon, [client.id])
    all_sales = (
        list(Sale.objects.filter(salon=ctx.salon, client=client).select_related("client"))
        if can_read_sales
        else []
    )
    sales = {s.appointment_id: s for s in all_sales if s.appointment_id}
    # La vendita-caparra non ha `appointment` (resta libero per il conto
    # finale) ma `deposit_appointment`: finiva fra le vendite al banco e lo
    # storico mostrava una «Vendita al banco» da 30 € accanto alla visita che
    # quei 30 € li aveva già detratti. È l'anticipo di quella visita, e lì sta.
    visit_ids = {a.id for a in appointments}
    deposits = {
        s.deposit_appointment_id: s for s in all_sales if s.deposit_appointment_id in visit_ids
    }
    counter_sales = [
        s for s in all_sales if not s.appointment_id and s.deposit_appointment_id not in visit_ids
    ]
    notes = list(client.notes.select_related("author").prefetch_related("attachments"))
    sheets = list(client.sheets.select_related("author"))
    notes_by_appt: dict = {}
    for n in notes:
        if n.appointment_id:
            notes_by_appt.setdefault(n.appointment_id, []).append(n)
    sheets_by_appt: dict = {}
    for sh in sheets:
        if sh.appointment_id:
            sheets_by_appt.setdefault(sh.appointment_id, []).append(sh)

    now = timezone.now()
    entries = []
    for a in appointments:
        sale = sales.get(a.id)
        deposit = deposits.get(a.id)
        entries.append(
            {
                "kind": "visit",
                "date": a.start,
                "upcoming": a.start >= now and a.status in ("confirmed", "checked_in", "in_progress"),
                "appointment": _appointment_out(a, gifts, viewer=ctx),
                "operator_name": a.operator.full_name if a.operator_id else "",
                "sale": sale_out(sale) if sale else None,
                "deposit_sale": sale_out(deposit) if deposit else None,
                "notes": [note_out(n) for n in notes_by_appt.get(a.id, [])],
                "sheets": [sheet_out(sh) for sh in sheets_by_appt.get(a.id, [])],
            }
        )
    for s in counter_sales:
        entries.append({"kind": "sale", "date": s.created_at, "sale": sale_out(s)})
    for n in notes:
        if not n.appointment_id:
            entries.append({"kind": "note", "date": n.created_at, "note": note_out(n)})
    for sh in sheets:
        if not sh.appointment_id:
            entries.append({"kind": "sheet", "date": sh.created_at, "sheet": sheet_out(sh)})
    entries.sort(key=lambda e: e["date"], reverse=True)
    return {
        "client_id": client.id,
        # Senza il permesso «vendite» `sale` è sempre null, anche sulle visite
        # pagate: l'interfaccia lo leggeva come «non incassato» e l'operatrice
        # diceva alla reception che la cliente l'ultima volta non aveva pagato.
        # Come `stats_hidden` sulla scheda: nascosto e assente si distinguono.
        "sales_hidden": not can_read_sales,
        "counts": {
            "visits": sum(1 for e in entries if e["kind"] == "visit" and not e["upcoming"]),
            "upcoming": sum(1 for e in entries if e["kind"] == "visit" and e["upcoming"]),
            "notes": len(notes),
            "sheets": len(sheets),
            "sales": len(sales) + len(counter_sales),
        },
        "entries": entries,
    }
