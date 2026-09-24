"""Chiusura del conto di un appuntamento: la vendita, la visita chiusa, la caparra detratta o restituita.

L'endpoint (`api.checkout`) controlla il permesso e che l'appuntamento sia del
salone; il resto stava tutto dentro la vista. Nella transazione: lock del
salone e poi della riga, rilettura, vendita (`services.finalize_sale`), stato
«chiuso» e registro attività. Fuori, perché parlano con Stripe o con
l'esterno: il link della caparra chiuso, l'eccedenza restituita e l'evento
`visit.completed`.
"""

import logging

from django.db import IntegrityError, transaction
from ninja.errors import HttpError

from apps.agenda.models import Appointment
from apps.core.services import emit_event, log_activity

from . import stripe_service
from .deposits import deposit_retained, settle_deposit_excess
from .models import Sale
from .services import finalize_sale

logger = logging.getLogger("youty.stripe")


def checkout_appointment(salon, appointment_id: int, payload: dict, *, actor=None) -> Sale:
    """Incassa l'appuntamento `appointment_id` del salone e ritorna la vendita creata.

    `payload` è il corpo del checkout (`CheckoutIn`): blocchi di righe,
    pagamenti e buono sconto, come li vuole `finalize_sale`. 404 se
    l'appuntamento non c'è più; 400 se è annullato, no-show o già incassato.
    """
    from apps.agenda.services import lock_salon  # lazy

    with transaction.atomic():
        # Prima il salone, poi la riga: lo stesso ordine delle mutazioni
        # d'agenda. Senza il lock del salone un annullamento (o un check-in, o
        # un «torna indietro») rileggeva l'appuntamento prima del commit della
        # cassa e poi lo riscriveva: visita «annullata» con la sua vendita, e
        # caparra già detratta rimborsata (05-20). Nell'ordine inverso, su
        # PostgreSQL, cassa e agenda potevano aspettarsi a vicenda (18-08).
        lock_salon(salon)
        # Rilettura sotto lock DENTRO la transazione della vendita: fra l'inizio
        # della richiesta e adesso la cliente può aver pagato il link della
        # caparra. Prima si decideva (e si salvava) sulla copia vecchia, e il
        # save() pieno riportava `deposit_status` a «richiesta» azzerando il
        # PaymentIntent: 30 € incassati su Stripe, non detratti e non più
        # rimborsabili.
        appointment = (
            Appointment.objects.select_for_update()
            .filter(pk=appointment_id, salon=salon)
            .first()
        )
        if appointment is None:
            raise HttpError(404, "Appuntamento non trovato")
        # Un appuntamento annullato o segnato come no-show non è stato erogato:
        # incassarlo lo riporterebbe a «chiuso» e conterebbe nei ricavi un servizio
        # che nessuno ha fatto. Il no-show si addebita con la sua funzione.
        if appointment.status in ("cancelled", "no_show"):
            raise HttpError(
                400,
                "Appuntamento annullato o segnato come no-show: non può essere incassato",
            )
        if Sale.objects.filter(appointment=appointment).exists():
            raise HttpError(400, "Appuntamento già incassato")

        # Non `deposit_amount`: quello che si detrae è la quota ancora in cassa,
        # cioè al netto dei rimborsi già fatti su quella caparra.
        deposit_credit = appointment.deposit_credit
        # Quanto della caparra è ancora del salone, contando anche i rimborsi
        # in volo: con un rimborso parziale «pending» la quota detraibile è
        # zero, ma il resto va comunque restituito qui sotto (02-21, 05-14).
        deposit_retained_amount = deposit_retained(appointment)
        try:
            sale = finalize_sale(
                salon,
                kind=Sale.Kind.CHECKOUT,
                blocks=payload["blocks"],
                payments=payload["payments"],
                client=appointment.client,
                appointment=appointment,
                location=appointment.location,
                deposit_deducted=deposit_credit,
                coupon_code=payload["coupon_code"],
                actor=actor,
            )
        except IntegrityError:
            # Due checkout partiti insieme: il controllo qui sopra li lascia passare
            # entrambi, il vincolo di unicità ne ferma uno. Senza questo ramo la
            # cassiera vede un errore 500 invece del messaggio giusto.
            raise HttpError(400, "Appuntamento già incassato")

        # Solo lo stato: ogni altra colonna resta quella scritta nel frattempo.
        appointment.status = "closed"
        appointment.save(update_fields=["status", "updated_at"])
        # Un evento che l'agenda riceve: `sale.created` arriva solo a chi ha
        # il permesso vendite, e l'operatrice continuava a vedere la visita
        # «in corso» finché qualcos'altro non le ricaricava la giornata (08-03).
        # Niente importi: l'agenda la vede anche chi non vede la cassa.
        log_activity(
            salon,
            "appointment.closed",
            f"Visita di {appointment.client.full_name} chiusa in cassa",
            actor=actor,
            payload={"appointment_id": appointment.id, "status": "closed"},
        )

    # Da qui in poi si parla con Stripe: fuori dalla transazione, perché una
    # rete lenta non deve tenere il lock sull'appuntamento.
    _close_deposit_link(appointment)
    # Caparra più alta del conto: `finalize_sale` ha detratto solo fino al
    # totale, la differenza va restituita (prima il conto era impossibile).
    # Si parte da quanto il salone ha ancora, non dalla sola quota detraibile.
    settle_deposit_excess(
        appointment,
        max(deposit_retained_amount, deposit_credit) - sale.deposit_deducted,
        actor=actor,
    )
    _emit_visit_completed(salon, appointment, sale)
    return sale


def _close_deposit_link(appointment) -> None:
    """Chiude il link della caparra a conto chiuso.

    Il link restava pagabile anche dopo la cassa: caparra da 30 non pagata
    online, cliente che salda 100 in salone e poi apre il link — il salone
    incassava 130 per un conto da 100, senza rimborso né avviso. Un errore di
    Stripe qui non deve far fallire un incasso già registrato.
    """
    try:
        stripe_service.expire_deposit_checkout(appointment)
    except Exception:  # noqa: BLE001 — il conto è chiuso, il link è un di più
        logger.warning(
            "Link caparra non chiuso dopo il checkout (appuntamento %s)",
            appointment.id,
            exc_info=True,
        )


def _emit_visit_completed(salon, appointment, sale) -> None:
    """`visit.completed`: la visita incassata, con i servizi fatti e il totale."""
    client = appointment.client
    service_names = [
        line.service.name_it
        for line in sale.lines.select_related("service")
        if line.service_id
    ]
    from apps.agenda.services import appointment_event_key  # lazy

    # Con la chiave dell'appuntamento: la richiesta di recensione non parte
    # prima di un suo messaggio ancora trattenuto (ordinati, non fusi).
    emit_event(
        salon,
        "visit.completed",
        {
            "appointment_id": appointment.id,
            "sale_id": sale.id,
            "client_id": client.id,
            "client_name": client.full_name,
            "phone": client.phone,
            "lang": client.lang,
            "services": service_names,
            "total": str(sale.total),
        },
        coalesce_key=appointment_event_key(appointment.id),
    )
