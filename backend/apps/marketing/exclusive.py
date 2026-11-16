"""«Exclusive Card»: iscrizione annuale a pagamento della cliente.

Il salone vende una fidelity annuale (es. 30 €) che dà uno sconto sui prodotti
finché è attiva; chi rinnova prima della scadenza paga meno (es. 25 €) e
l'anno si aggiunge alla scadenza attuale, così non perde i giorni rimasti.
Prima la teneva su un foglio a parte e la scadenza non la vedeva nessuno, né
in cassa né n8n per il promemoria di rinnovo (Beauty Boutique, 11/2026).

Le quote e lo sconto stanno in Impostazioni (`SalonSettings.exclusive_card`).
L'iscrizione e ogni rinnovo sono una vendita al banco: la quota entra in cassa.
"""

import calendar
import datetime as dt
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import SalonSettings
from apps.core.services import log_activity

from .models import ExclusiveMembership

# «In scadenza» senza altre indicazioni: entro un mese.
DEFAULT_EXPIRING_DAYS = 30


def exclusive_settings(salon) -> dict:
    """Le impostazioni della Exclusive Card, con gli importi in Decimal."""
    conf = (
        SalonSettings.objects.filter(salon=salon).values_list("exclusive_card", flat=True).first()
    ) or {}
    return {
        "enabled": bool(conf.get("enabled")),
        "price": Decimal(str(conf.get("price") or 0)),
        "renewal_price": Decimal(str(conf.get("renewal_price") or 0)),
        "product_discount_pct": int(conf.get("product_discount_pct") or 0),
    }


def add_year(day: dt.date) -> dt.date:
    """Lo stesso giorno dell'anno dopo; il 29 febbraio diventa il 28."""
    year = day.year + 1
    if day.month == 2 and day.day == 29 and not calendar.isleap(year):
        return day.replace(year=year, day=28)
    return day.replace(year=year)


def is_active(membership, today: dt.date | None = None) -> bool:
    return membership is not None and membership.expires_on >= (today or timezone.localdate())


def membership_out(m: ExclusiveMembership, today: dt.date | None = None) -> dict:
    """La forma dell'iscrizione per la dashboard e per n8n."""
    today = today or timezone.localdate()
    client = m.client
    return {
        "id": m.id,
        "client_id": client.id,
        "client_name": client.full_name,
        "phone": client.contact_phone,
        "lang": client.lang,
        "wa": client.wa,
        "marketing": bool((client.consents or {}).get("marketing")),
        "started_on": m.started_on.isoformat(),
        "expires_on": m.expires_on.isoformat(),
        "active": m.expires_on >= today,
        # negativo = scaduta da tanti giorni
        "days_left": (m.expires_on - today).days,
        "renewals": m.renewals,
    }


def membership_of(salon, client) -> ExclusiveMembership | None:
    return ExclusiveMembership.objects.filter(salon=salon, client=client).select_related("client").first()


def quote_for(salon, client) -> dict:
    """Quanto pagherebbe adesso la cliente e fino a quando varrebbe: la dashboard
    lo dice prima di incassare. `renewal` = rinnovo anticipato (iscrizione attiva)."""
    conf = exclusive_settings(salon)
    today = timezone.localdate()
    current = membership_of(salon, client)
    renewal = is_active(current, today)
    return {
        "renewal": renewal,
        "amount": conf["renewal_price"] if renewal else conf["price"],
        "expires_on": add_year(current.expires_on if renewal else today),
    }


def subscribe(salon, client, *, method: str, actor=None, receipt_issued: bool = True) -> ExclusiveMembership:
    """Iscrive la cliente alla Exclusive Card, o la rinnova, e incassa la quota.

    Iscrizione attiva (scade oggi o dopo): rinnovo anticipato a
    `renewal_price`, un anno in più dalla scadenza attuale. Nuova o scaduta:
    `price`, un anno da oggi. La quota è una vendita al banco (riga
    `membership`) con il metodo di pagamento indicato.
    """
    from apps.sales.models import Payment
    from apps.sales.services import record_membership_sale  # lazy: la cassa importa il marketing

    conf = exclusive_settings(salon)
    if not conf["enabled"]:
        raise HttpError(422, "Exclusive Card non attiva: attivala in Impostazioni")
    if method not in Payment.Method.values or method == Payment.Method.GIFT_CARD:
        raise HttpError(422, "Indica come è stata pagata la quota")
    today = timezone.localdate()
    with transaction.atomic():
        current = (
            ExclusiveMembership.objects.select_for_update()
            .filter(salon=salon, client=client)
            .first()
        )
        renewal = is_active(current, today)
        amount = conf["renewal_price"] if renewal else conf["price"]
        if current is None:
            current = ExclusiveMembership(salon=salon, client=client, started_on=today, expires_on=add_year(today))
        elif renewal:
            current.expires_on = add_year(current.expires_on)
            current.renewals += 1
        else:
            current.started_on = today
            current.expires_on = add_year(today)
            current.renewals += 1
        current.save()
        record_membership_sale(
            salon, client, amount, method=method, actor=actor, receipt_issued=receipt_issued
        )
        what = "Rinnovo" if renewal else "Iscrizione"
        log_activity(
            salon,
            "exclusive.renewed" if renewal else "exclusive.subscribed",
            f"{what} Exclusive Card di {client.full_name}: €{amount} ({method}), scade il "
            f"{current.expires_on.strftime('%d/%m/%Y')}",
            actor=actor,
            payload={
                "client_id": client.id, "amount": str(amount), "method": method,
                "expires_on": current.expires_on.isoformat(), "renewal": renewal,
            },
        )
    current.client = client
    return current


def members(salon, *, status: str | None = None, days: int | None = None, client_id: int | None = None):
    """Le iscrizioni del salone, per scadenza.

    `status`: `active` (attive), `expiring` (attive che scadono entro `days`
    giorni, 30 se manca), `expired` (scadute); senza, tutte.
    """
    if days is not None and not 0 <= days <= 366:
        raise HttpError(400, "Giorni non validi (da 0 a 366)")
    today = timezone.localdate()
    qs = ExclusiveMembership.objects.filter(salon=salon).select_related("client", "client__contact_client")
    if client_id is not None:
        qs = qs.filter(client_id=client_id)
    if status == "active":
        qs = qs.filter(expires_on__gte=today)
    elif status == "expiring":
        horizon = today + dt.timedelta(days=DEFAULT_EXPIRING_DAYS if days is None else days)
        qs = qs.filter(expires_on__gte=today, expires_on__lte=horizon)
    elif status == "expired":
        qs = qs.filter(expires_on__lt=today).order_by("-expires_on", "id")
    elif status:
        raise HttpError(400, "Stato non valido: active, expiring o expired")
    return [membership_out(m, today) for m in qs]
