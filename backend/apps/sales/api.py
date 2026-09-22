"""Endpoint vendite: checkout appuntamenti, POS, storico con KPI, Stripe.

I modelli delle altre app (agenda, clients) sono risolti lazy con
django.apps.get_model per evitare dipendenze di import a livello di modulo.
"""

import logging
from decimal import Decimal
from typing import Optional

from django.apps import apps as django_apps
from django.db import IntegrityError, transaction
from django.db.models import Count, Q, Sum
from django.utils.dateparse import parse_date
from ninja import Query, Router
from ninja.errors import HttpError

from django.conf import settings as django_settings

from common.auth import client_auth, staff_auth
from common.permissions import require_owner, require_scope
from common.utils import salon_get

from apps.core.services import emit_event, log_activity

from . import stripe_service
from .models import Payment, Sale, SaleLine
from .schemas import (
    ChargeNoShowOut,
    CheckoutIn,
    CheckoutOut,
    DepositLinkOut,
    OkOut,
    PosIn,
    SaleDetailOut,
    SaleListOut,
    SetupIntentOut,
    StripeConnectCallbackIn,
    StripeConnectStartOut,
    StripeConnectStatusOut,
    TodaySummaryOut,
)
from .services import (
    finalize_sale,
    record_deposit_cashed,
    record_no_show_charge,
    settle_deposit_excess,
    today_summary,
)

logger = logging.getLogger("youty.stripe")
router = Router(tags=["sales"])


# ---- Serializzazione ---------------------------------------------------------


def _operator_name(operator) -> str:
    if operator is None:
        return ""
    return f"{operator.first_name} {operator.last_name}".strip()


def _line_out(line: SaleLine) -> dict:
    return {
        "id": line.id,
        "line_type": line.line_type,
        "operator_id": line.operator_id,
        "operator_name": _operator_name(line.operator),
        "service_id": line.service_id,
        "product_id": line.product_id,
        "product_name": line.product.name if line.product_id else "",
        "gift_card_code": line.gift_card.code if line.gift_card_id else None,
        "qty": line.qty,
        "unit_price": line.unit_price,
        "discount_pct": line.discount_pct,
        "is_gift": line.is_gift,
        "amount": line.amount,
    }


def _payment_out(payment) -> dict:
    return {
        "id": payment.id,
        "method": payment.method,
        "amount": payment.amount,
        "gift_card_code": payment.gift_card.code if payment.gift_card_id else None,
    }


def _sale_out(sale: Sale) -> dict:
    return {
        "id": sale.id,
        "kind": sale.kind,
        "appointment_id": sale.appointment_id,
        "client_id": sale.client_id,
        "client_name": sale.client.full_name if sale.client_id else "",
        "location_id": sale.location_id,
        "total": sale.total,
        "coupon_discount": sale.coupon_discount,
        "deposit_deducted": sale.deposit_deducted,
        "created_at": sale.created_at,
    }


def _sale_detail(sale: Sale) -> dict:
    return {
        **_sale_out(sale),
        "lines": [_line_out(l) for l in sale.lines.select_related("operator", "gift_card", "product")],
        "payments": [_payment_out(p) for p in sale.payments.select_related("gift_card")],
    }


def _breakdown(sale: Sale) -> list[dict]:
    """Incassato per operatrice (righe senza operatrice raggruppate a parte)."""
    per_operator: dict = {}
    for line in sale.lines.select_related("operator"):
        entry = per_operator.setdefault(
            line.operator_id,
            {
                "operator_id": line.operator_id,
                "operator_name": _operator_name(line.operator) or "Senza operatrice",
                "amount": Decimal("0.00"),
            },
        )
        entry["amount"] += line.amount
    return list(per_operator.values())


# ---- Checkout e POS ----------------------------------------------------------


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


