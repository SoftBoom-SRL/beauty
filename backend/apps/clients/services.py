"""Aggregati e facts della cliente: quello che l'anagrafica offre alle altre app.

`client_facts` è il dizionario standard usato da `common.conditions.evaluate`
per le regole E/O (deposito in core.DepositRule, filtri delle automazioni):
l'agenda lo importa da qui e i test lo patchano qui, quindi resta in questo
modulo. Qui stanno anche le due regole di conteggio che le altre schermate
devono ripetere uguali: le visite contate per GIORNO (`visit_days`) e
l'affidabilità calcolata dai no-show e dagli annullamenti tardivi
(`reliability_basis`, `recompute_reliability`). Le letture da sales e agenda
importano i loro modelli pigramente, dentro le funzioni: clients non importa le
altre app di dominio a livello di modulo. Il resto dell'anagrafica sta nei
moduli accanto (fields, search, importer, …).
"""

import datetime as dt
from collections import defaultdict
from decimal import Decimal

from django.db.models import Count, F, Max, Q, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone

from apps.core.services import log_activity

from .models import Client

# Righe di vendita che da sole non fanno una visita: chi compra un buono da
# regalare o un pacchetto di sedute paga al banco, ma in poltrona non si è
# seduta. Vedi `_counter_visits`.
NOT_A_VISIT_LINES = ("gift_card", "package")

# Affidabilità: si parte da 100 e ogni giorno con un no-show negli ultimi 12
# mesi toglie 25 punti, ogni giorno con un annullamento tardivo 10. Era un
# numero scritto a mano che nessuno aggiornava: la cliente che saltava tre
# appuntamenti restava a 100 e le regole caparra («affidabilità sotto 60») non
# scattavano mai.
RELIABILITY_MONTHS = 12
NO_SHOW_PENALTY = 25
LATE_CANCEL_PENALTY = 10


# ---- Visite: un giorno, non un appuntamento ------------------------------------


def _billed_sales(client: Client):
    """Le vendite della cliente che sono spesa per servizi e prodotti.

    Dal 18/09 caparra e addebito no-show sono vendite anche loro, e venivano
    contate come tali: servizio da 100 con caparra da 30 dava 2 visite e 130 €
    spesi, la caparra rimborsata di una prenotazione annullata una visita mai
    fatta, il no-show addebitato una visita. Le due vendite restano nella cassa
    e nello storico; qui no.
    """
    from apps.sales.models import Sale  # lazy

    return (
        Sale.objects.filter(client=client)
        # La vendita-caparra è l'anticipo di un conto che, al checkout, la
        # contiene già per intero (`deposit_deducted`): sommarla la conta due
        # volte. Se la visita non c'è stata, non è comunque una spesa per
        # servizi ricevuti.
        .filter(deposit_appointment__isnull=True)
        # L'addebito no-show è l'unica vendita al banco agganciata a un
        # appuntamento (sales.services._money_sale): una penale, non un conto.
        .exclude(kind=Sale.Kind.POS, appointment__isnull=False)
    )


def _counter_visits(billed):
    """I passaggi al banco (vendite senza appuntamento) che sono visite.

    Una gift card comprata al banco è un incasso, non una visita: chi regala un
    buono non si è seduto in poltrona. Contarla gonfiava le visite e con esse
    le regole caparra («sotto le N visite chiedi la caparra»), che vedevano come
    abituale chi in salone non c'era mai stata. Lo stesso vale per un pacchetto
    di sedute pagato in anticipo: le visite saranno le sedute, non l'acquisto.
    L'incasso invece resta nella spesa totale: quei soldi il salone li ha presi.
    """
    counter = billed.filter(appointment__isnull=True)
    not_visits = (
        counter.annotate(
            lines_total=Count("lines"),
            other_lines=Count("lines", filter=Q(lines__line_type__in=NOT_A_VISIT_LINES)),
        )
        .filter(lines_total__gt=0, lines_total=F("other_lines"))
        .values_list("id", flat=True)
    )
    return counter.exclude(id__in=list(not_visits))


def _days(queryset, field: str) -> tuple[set, dt.datetime | None]:
    """I giorni (nel fuso del salone) di `field` e l'istante più recente, in una query."""
    rows = (
        queryset.order_by()
        .annotate(day=TruncDate(field))
        .values("day")
        .annotate(last=Max(field))
    )
    days, last = set(), None
    for row in rows:
        days.add(row["day"])
        if last is None or row["last"] > last:
            last = row["last"]
    return days, last


