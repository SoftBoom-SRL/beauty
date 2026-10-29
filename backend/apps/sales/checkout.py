"""Chiusura del conto di un appuntamento: la vendita, la visita chiusa, la caparra detratta o restituita.

L'endpoint (`api.checkout`) controlla il permesso e che l'appuntamento sia del
salone; il resto stava tutto dentro la vista. Nella transazione: lock del
salone e poi della riga, rilettura, vendita (`services.finalize_sale`), stato
«chiuso» e registro attività. Fuori, perché parlano con Stripe o con
l'esterno: il link della caparra chiuso, l'eccedenza restituita e l'evento
`visit.completed`.

Conto unico: mani e piedi in contemporanea con due operatrici sono due
appuntamenti, ma la cliente paga una volta. Il checkout di una visita può
chiudere anche altre visite della stessa cliente nello stesso giorno
(`extra_appointment_ids`): la vendita è una, agganciata alla visita principale
(`Sale.appointment`), e le altre la puntano con `Appointment.paid_in_sale`.
"""

import logging
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.agenda.models import Appointment
from apps.core.services import emit_event, log_activity

from . import stripe_service
from .deposits import settle_deposit_excess
from .models import Sale
from .reports import day_bounds
from .services import finalize_sale

logger = logging.getLogger("youty.stripe")

# Visite che non sono state erogate: non si incassano, né da sole né in un conto unico.
_NOT_CASHABLE = (Appointment.Status.CANCELLED, Appointment.Status.NO_SHOW)


def checkout_appointment(salon, appointment_id: int, payload: dict, *, actor=None) -> Sale:
    """Incassa l'appuntamento `appointment_id` del salone e ritorna la vendita creata.

    `payload` è il corpo del checkout (`CheckoutIn`): blocchi di righe,
    pagamenti e buono sconto, come li vuole `finalize_sale`; `leave_due` per
    lasciare da saldare una parte del conto; `extra_appointment_ids` per
    chiudere nello stesso conto altre visite della cliente (le loro righe
    arrivano nei blocchi, ognuna con la sua operatrice). 404 se un
    appuntamento non c'è più; 400 se è annullato, no-show o già incassato.
    """
    from apps.agenda.services.locking import lock_salon  # lazy

    extra_ids = _extra_ids(appointment_id, payload.get("extra_appointment_ids") or [])
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
        if appointment.status in _NOT_CASHABLE:
            raise HttpError(
                400,
                "Appuntamento annullato o segnato come no-show: non può essere incassato",
            )
        # Già incassato: la sua vendita, oppure quella di un'altra visita della
        # cliente che l'ha chiusa nel conto unico (`paid_in_sale`). Senza il
        # secondo controllo i «piedi» chiusi nel conto delle «mani» si potevano
        # incassare una seconda volta.
        if appointment.paid_in_sale_id is not None:
            raise HttpError(400, "Visita già incassata nel conto di un'altra visita della cliente")
        if Sale.objects.filter(appointment=appointment).exists():
            raise HttpError(400, "Appuntamento già incassato")
        extras = _lock_extra_visits(salon, appointment, extra_ids)
        visits = [appointment, *extras]

        # Non `deposit_amount`: quello che si detrae è la quota ancora del
        # salone, al netto dei rimborsi già fatti su quella caparra e di quelli
        # ancora in volo (`deposits.deposit_retained`, 02-21, 05-14). Con il
        # conto unico si detraggono le caparre di tutte le visite del conto.
        credits = {visit.id: visit.deposit_credit for visit in visits}
        deposit_credit = sum(credits.values(), Decimal("0.00"))
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
                allow_due=bool(payload.get("leave_due")),
                receipt_issued=payload.get("receipt_issued", True),
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
        for extra in extras:
            # Le altre visite del conto: chiuse anche loro, ognuna col suo
            # evento per l'agenda, e legate alla vendita che le ha incassate.
            extra.status = "closed"
            extra.paid_in_sale = sale
            extra.save(update_fields=["status", "paid_in_sale", "updated_at"])
            log_activity(
                salon,
                "appointment.closed",
                f"Visita di {appointment.client.full_name} chiusa in cassa nel conto unico",
                actor=actor,
                payload={"appointment_id": extra.id, "status": "closed", "paid_in_sale_id": sale.id},
            )

    # Da qui in poi si parla con Stripe: fuori dalla transazione, perché una
    # rete lenta non deve tenere il lock sull'appuntamento.
    for visit in visits:
        _close_deposit_link(visit)
    # Caparre più alte del conto: `finalize_sale` ha detratto solo fino al
    # totale, la differenza va restituita (prima il conto era impossibile).
    for visit, share in _excess_shares(visits, credits, deposit_credit - sale.deposit_deducted):
        settle_deposit_excess(visit, share, actor=actor)
    _emit_visit_completed(salon, appointment, sale)
    return sale


