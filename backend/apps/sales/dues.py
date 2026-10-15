"""Conti da saldare: quanto una cliente deve ancora al salone (`Sale.amount_due`).

Letture condivise da cassa (checkout e storico), scheda cliente e agenda: il
debito si calcola sempre qui, così tre schermate non lo sommano in tre modi.
"""

from decimal import Decimal

from django.db.models import Sum

from .models import Sale


def open_dues(client):
    """Le vendite della cliente con qualcosa ancora da pagare, dalla più vecchia."""
    if client is None:
        return Sale.objects.none()
    return Sale.objects.filter(client=client, amount_due__gt=0).order_by("created_at", "id")


def client_amount_due(client) -> Decimal:
    """Il totale ancora da saldare della cliente (0.00 se non deve niente)."""
    if client is None:
        return Decimal("0.00")
    total = open_dues(client).aggregate(total=Sum("amount_due"))["total"]
    return (total or Decimal("0")).quantize(Decimal("0.01"))


def amounts_due_by_client(salon, client_ids) -> dict[int, Decimal]:
    """{client_id: totale da saldare} per un elenco di clienti (una query sola)."""
    rows = (
        Sale.objects.filter(salon=salon, client_id__in=list(client_ids), amount_due__gt=0)
        .values("client_id")
        .annotate(total=Sum("amount_due"))
    )
    return {row["client_id"]: row["total"].quantize(Decimal("0.01")) for row in rows}