def visit_days(client: Client, *, counter_sales: bool = True) -> tuple[set, dt.datetime | None]:
    """I giorni in cui la cliente è venuta in salone, e l'ultima volta che c'è stata.

    Un giorno conta se ha almeno una visita chiusa (la cliente è passata in
    poltrona e il conto è chiuso; valgono anche quelle arrivate chiuse da
    Yourang, che una vendita non ce l'hanno) o un passaggio al banco. Si
    contano i GIORNI, non gli appuntamenti: mani e piedi in contemporanea con
    due operatrici sono due appuntamenti ma una visita sola, e contarli a parte
    raddoppiava le visite di chi prenota più servizi insieme — con le regole
    caparra («sotto le 3 visite») che la davano per abituale dopo un pomeriggio.

    `counter_sales=False` lascia fuori le vendite al banco: lo storico di chi
    non ha il permesso «vendite» non le mostra, e il conteggio resta quello
    delle visite che vede.
    """
    from apps.agenda.models import Appointment  # lazy

    closed = Appointment.objects.filter(client=client, status=Appointment.Status.CLOSED)
    days, last = _days(closed, "start")
    if counter_sales:
        counter_days, counter_last = _days(_counter_visits(_billed_sales(client)), "created_at")
        days |= counter_days
        if counter_last is not None and (last is None or counter_last > last):
            last = counter_last
    return days, last


def client_stats(client: Client) -> dict:
    """Aggregati della cliente: visite, spesa totale, ultima visita.

    Visite = giorni con una visita chiusa o un passaggio al banco
    (`visit_days`). Spesa = conti delle visite e vendite al banco, senza
    caparre né penali no-show (`_billed_sales`). Le regole caparra leggono
    questi numeri (`client_facts`): «Prima visita» (visite < 1) smetteva di
    chiedere la caparra dopo la prima caparra pagata, a chi in salone non era
    ancora venuta.
    """
    billed = _billed_sales(client)
    days, last = visit_days(client)
    return {
        "visits": len(days),
        "total_spent": billed.aggregate(total=Sum("total"))["total"] or Decimal("0"),
        "last_visit": last,
    }


# ---- Affidabilità: calcolata, non scritta a mano -----------------------------


def reliability_since(today: dt.date | None = None) -> dt.date:
    """Il primo giorno che conta per l'affidabilità: lo stesso giorno di un anno fa."""
    today = today or timezone.localdate()
    try:
        return today.replace(year=today.year - 1)
    except ValueError:  # 29 febbraio
        return today.replace(year=today.year - 1, day=28)


def reliability_score(no_shows: int, late_cancellations: int) -> int:
    """100 − 25 per ogni no-show − 10 per ogni annullamento tardivo, fra 0 e 100."""
    score = 100 - NO_SHOW_PENALTY * no_shows - LATE_CANCEL_PENALTY * late_cancellations
    return max(0, min(100, score))


def _penalty_rows(appointments):
    """(cliente, giorno, stato) di no-show e annullamenti tardivi: il giorno nel fuso del salone."""
    from apps.agenda.models import Appointment  # lazy

    return (
        appointments.filter(
            Q(status=Appointment.Status.NO_SHOW)
            | Q(status=Appointment.Status.CANCELLED, cancelled_late=True)
        )
        .order_by()
        .annotate(day=TruncDate("start"))
        .values_list("client_id", "day", "status")
    )


def penalty_days(rows, since: dt.date | None = None) -> tuple[set, set]:
    """(giorni con un no-show, giorni con un annullamento tardivo) da `_penalty_rows`.

    Ogni giorno conta una volta, come le visite: la cliente che salta mani e
    piedi prenotati in contemporanea con due operatrici ha mancato UN
    appuntamento con il salone, non due. E un giorno con un no-show non pesa
    anche come annullamento tardivo, se uno dei due servizi era stato disdetto
    all'ultimo. `since` lascia fuori i giorni prima di quella data.
    """
    no_show, late = set(), set()
    for _client_id, day, status in rows:
        if since is not None and day < since:
            continue
        (no_show if status == "no_show" else late).add(day)
    return no_show, late - no_show


