"""Aggregati e facts della cliente: quello che l'anagrafica offre alle altre app.

`client_facts` è il dizionario standard usato da `common.conditions.evaluate`
per le regole E/O (deposito in core.DepositRule, filtri delle automazioni):
l'agenda lo importa da qui e i test lo patchano qui, quindi resta in questo
modulo. Le letture da sales e agenda importano i loro modelli pigramente, dentro
le funzioni: clients non importa le altre app di dominio a livello di modulo.
Il resto dell'anagrafica sta nei moduli accanto (fields, search, importer, …).
"""

from decimal import Decimal

from django.db.models import Count, F, Max, Q, Sum

from .models import Client


def client_stats(client: Client) -> dict:
    """Aggregati della cliente: visite, spesa totale, ultima visita.

    Visite = appuntamenti chiusi (la cliente è passata in poltrona e il conto
    è chiuso; contano anche quelli arrivati chiusi da Yourang, che una vendita
    non ce l'hanno) più i passaggi al banco, cioè le vendite senza
    appuntamento. Spesa = conti delle visite e vendite al banco.

    Dal 18/09 caparra e addebito no-show sono vendite anche loro, e venivano
    contate come tali: servizio da 100 con caparra da 30 dava 2 visite e 130 €
    spesi, la caparra rimborsata di una prenotazione annullata una visita mai
    fatta, il no-show addebitato una visita. Le regole caparra leggono questi
    numeri (`client_facts`): «Prima visita» (visite < 1) smetteva di chiedere
    la caparra dopo la prima caparra pagata, a chi in salone non era ancora
    venuta. Le due vendite restano nella cassa e nello storico; qui no.
    """
    from apps.agenda.models import Appointment  # lazy
    from apps.sales.models import Sale  # lazy

    stats = {"visits": 0, "total_spent": Decimal("0"), "last_visit": None}
    billed = (
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
    stats["total_spent"] = billed.aggregate(total=Sum("total"))["total"] or Decimal("0")

    counter = billed.filter(appointment__isnull=True)
    # Una gift card comprata al banco è un incasso, non una visita: chi regala
    # un buono non si è seduto in poltrona. Contarla gonfiava le visite e con
    # esse le regole caparra («sotto le N visite chiedi la caparra»), che
    # vedevano come abituale chi in salone non c'era mai stata. L'incasso
    # invece resta nella spesa totale: quei soldi il salone li ha presi.
    gift_only = (
        counter.annotate(
            lines_total=Count("lines"),
            gift_lines=Count("lines", filter=Q(lines__line_type="gift_card")),
        )
        .filter(lines_total__gt=0, lines_total=F("gift_lines"))
        .values_list("id", flat=True)
    )
    at_counter = counter.exclude(id__in=list(gift_only)).aggregate(
        visits=Count("id"), last=Max("created_at")
    )
    closed = Appointment.objects.filter(
        client=client, status=Appointment.Status.CLOSED
    ).aggregate(visits=Count("id"), last=Max("start"))
    stats["visits"] = (closed["visits"] or 0) + (at_counter["visits"] or 0)
    seen = [d for d in (closed["last"], at_counter["last"]) if d is not None]
    stats["last_visit"] = max(seen) if seen else None
    return stats


def client_facts(client: Client) -> dict:
    """Facts standard per `common.conditions.evaluate` (regole deposito, automazioni).

    Nessun dato → 0/[].
    """
    stats = client_stats(client)
    facts = {
        "reliability": client.reliability,
        "categories": list(
            client.categories.order_by("order", "id").values_list("name", flat=True)
        ),
        "total_spent": stats["total_spent"],
        "visits": stats["visits"],
        "noshow_count": 0,
        "latecancel_count": 0,
        "deposit_always": client.deposit_always,
    }

    from apps.agenda.models import Appointment  # lazy

    facts["noshow_count"] = Appointment.objects.filter(
        client=client, status="no_show"
    ).count()
    facts["latecancel_count"] = Appointment.objects.filter(
        client=client, cancelled_late=True
    ).count()
    return facts