@router.post("/checkout/{int:appointment_id}", auth=staff_auth, response=CheckoutOut)
def checkout(request, appointment_id: int, data: CheckoutIn):
    ctx = request.auth
    require_scope(ctx, "sales")
    Appointment = django_apps.get_model("agenda", "Appointment")
    salon_get(Appointment, ctx, appointment_id)  # 404 fuori dal salone
    payload = data.dict()

    with transaction.atomic():
        # Rilettura sotto lock DENTRO la transazione della vendita: fra l'inizio
        # della richiesta e adesso la cliente può aver pagato il link della
        # caparra. Prima si decideva (e si salvava) sulla copia vecchia, e il
        # save() pieno riportava `deposit_status` a «richiesta» azzerando il
        # PaymentIntent: 30 € incassati su Stripe, non detratti e non più
        # rimborsabili.
        appointment = (
            Appointment.objects.select_for_update()
            .filter(pk=appointment_id, salon=ctx.salon)
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
        try:
            sale = finalize_sale(
                ctx.salon,
                kind=Sale.Kind.CHECKOUT,
                blocks=payload["blocks"],
                payments=payload["payments"],
                client=appointment.client,
                appointment=appointment,
                location=appointment.location,
                deposit_deducted=deposit_credit,
                coupon_code=payload["coupon_code"],
                actor=ctx.user,
            )
        except IntegrityError:
            # Due checkout partiti insieme: il controllo qui sopra li lascia passare
            # entrambi, il vincolo di unicità ne ferma uno. Senza questo ramo la
            # cassiera vede un errore 500 invece del messaggio giusto.
            raise HttpError(400, "Appuntamento già incassato")

        # Solo lo stato: ogni altra colonna resta quella scritta nel frattempo.
        appointment.status = "closed"
        appointment.save(update_fields=["status", "updated_at"])

    # Da qui in poi si parla con Stripe: fuori dalla transazione, perché una
    # rete lenta non deve tenere il lock sull'appuntamento.
    _close_deposit_link(appointment)
    # Caparra più alta del conto: `finalize_sale` ha detratto solo fino al
    # totale, la differenza va restituita (prima il conto era impossibile).
    settle_deposit_excess(appointment, deposit_credit - sale.deposit_deducted, actor=ctx.user)

    client = appointment.client
    service_names = [
        line.service.name_it
        for line in sale.lines.select_related("service")
        if line.service_id
    ]
    emit_event(
        ctx.salon,
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
    )
    return {"sale": _sale_detail(sale), "breakdown": _breakdown(sale)}


@router.post("/pos", auth=staff_auth, response=SaleDetailOut)
def pos_sale(request, data: PosIn):
    ctx = request.auth
    require_scope(ctx, "sales")
    client = None
    if data.client_id:
        Client = django_apps.get_model("clients", "Client")
        client = salon_get(Client, ctx, data.client_id)
    payload = data.dict()
    sale = finalize_sale(
        ctx.salon,
        kind=Sale.Kind.POS,
        blocks=payload["blocks"],
        payments=payload["payments"],
        client=client,
        coupon_code=payload["coupon_code"],
        actor=ctx.user,
    )
    return _sale_detail(sale)


# ---- Storico e riepiloghi ----------------------------------------------------


@router.get("/", auth=staff_auth, response=SaleListOut)
def list_sales(
    request,
    kind: str = "",
    date_from: str = "",
    date_to: str = "",
    q: str = "",
    client_id: Optional[int] = None,
    operator_id: Optional[int] = None,
    # Con limit/offset negativi lo slice del queryset esplodeva in 500: i limiti
    # li mette lo schema, così la risposta è un 422 leggibile.
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Storico vendite con KPI {revenue, count, items_count} sul filtro corrente."""
    ctx = request.auth
    require_scope(ctx, "sales")
    qs = Sale.objects.filter(salon=ctx.salon)
    if kind:
        qs = qs.filter(kind=kind)
    if date_from and (d := parse_date(date_from)):
        qs = qs.filter(created_at__date__gte=d)
    if date_to and (d := parse_date(date_to)):
        qs = qs.filter(created_at__date__lte=d)
    if q:
        qs = qs.filter(
            Q(client__first_name__icontains=q) | Q(client__last_name__icontains=q)
        )
    if client_id:
        qs = qs.filter(client_id=client_id)
    if operator_id:
        qs = qs.filter(lines__operator_id=operator_id)

    base = Sale.objects.filter(pk__in=qs.values("pk"))  # evita duplicati da join
    agg = base.aggregate(revenue=Sum("total"), count=Count("id"))
    lines = SaleLine.objects.filter(sale__in=base)
    revenue = agg["revenue"] or Decimal("0.00")
    if operator_id:
        # Filtrando per operatrice il fatturato è quello delle SUE righe: prima
        # si sommavano le vendite intere, così di una vendita da 100 con 20 di
        # Giulia e 80 di Anna a Giulia ne venivano attribuiti 100.
        lines = lines.filter(operator_id=operator_id)
        revenue = lines.aggregate(t=Sum("amount"))["t"] or Decimal("0.00")
    items_count = lines.aggregate(n=Sum("qty"))["n"] or 0
    items = base.select_related("client").order_by("-created_at")[offset : offset + limit]
    return {
        "count": agg["count"] or 0,
        "kpi": {
            "revenue": revenue.quantize(Decimal("0.01")),
            "count": agg["count"] or 0,
            "items_count": items_count,
        },
        "items": [_sale_out(s) for s in items],
    }


@router.get("/today-summary", auth=staff_auth, response=TodaySummaryOut)
def get_today_summary(request):
    # Senza `require_scope`: è il riquadro incassi dell'agenda, che ogni
    # operatrice vede aprendo la sua giornata. Sono totali di giornata, non lo
    # scontrino di una cliente: il dettaglio, quello sì, chiede il permesso.
    return today_summary(request.auth.salon)


@router.get("/{int:sale_id}", auth=staff_auth, response=SaleDetailOut)
def sale_detail(request, sale_id: int):
    # L'elenco chiede il permesso «vendite» e il dettaglio no: un'operatrice
    # senza quel permesso si leggeva lo scontrino intero conoscendone l'id.
    require_scope(request.auth, "sales")
    sale = salon_get(Sale, request.auth, sale_id)
    return _sale_detail(sale)


# ---- Stripe ------------------------------------------------------------------


@router.post(
    "/appointments/{appointment_id}/charge-no-show",
    auth=staff_auth,
    response=ChargeNoShowOut,
)
def charge_no_show(request, appointment_id: int):
    ctx = request.auth
    require_scope(ctx, "sales")
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = salon_get(Appointment, ctx, appointment_id)
    # L'importo torna dal servizio: è quello davvero chiesto a Stripe. Prima si
    # ricalcolava qui il totale della visita, e con una caparra trattenuta la
    # carta veniva addebitata di 70 mentre risposta e registro dicevano 100.
    intent, amount = stripe_service.charge_full_amount(appointment)
    # L'addebito è denaro davvero incassato: senza la vendita corrispondente un
    # no-show da 80 € lasciava a zero il riepilogo di giornata e tutti i KPI.
    record_no_show_charge(ctx.salon, appointment, amount=amount, actor=ctx.user)
    log_activity(
        ctx.salon,
        "sale.no_show_charged",
        f"Addebito no-show € {amount} — {appointment.client.full_name}",
        actor=ctx.user,
        payload={
            "appointment_id": appointment.id,
            "amount": str(amount),
            "payment_intent_id": intent["id"],
        },
    )
    return {"ok": True, "payment_intent_id": intent["id"], "amount": amount}


@router.post("/client/setup-intent", auth=client_auth, response=SetupIntentOut)
def client_setup_intent(request):
    intent = stripe_service.create_setup_intent(request.auth.client)
    return {"setup_intent_id": intent["id"], "client_secret": intent.get("client_secret")}


# ---- Link caparra ------------------------------------------------------------


def _deposit_link_out(appointment) -> dict:
    return {
        "url": appointment.deposit_payment_link,
        "amount": appointment.deposit_amount,
        "due_at": appointment.deposit_due_at,
    }


@router.post("/appointments/{int:appointment_id}/deposit-link", auth=staff_auth, response=DepositLinkOut)
def deposit_link(request, appointment_id: int, resend: bool = True):
    """Crea (o rimanda) il link di pagamento della caparra alla cliente."""
    ctx = request.auth
    require_scope(ctx, "sales")
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = salon_get(Appointment, ctx, appointment_id)
    if appointment.deposit_status != "required":
        raise HttpError(400, "La caparra di questo appuntamento non è in attesa di pagamento")
    if not stripe_service.payments_enabled(ctx.salon):
        raise HttpError(503, "Pagamenti online non configurati: collega Stripe nelle Impostazioni")
    stripe_service.ensure_deposit_link(appointment, resend=resend, actor=ctx.user)
    return _deposit_link_out(appointment)


@router.post("/client/appointments/{int:appointment_id}/deposit-link", auth=client_auth, response=DepositLinkOut)
def client_deposit_link(request, appointment_id: int):
    """La cliente chiede il link per pagare la caparra del proprio appuntamento."""
    ctx = request.auth
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = salon_get(Appointment, ctx, appointment_id, client=ctx.client)
    if appointment.deposit_status != "required":
        raise HttpError(400, "Nessuna caparra da pagare per questo appuntamento")
    if not stripe_service.payments_enabled(ctx.salon):
        raise HttpError(503, "Il salone non accetta ancora pagamenti online: paga in sede")
    stripe_service.ensure_deposit_link(appointment)
    return _deposit_link_out(appointment)


# ---- Stripe Connect (titolare) -----------------------------------------------


def _connect_status(salon) -> dict:
    salon_settings = getattr(salon, "settings", None)
    return {
        "available": stripe_service.connect_available(),
        "payments_enabled": stripe_service.payments_enabled(salon),
        "connected": bool(getattr(salon_settings, "stripe_account_id", "")),
        "account_id": getattr(salon_settings, "stripe_account_id", "") or "",
        "connected_at": getattr(salon_settings, "stripe_connected_at", None),
    }


@router.get("/stripe/connect/status", auth=staff_auth, response=StripeConnectStatusOut)
def stripe_connect_status(request):
    return _connect_status(request.auth.salon)


@router.post("/stripe/connect/start", auth=staff_auth, response=StripeConnectStartOut)
def stripe_connect_start(request):
    """URL a cui mandare il titolare per collegare il suo account Stripe (popup)."""
    ctx = request.auth
    require_owner(ctx)
    redirect_uri = f"{django_settings.FRONTEND_ORIGIN.rstrip('/')}/stripe-connect/done"
    return {"url": stripe_service.connect_authorize_url(ctx.salon, redirect_uri)}


@router.post("/stripe/connect/callback", auth=staff_auth, response=StripeConnectStatusOut)
def stripe_connect_callback(request, data: StripeConnectCallbackIn):
    ctx = request.auth
    require_owner(ctx)
    account_id = stripe_service.connect_exchange(ctx.salon, data.code, data.state)
    log_activity(ctx.salon, "settings.stripe_connected", "Account Stripe collegato", actor=ctx.user, payload={"account_id": account_id})
    ctx.salon.refresh_from_db()
    return _connect_status(ctx.salon)


@router.delete("/stripe/connect", auth=staff_auth, response=StripeConnectStatusOut)
def stripe_connect_disconnect(request):
    ctx = request.auth
    require_owner(ctx)
    stripe_service.connect_disconnect(ctx.salon)
    log_activity(ctx.salon, "settings.stripe_disconnected", "Account Stripe scollegato", actor=ctx.user)
    ctx.salon.refresh_from_db()
    return _connect_status(ctx.salon)


def _account_recognised(appointment, account: str, metadata: dict) -> bool:
    """L'evento arriva da un account Stripe che abbiamo usato noi per questo salone?

    Serve a tenere fuori gli eventi di un salone collegato che dichiari nei
    metadata l'id di un appuntamento altrui. Non basta però confrontare con
    l'account ATTUALE: il PaymentIntent è nato sull'account di ALLORA, e
    collegare o scollegare Stripe faceva scartare i pagamenti dei link già in
    volo (`deposit.payment_ignored`), con lo slot liberato e i soldi fermi sulla
    piattaforma. Per questo si accetta anche l'account firmato nei metadata al
    momento della creazione (`acct`, vedi stripe_service.account_token): la
    firma è nostra, quindi nessuno può dichiararne uno a piacere.
    """
    expected = stripe_service.salon_account_id(appointment.salon)
    if (account or "") == (expected or ""):
        return True
    if stripe_service.account_token_matches(appointment.salon, metadata.get("acct") or "", account):
        return True
    log_activity(
        appointment.salon,
        "deposit.payment_ignored",
        f"Evento Stripe da un account non riconosciuto — {appointment.client.full_name}",
        payload={"appointment_id": appointment.id, "account": account or "", "expected": expected or ""},
    )
    return False


def _payment_intent_succeeded(obj: dict, metadata: dict, account: str = "") -> None:
    """payment_intent.succeeded: solo un intent di tipo `deposit` paga la caparra.

    Gli intent sono creati da noi con `metadata.kind` (deposit | no_show): un
    addebito no-show non deve far comparire la caparra come versata. La
    transizione avviene solo da «richiesta», una volta sola (Stripe può
    reinviare lo stesso evento) e solo se l'importo copre la caparra attesa.

    L'appuntamento viene cercato DENTRO il salone dichiarato nei metadata, e
    l'account Connect che ha generato l'evento deve essere uno di quelli usati
    da noi per quel salone (vedi `_account_recognised`): senza questi due
    controlli un salone collegato poteva creare sul proprio account un intent
    con l'id di un appuntamento altrui e farne risultare pagata la caparra.
    """
    appointment_id = metadata.get("appointment_id")
    salon_id = metadata.get("salon_id")
    if not appointment_id:
        return
    Appointment = django_apps.get_model("agenda", "Appointment")
    qs = Appointment.objects.select_related("salon", "salon__settings", "client")
    if salon_id:
        qs = qs.filter(salon_id=salon_id)
    appointment = qs.filter(pk=appointment_id).first()
    if appointment is None:
        return
    if not _account_recognised(appointment, account, metadata):
        return
    intent_id = obj.get("id") or ""
    kind = metadata.get("kind") or "deposit"
    client_name = appointment.client.full_name

    if kind == "no_show":
        if not appointment.no_show_payment_intent_id and intent_id:
            appointment.no_show_payment_intent_id = intent_id
            appointment.save(update_fields=["no_show_payment_intent_id", "updated_at"])
        log_activity(
            appointment.salon,
            "sale.no_show_paid",
            f"Addebito no-show incassato — {client_name}",
            payload={"appointment_id": appointment.id, "payment_intent_id": intent_id},
        )
        return
    if kind != "deposit":
        return

    outcome = _apply_deposit_payment(appointment, intent_id, obj)

    # Le chiamate a Stripe e gli eventi stanno FUORI dal lock: una rete lenta
    # non deve tenere bloccato l'appuntamento (e quindi l'agenda).
    if outcome == "duplicate":
        _refund_duplicate_deposit(appointment, intent_id, obj)
    elif outcome == "refund_due":
        from apps.agenda.services import settle_deposit_refund  # lazy

        emit_event(
            appointment.salon,
            "deposit.paid_after_release",
            {
                "appointment_id": appointment.id,
                "client_id": appointment.client_id,
                "client_name": client_name,
                "phone": appointment.client.phone,
                "lang": appointment.client.lang,
                "amount": str(appointment.deposit_amount),
            },
        )
        settle_deposit_refund(appointment)
    elif outcome == "paid":
        emit_event(
            appointment.salon,
            "deposit.paid",
            {
                "appointment_id": appointment.id,
                "client_id": appointment.client_id,
                "client_name": client_name,
                "phone": appointment.client.phone,
                "lang": appointment.client.lang,
                "amount": str(appointment.deposit_amount),
                "start": appointment.start.isoformat(),
            },
        )


def _apply_deposit_payment(appointment, intent_id: str, obj: dict) -> str:
    """Applica il pagamento della caparra sotto lock; dice cosa è successo.

    L'appuntamento viene RILETTO dentro la transazione: due consegne dello
    stesso evento (Stripe le ripete) leggevano entrambe «richiesta» fuori da
    ogni lock e scrivevano entrambe «pagata», e il secondo incasso restava in
    cassa senza che nulla lo segnalasse. Qui si fanno solo scritture locali:
    rimborsi ed eventi li fa il chiamante, a lock rilasciato.
    """
    Appointment = django_apps.get_model("agenda", "Appointment")
    with transaction.atomic():
        # La riga viene bloccata qui: una seconda consegna dello stesso evento
        # aspetta, e quando entra rilegge lo stato già aggiornato.
        if Appointment.objects.select_for_update().filter(pk=appointment.pk).first() is None:
            return "gone"
        appointment.refresh_from_db()
        client_name = appointment.client.full_name
        fields = ["deposit_status", "deposit_payment_intent_id", "deposit_due_at", "updated_at"]

        if appointment.deposit_status in ("paid", "refunding", "refunded", "forfeited"):
            if intent_id and intent_id != appointment.deposit_payment_intent_id:
                return "duplicate"
            return "known"  # già elaborato: nulla da fare
        # Conto già chiuso o appuntamento non più in piedi: il denaro è arrivato
        # ma non copre più niente. Sul conto chiuso la caparra non è stata
        # detratta (era ancora «richiesta»), quindi il salone incasserebbe due
        # volte lo stesso servizio. Si segna «da rimborsare» e si restituisce.
        already_cashed = Sale.objects.filter(appointment=appointment).exists()
        if appointment.status in ("cancelled", "no_show", "closed") or already_cashed:
            appointment.deposit_status = "refund_due"
            appointment.deposit_payment_intent_id = intent_id
            appointment.deposit_due_at = None
            appointment.save(update_fields=fields)
            log_activity(
                appointment.salon,
                "deposit.paid_after_release",
                (
                    "Caparra pagata a conto già chiuso, da restituire"
                    if appointment.status == "closed" or already_cashed
                    else "Caparra pagata dopo l'annullamento, da restituire"
                )
                + f" — {client_name}",
                payload={
                    "appointment_id": appointment.id,
                    "payment_intent_id": intent_id,
                    "amount": str(appointment.deposit_amount),
                },
            )
            return "refund_due"
        if appointment.deposit_status != "required":
            log_activity(
                appointment.salon,
                "deposit.payment_ignored",
                f"Pagamento caparra ricevuto ma non atteso ({appointment.deposit_status}) — {client_name}",
                payload={"appointment_id": appointment.id, "payment_intent_id": intent_id},
            )
            return "ignored"
        expected = stripe_service._to_cents(appointment.deposit_amount or 0)
        received = obj.get("amount_received", obj.get("amount"))
        if received is not None and int(received) < expected:
            log_activity(
                appointment.salon,
                "deposit.payment_mismatch",
                f"Pagamento caparra insufficiente — {client_name}",
                payload={
                    "appointment_id": appointment.id,
                    "payment_intent_id": intent_id,
                    "expected_cents": expected,
                    "received_cents": int(received),
                },
            )
            return "mismatch"
        appointment.deposit_status = "paid"
        appointment.deposit_payment_intent_id = intent_id
        appointment.deposit_due_at = None  # caparra arrivata: niente più rilascio automatico
        appointment.save(update_fields=fields)
        log_activity(
            appointment.salon,
            "deposit.paid",
            f"Acconto pagato — {client_name}",
            payload={"appointment_id": appointment.id, "payment_intent_id": intent_id},
        )
        # La caparra è incasso del giorno in cui arriva: al checkout verrà
        # detratta da quanto resta da pagare, quindi non si conta due volte.
        record_deposit_cashed(appointment.salon, appointment, method=Payment.Method.CARD)
        return "paid"


def _refund_duplicate_deposit(appointment, intent_id: str, obj: dict) -> None:
    """Seconda caparra incassata sullo stesso appuntamento: si restituisce.

    Succede quando restano aperti due link di pagamento e la cliente li paga
    entrambi. Prima l'evento veniva semplicemente ignorato: il salone teneva il
    doppio senza che nulla lo segnalasse.
    """
    cents = obj.get("amount_received", obj.get("amount")) or 0
    refund = stripe_service.refund_payment_intent(
        appointment.salon,
        intent_id,
        idempotency_key=f"duplicate-deposit-{appointment.salon_id}-{appointment.id}-{intent_id}",
    )
    log_activity(
        appointment.salon,
        "deposit.duplicate_payment",
        f"Seconda caparra incassata sullo stesso appuntamento — {appointment.client.full_name}"
        + ("" if refund is not None else " (rimborso da fare a mano)"),
        payload={
            "appointment_id": appointment.id,
            "payment_intent_id": intent_id,
            "already_paid_intent_id": appointment.deposit_payment_intent_id,
            "amount_cents": int(cents),
            "refund_id": (refund or {}).get("id", ""),
        },
    )


def _refund_facts(event_type: str, obj: dict) -> dict:
    """Estrae dall'evento Stripe (intent, id rimborso, centesimi, stato, soglia)."""
    intent_id = obj.get("payment_intent") or ""
    if isinstance(intent_id, dict):
        intent_id = intent_id.get("id") or ""
    if event_type == "charge.refunded":
        # obj è la Charge: `amount_refunded` è il totale già restituito, conta
        # solo i rimborsi riusciti e non porta l'id del singolo rimborso.
        return {
            "intent_id": intent_id,
            "refund_id": "",
            "cents": 0,
            "status": "",
            "floor_cents": int(obj.get("amount_refunded") or 0),
        }
    # obj è un Refund: `amount` è quel rimborso, `status` dice se è avvenuto.
    return {
        "intent_id": intent_id or obj.get("id") or "",
        "refund_id": obj.get("id") or "",
        "cents": int(obj.get("amount") or 0),
        "status": obj.get("status") or "succeeded",
        "floor_cents": 0,
    }


def _charge_refunded(obj: dict, event_type: str = "charge.refunded") -> None:
    """Rimborso su un PaymentIntent nostro: aggiorna caparra rimborsata e stato.

    Copre anche il rimborso fatto a mano dalla dashboard Stripe, che altrimenti
    resterebbe invisibile al gestionale. Un rimborso parziale riduce solo la
    quota detraibile; uno ancora «pending» non vale come restituito.
    """
    facts = _refund_facts(event_type, obj)
    if not facts["intent_id"]:
        return
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = (
        Appointment.objects.select_related("salon", "client")
        .filter(deposit_payment_intent_id=facts["intent_id"])
        .first()
    )
    if appointment is None or appointment.deposit_status not in (
        "paid", "refund_due", "refunding", "refunded", "forfeited",
    ):
        return
    from apps.agenda.services import record_deposit_refund  # lazy

    record_deposit_refund(
        appointment,
        refund_id=facts["refund_id"],
        cents=facts["cents"],
        status=facts["status"],
        floor_cents=facts["floor_cents"],
    )


@router.post("/stripe/webhook", response=OkOut)
def stripe_webhook(request):
    event = stripe_service.verify_webhook(
        request.body, request.META.get("HTTP_STRIPE_SIGNATURE", "")
    )
    event_type = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}
    metadata = obj.get("metadata") or {}
    # Con Stripe Connect l'evento dichiara l'account collegato che l'ha generato:
    # serve a verificare che riguardi davvero il salone indicato nei metadata.
    account = event.get("account") or ""

    if event_type == "payment_intent.succeeded":
        _payment_intent_succeeded(obj, metadata, account)

    elif event_type == "checkout.session.completed":
        # Link caparra (Checkout): la sessione porta gli stessi metadata; l'intent
        # è in `payment_intent`. Elaborato solo se il pagamento è andato a buon fine.
        if obj.get("payment_status") in (None, "paid"):
            intent = obj.get("payment_intent") or ""
            if isinstance(intent, dict):
                intent = intent.get("id") or ""
            _payment_intent_succeeded(
                {"id": intent, "amount_received": obj.get("amount_total"), "amount": obj.get("amount_total")},
                metadata,
                account,
            )

    elif event_type in (
        "charge.refunded",
        "refund.created",
        "refund.updated",
        "refund.failed",
        "charge.refund.updated",
    ):
        # Rimborso fatto da Stripe (anche a mano dalla dashboard): allineiamo lo
        # stato locale, altrimenti al checkout la caparra verrebbe detratta di
        # nuovo da un anticipo che è già tornato alla cliente. Si ascoltano anche
        # gli aggiornamenti: un rimborso creato «pending» può poi fallire, e
        # senza quel secondo evento resterebbe scritto «rimborsata» per sempre.
        _charge_refunded(obj, event_type)

    elif event_type == "setup_intent.succeeded":
        client_id = metadata.get("client_id")
        payment_method = obj.get("payment_method") or ""
        if isinstance(payment_method, dict):
            payment_method = payment_method.get("id") or ""
        salon_id = metadata.get("salon_id")
        if client_id and payment_method:
            Client = django_apps.get_model("clients", "Client")
            clients = Client.objects.select_related("salon", "salon__settings")
            # Filtro per salone come per i PaymentIntent: l'id nei metadata
            # arriva dall'evento, e senza vincolo un account collegato potrebbe
            # scrivere sulla scheda di un cliente di un altro salone.
            if salon_id:
                clients = clients.filter(salon_id=salon_id)
            client = clients.filter(pk=client_id).first()
            if client and stripe_service.salon_account_id(client.salon) != account:
                logger.warning(
                    "setup_intent.succeeded ignorato: account %r non è quello del salone %s",
                    account, client.salon_id,
                )
                client = None
            if client:
                client.stripe_payment_method_id = payment_method
                # La carta vale solo sull'account su cui è stata salvata.
                client.stripe_account_id = account
                client.save(
                    update_fields=["stripe_payment_method_id", "stripe_account_id"]
                )
                log_activity(
                    client.salon,
                    "client.card_saved",
                    f"Carta salvata — {client.full_name}",
                    payload={"client_id": client.id},
                )

    return {"ok": True}