def reliability_basis(client: Client, today: dt.date | None = None) -> dict:
    """L'affidabilità della cliente e da dove viene.

    → {"score", "no_shows", "late_cancellations", "since"}: i due conteggi sono
    i GIORNI degli ultimi 12 mesi (da `since`), quelli che tolgono punti.
    """
    from apps.agenda.models import Appointment  # lazy

    since = reliability_since(today)
    rows = _penalty_rows(Appointment.objects.filter(client=client))
    no_show, late = penalty_days(rows, since)
    return {
        "score": reliability_score(len(no_show), len(late)),
        "no_shows": len(no_show),
        "late_cancellations": len(late),
        "since": since,
    }


def recompute_reliability(client: Client, *, actor=None, log: bool = True) -> int:
    """Ricalcola e salva l'affidabilità della cliente; ritorna il punteggio.

    Si chiama quando una visita diventa no-show o annullata in ritardo, e
    quando torna indietro da quegli stati (agenda: transizioni e «torna
    indietro»; sync Yourang). Scrive solo se il valore cambia, con un UPDATE
    della sola colonna: il salvataggio completo riscriverebbe la scheda letta
    prima, magari vecchia. Con `log` un punteggio cambiato finisce nel registro
    come `client.updated`: la scheda aperta su un'altra postazione si rilegge e
    non resta col numero di prima.
    """
    score = reliability_basis(client)["score"]
    changed = Client.objects.filter(pk=client.pk).exclude(reliability=score).update(reliability=score)
    client.reliability = score
    if changed and log:
        log_activity(
            client.salon,
            "client.updated",
            f"Affidabilità di {client.full_name}: {score}/100",
            actor=actor,
            payload={"client_id": client.id, "fields": ["reliability"], "reliability": score},
        )
    return score


def recompute_salon_reliability(salon, today: dt.date | None = None) -> int:
    """Ricalcola l'affidabilità di tutte le schede del salone; ritorna quante sono cambiate.

    Serve dopo un import (no-show e annullamenti arrivati da un altro
    gestionale) e una volta al giorno: un no-show di tredici mesi fa non conta
    più, ma nessun gesto lo dice alla scheda. Una query per i no-show del
    salone e un UPDATE per ogni punteggio diverso: non una scrittura per
    cliente.
    """
    from apps.agenda.models import Appointment  # lazy

    since = reliability_since(today)
    rows = _penalty_rows(Appointment.objects.filter(salon=salon)).filter(day__gte=since)
    by_client: dict[int, list] = defaultdict(list)
    for row in rows:
        by_client[row[0]].append(row)
    by_score: dict[int, list[int]] = defaultdict(list)
    for client_id, client_rows in by_client.items():
        no_show, late = penalty_days(client_rows)
        by_score[reliability_score(len(no_show), len(late))].append(client_id)

    clients = Client.objects.filter(salon=salon)
    changed = clients.exclude(id__in=list(by_client)).exclude(reliability=100).update(reliability=100)
    for score, ids in by_score.items():
        changed += clients.filter(id__in=ids).exclude(reliability=score).update(reliability=score)
    if changed:
        cards = "1 scheda aggiornata" if changed == 1 else f"{changed} schede aggiornate"
        log_activity(
            salon,
            "client.reliability_recomputed",
            f"Affidabilità ricalcolata: {cards}",
            payload={"changed": changed},
        )
    return changed


# ---- Facts per le condizioni E/O ---------------------------------------------


def client_facts(client: Client) -> dict:
    """Facts standard per `common.conditions.evaluate` (regole deposito, automazioni).

    `reliability` è quella calcolata ora, non la colonna: un no-show uscito
    dalla finestra dei 12 mesi non deve far chiedere la caparra finché qualcuno
    non ricalcola. `noshow_count` e `latecancel_count` contano i giorni di
    sempre, con la stessa regola dell'affidabilità (un giorno, un no-show).
    Nessun dato → 0/[].
    """
    from apps.agenda.models import Appointment  # lazy

    stats = client_stats(client)
    rows = list(_penalty_rows(Appointment.objects.filter(client=client)))
    no_show_ever, late_ever = penalty_days(rows)
    no_show, late = penalty_days(rows, reliability_since())
    return {
        "reliability": reliability_score(len(no_show), len(late)),
        "categories": list(
            client.categories.order_by("order", "id").values_list("name", flat=True)
        ),
        "total_spent": stats["total_spent"],
        "visits": stats["visits"],
        "noshow_count": len(no_show_ever),
        "latecancel_count": len(late_ever),
        "deposit_always": client.deposit_always,
    }
