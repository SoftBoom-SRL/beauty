"""Sedute dei pacchetti: dalla riga di vendita alle carte a trattamento della cliente.

Un pacchetto di listino (catalog.Package) è un insieme di servizi con le loro
quantità. Venduto in cassa diventa una carta a trattamento per servizio
(`GiftCard` di tipo «package», `sessions_total` = quantità): l'agenda la mostra
sugli appuntamenti di quel servizio, la cassa la scala seduta per seduta, la
scheda cliente ne conta le sedute rimaste. È la stessa strada delle gift card
«a trattamento», con più sedute invece di una.

La cassa (apps.sales.services.finalize_sale) chiama `create_package_credits`
per ogni riga di tipo «package»: la firma NON va cambiata.
"""

from datetime import timedelta
from decimal import ROUND_DOWN, Decimal

from django.utils import timezone
from ninja.errors import HttpError

from common.money import CENT

from .gift_cards import create_gift_card
from .models import GiftCard


def package_expiry(package, start=None):
    """Scadenza delle sedute: `validity_days` dalla vendita, oppure None (mai)."""
    if not package.validity_days:
        return None
    return (start or timezone.now()) + timedelta(days=package.validity_days)


def create_package_credits(
    salon,
    *,
    package,
    client,
    amount,
    sale=None,
    line=None,
    paid_method="",
    actor=None,
    expires_at=None,
) -> list[GiftCard]:
    """Crea le sedute di `package` per `client`, pagate `amount` in tutto.

    Una carta per servizio del pacchetto, con tante sedute quante la sua
    quantità. L'importo si divide fra le carte in proporzione al listino
    (prezzo × quantità); l'ultima prende il resto, così le carte sommano
    esattamente quanto incassato. `amount` = 0 (pacchetto in omaggio) crea
    sedute a valore zero, che si scalano senza toccare la cassa.
    """
    if client is None:
        raise HttpError(422, "Un pacchetto si vende a una cliente: sceglila prima di incassare")
    items = list(package.items.select_related("service").order_by("id"))
    if not items:
        raise HttpError(422, f"Il pacchetto «{package.name}» non contiene servizi")
    amount = Decimal(amount).quantize(CENT)
    if amount < 0:
        raise HttpError(422, "Importo del pacchetto non valido")
    weights = [Decimal(item.service.price or 0) * item.qty for item in items]
    total_weight = sum(weights, Decimal("0"))
    if expires_at is None:
        expires_at = package_expiry(package)

    cards = []
    allocated = Decimal("0.00")
    for index, (item, weight) in enumerate(zip(items, weights)):
        if index == len(items) - 1:
            value = amount - allocated
        elif total_weight > 0:
            value = (amount * weight / total_weight).quantize(CENT, rounding=ROUND_DOWN)
        else:
            value = (amount / len(items)).quantize(CENT, rounding=ROUND_DOWN)
        allocated += value
        cards.append(
            create_gift_card(
                salon,
                value,
                gift_service=item.service,
                buyer_client=client,
                recipient_client=client,
                # Il nome come per le carte intestate dalla maschera: senza,
                # l'elenco di Promozioni scriveva le sedute «a —».
                recipient_name=client.full_name[:120],
                paid=True,
                paid_method=paid_method,
                sold_by=actor,
                sale=sale,
                # L'incasso è quello della vendita del pacchetto: nel registro
                # non si ripete carta per carta.
                cash_in=False,
                kind=GiftCard.Kind.PACKAGE,
                sessions=item.qty,
                package=package,
                package_line=line,
                expires_at=expires_at,
            )
        )
    return cards