def _extra_ids(appointment_id: int, raw) -> list[int]:
    """Le visite in più del conto unico, senza doppioni, nell'ordine in cui arrivano."""
    ids = list(dict.fromkeys(int(pk) for pk in raw))
    if appointment_id in ids:
        raise HttpError(400, "La visita principale è già nel conto: non va ripetuta fra le altre")
    return ids


def _lock_extra_visits(salon, appointment, ids: list[int]) -> list:
    """Blocca e rilegge le altre visite del conto unico; 4xx se una non si può unire.

    Sotto gli stessi lock della visita principale (salone, poi le righe): un
    annullamento o un altro checkout della stessa visita, partiti insieme,
    aspettano e poi la trovano chiusa. Si uniscono solo visite della stessa
    cliente nello stesso giorno del salone, erogate e non ancora incassate: il
    conto unico serve a mani e piedi fatti insieme, non a incassare la visita
    di un'altra cliente o quella della settimana prossima.
    """
    if not ids:
        return []
    found = {
        row.id: row
        for row in Appointment.objects.select_for_update().filter(salon=salon, pk__in=ids).order_by("pk")
    }
    cashed = set(
        Sale.objects.filter(appointment_id__in=list(found)).values_list("appointment_id", flat=True)
    )
    day = timezone.localdate(appointment.start)
    extras = []
    for pk in ids:
        extra = found.get(pk)
        if extra is None:
            raise HttpError(404, "Una delle visite del conto non è stata trovata")
        if extra.client_id != appointment.client_id:
            raise HttpError(400, "Nel conto unico vanno solo visite della stessa cliente")
        if timezone.localdate(extra.start) != day:
            raise HttpError(400, "Nel conto unico vanno solo visite dello stesso giorno")
        if extra.status in _NOT_CASHABLE:
            raise HttpError(
                400, "Una delle visite è annullata o segnata come no-show: non può essere incassata"
            )
        if extra.paid_in_sale_id is not None or extra.id in cashed:
            raise HttpError(400, "Una delle visite è già stata incassata")
        extras.append(extra)
    extras.sort(key=lambda visit: (visit.start, visit.id))
    return extras


def other_visits_to_cash(salon, appointment):
    """Le visite che si possono aggiungere al conto di `appointment` (sezione «Altre visite oggi»).

    Stessa cliente, stesso giorno del salone, ancora aperte in agenda e senza
    incasso; la cassa le propone con una spunta. Il checkout le ricontrolla
    sotto lock (`_lock_extra_visits`), qui è solo una lettura.
    """
    start, end = day_bounds(timezone.localdate(appointment.start))
    return (
        Appointment.objects.filter(
            salon=salon,
            client_id=appointment.client_id,
            start__gte=start,
            start__lt=end,
            status__in=Appointment.OPEN_STATUSES,
            paid_in_sale__isnull=True,
            sale__isnull=True,
        )
        .exclude(pk=appointment.pk)
        .select_related("client", "operator", "salon")
        .prefetch_related("items__service", "items__operator")
        .order_by("start", "id")
    )


def _excess_shares(visits: list, credits: dict, excess) -> list[tuple]:
    """Come restituire l'eccedenza delle caparre: [(visita, quota)], la principale per prima.

    Con un conto unico le caparre di più visite si sommano e il conto ne
    detrae quanto serve. Quello che avanza torna alla cliente sulle caparre
    da cui è arrivato, e mai più di quanto ciascuna visita aveva versato: il
    rimborso Stripe di una caparra non può superare il suo pagamento, e uno
    da 50 su una caparra da 30 verrebbe rifiutato.
    """
    left = Decimal(str(excess or 0))
    shares = []
    for visit in visits:
        if left <= 0:
            break
        share = min(left, credits.get(visit.id) or Decimal("0.00"))
        if share > 0:
            shares.append((visit, share))
            left -= share
    return shares


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
    """`visit.completed`: la visita incassata, con i servizi fatti e il totale.

    Uno per conto. Con il conto unico parte solo per la visita principale, con
    i servizi di TUTTE le visite incassate (le righe del conto sono di tutte):
    due eventi avrebbero fatto partire due richieste di recensione alla stessa
    cliente per la stessa mattina.
    """
    client = appointment.client
    service_names = [
        line.service.name_it
        for line in sale.lines.select_related("service")
        if line.service_id
    ]
    from apps.agenda.services.messages import appointment_event_key  # lazy

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
            "phone": client.contact_phone,
            "lang": client.lang,
            "services": service_names,
            "total": str(sale.total),
        },
        coalesce_key=appointment_event_key(appointment.id),
    )
