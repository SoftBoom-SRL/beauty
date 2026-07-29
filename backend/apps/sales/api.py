"""Endpoint vendite: checkout appuntamenti, POS, storico con KPI, Stripe.

I modelli delle altre app (agenda, clients) sono risolti lazy con
django.apps.get_model per evitare dipendenze di import a livello di modulo.
"""

from decimal import Decimal
from typing import Optional

from django.apps import apps as django_apps
from django.db.models import Count, Q, Sum
from django.utils.dateparse import parse_date
from ninja import Router
from ninja.errors import HttpError

from common.auth import client_auth, staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from apps.core.services import emit_event, log_activity

from . import stripe_service
from .models import Sale, SaleLine
from .schemas import (
    ChargeNoShowOut,
    CheckoutIn,
    CheckoutOut,
    CardSetupOut,
    DepositCheckoutOut,
    OkOut,
    RefundIn,
    RefundOut,
    PosIn,
    SaleDetailOut,
    SaleListOut,
    SetupIntentOut,
    TodaySummaryOut,
)
from .services import finalize_sale, today_summary

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


@router.post("/checkout/{int:appointment_id}", auth=staff_auth, response=CheckoutOut)
def checkout(request, appointment_id: int, data: CheckoutIn):
    ctx = request.auth
    require_scope(ctx, "sales")
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = salon_get(Appointment, ctx, appointment_id)
    if Sale.objects.filter(appointment=appointment).exists():
        raise HttpError(400, "Appuntamento già incassato")

    deposit_deducted = (
        appointment.deposit_amount
        if appointment.deposit_status == "paid"
        else Decimal("0.00")
    )
    payload = data.dict()
    sale = finalize_sale(
        ctx.salon,
        kind=Sale.Kind.CHECKOUT,
        blocks=payload["blocks"],
        payments=payload["payments"],
        client=appointment.client,
        appointment=appointment,
        location=appointment.location,
        deposit_deducted=deposit_deducted,
        actor=ctx.user,
    )

    appointment.status = "closed"
    appointment.save()

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
    limit: int = 50,
    offset: int = 0,
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
    items_count = (
        SaleLine.objects.filter(sale__in=base).aggregate(n=Sum("qty"))["n"] or 0
    )
    items = base.select_related("client").order_by("-created_at")[offset : offset + limit]
    return {
        "count": agg["count"] or 0,
        "kpi": {
            "revenue": (agg["revenue"] or Decimal("0.00")).quantize(Decimal("0.01")),
            "count": agg["count"] or 0,
            "items_count": items_count,
        },
        "items": [_sale_out(s) for s in items],
    }


@router.get("/today-summary", auth=staff_auth, response=TodaySummaryOut)
def get_today_summary(request):
    return today_summary(request.auth.salon)


@router.get("/{int:sale_id}", auth=staff_auth, response=SaleDetailOut)
def sale_detail(request, sale_id: int):
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
    # Protezione contro il doppio addebito: due click sul pulsante, o un
    # automatismo che si sovrappone a un'azione manuale, non devono prelevare
    # due volte. Il rimborso resta comunque disponibile.
    already = _last_payment_intent(ctx.salon, appointment_id, types=_PENALTY_LOG_TYPES)
    if already:
        raise HttpError(422, "Questo appuntamento è già stato addebitato")
    # La percentuale trattenuta la decide il salone (default 100%).
    pct = _settings_of(ctx.salon).noshow_charge_pct
    amount = stripe_service.pct_of(appointment.total_price, pct)
    try:
        intent = stripe_service.charge_no_show(appointment, pct=pct)
    except stripe_service.ChargeAuthRequired as exc:
        # PSD2: la banca chiede l'autenticazione della cliente. L'incasso non è
        # riuscito ma non è perso: resta in attesa che la cliente autentichi.
        log_activity(
            ctx.salon,
            "sale.no_show_charge_pending",
            f"Addebito no-show € {amount} da autenticare — {appointment.client.full_name}",
            actor=ctx.user,
            payload={"appointment_id": appointment.id, "amount": str(amount),
                     "payment_intent_id": exc.payment_intent_id},
        )
        return {"ok": False, "payment_intent_id": exc.payment_intent_id,
                "amount": amount, "requires_authentication": True}
    log_activity(
        ctx.salon,
        "sale.no_show_charged",
        f"Addebito no-show € {amount} ({pct}%) — {appointment.client.full_name}",
        actor=ctx.user,
        payload={
            "appointment_id": appointment.id,
            "amount": str(amount),
            "pct": pct,
            "payment_intent_id": intent["id"],
        },
    )
    return {"ok": True, "payment_intent_id": intent["id"], "amount": amount}


#: Voci del registro attività che portano un incasso RIUSCITO da cui si può
#: risalire al PaymentIntent da rimborsare (i "pending" non hanno incassato nulla).
_CHARGED_LOG_TYPES = ("sale.no_show_charged", "sale.late_cancel_charged", "deposit.paid")


#: Solo gli addebiti punitivi (non la caparra): servono a impedire un secondo
#: addebito sullo stesso appuntamento.
_PENALTY_LOG_TYPES = ("sale.no_show_charged", "sale.late_cancel_charged")


def _last_payment_intent(salon, appointment_id: int, types=_CHARGED_LOG_TYPES) -> str:
    """Ultimo incasso riuscito registrato per l'appuntamento."""
    ActivityLog = django_apps.get_model("core", "ActivityLog")
    for row in ActivityLog.objects.filter(
        salon=salon, type__in=types
    ).order_by("-created_at")[:200]:
        payload = row.payload or {}
        if str(payload.get("appointment_id")) == str(appointment_id):
            pi = payload.get("payment_intent_id") or ""
            if pi:
                return pi
    return ""


@router.post(
    "/appointments/{int:appointment_id}/refund",
    auth=staff_auth,
    response=RefundOut,
)
def refund_appointment_charge(request, appointment_id: int, data: RefundIn):
    """Rimborsa un incasso dell'appuntamento (caparra o addebito no-show).

    Esiste perché l'addebito automatico può sbagliare: un check-in dimenticato
    trasforma una cliente presente in un no-show addebitato. Il salone deve
    poter rimediare da qui, senza entrare nel cruscotto Stripe.
    """
    ctx = request.auth
    require_scope(ctx, "sales")
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = salon_get(Appointment, ctx, appointment_id)

    pi = data.payment_intent_id or _last_payment_intent(ctx.salon, appointment_id)
    if not pi:
        raise HttpError(404, "Nessun incasso da rimborsare per questo appuntamento")

    refund = stripe_service.refund_payment(
        ctx.salon, pi, amount=data.amount, reason=data.reason
    )
    amount = Decimal(str(refund.get("amount", 0))) / 100

    # Caparra rimborsata → lo stato torna coerente con quanto incassato.
    if appointment.deposit_status in ("paid", "forfeited"):
        appointment.deposit_status = "refunded"
        appointment.save(update_fields=["deposit_status", "updated_at"])

    log_activity(
        ctx.salon,
        "sale.refunded",
        f"Rimborso € {amount} — {appointment.client.full_name}"
        + (f" ({data.reason})" if data.reason else ""),
        actor=ctx.user,
        payload={
            "appointment_id": appointment.id,
            "amount": str(amount),
            "payment_intent_id": pi,
            "refund_id": refund.get("id"),
            "reason": data.reason,
        },
    )
    return {
        "ok": True,
        "refund_id": refund.get("id") or "",
        "amount": amount,
        "payment_intent_id": pi,
    }


def _settings_of(salon):
    """SalonSettings del salone (contiene la policy pagamenti)."""
    SalonSettings = django_apps.get_model("core", "SalonSettings")
    obj, _ = SalonSettings.objects.get_or_create(salon=salon)
    return obj


@router.post("/client/setup-intent", auth=client_auth, response=SetupIntentOut)
def client_setup_intent(request):
    """SetupIntent grezzo (richiede Stripe.js lato client).

    Nell'app usiamo invece `/client/save-card-checkout`, che fa la stessa cosa
    con la pagina ospitata da Stripe: nessuna libreria da mantenere e ambito PCI
    minimo. Questo endpoint resta per integrazioni che vogliano il client_secret.
    """
    intent = stripe_service.create_setup_intent(request.auth.client)
    return {"setup_intent_id": intent["id"], "client_secret": intent.get("client_secret")}


@router.post("/client/save-card-checkout", auth=client_auth, response=CardSetupOut)
def client_save_card_checkout(request):
    """Salva la carta senza addebitare nulla, via Checkout ospitato da Stripe.

    Serve al no-show quando il salone NON chiede caparre: senza questo, la carta
    si otterrebbe solo pagando una caparra.
    """
    session = stripe_service.create_card_setup_checkout(request.auth.client)
    return {"checkout_url": session.get("url") or "", "session_id": session.get("id") or ""}


@router.post(
    "/client/appointments/{int:appointment_id}/deposit-checkout",
    auth=client_auth,
    response=DepositCheckoutOut,
)
def client_deposit_checkout(request, appointment_id: int):
    """Checkout ospitato per saldare la caparra del proprio appuntamento.

    Lo stesso pagamento salva anche la carta (setup_future_usage), così un
    eventuale addebito no-show non richiede un secondo passaggio della cliente.
    """
    ctx = request.auth
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = (
        Appointment.objects.select_related("salon", "client")
        .filter(pk=appointment_id, salon=ctx.salon, client=ctx.client)
        .first()
    )
    if appointment is None:
        raise HttpError(404, "Appuntamento non trovato")
    if appointment.deposit_status == "paid":
        raise HttpError(422, "Caparra già pagata")
    session = stripe_service.create_deposit_checkout(appointment)
    return {
        "checkout_url": session.get("url") or "",
        "session_id": session.get("id") or "",
        "amount": Decimal(str(appointment.deposit_amount or 0)),
    }


@router.post("/stripe/webhook", response=OkOut)
def stripe_webhook(request):
    event = stripe_service.verify_webhook(
        request.body, request.META.get("HTTP_STRIPE_SIGNATURE", "")
    )
    event_type = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}
    metadata = obj.get("metadata") or {}

    if event_type == "payment_intent.succeeded":
        appointment_id = metadata.get("appointment_id")
        kind = metadata.get("kind") or ""
        # `kind` è indispensabile: un addebito no-show porta lo STESSO
        # appointment_id di una caparra, e senza distinguerli un incasso da
        # no-show verrebbe registrato come "caparra pagata".
        if appointment_id:
            Appointment = django_apps.get_model("agenda", "Appointment")
            appointment = (
                Appointment.objects.select_related("salon", "client")
                .filter(pk=appointment_id)
                .first()
            )
            if appointment and kind == "deposit":
                appointment.deposit_status = "paid"
                appointment.save()
                log_activity(
                    appointment.salon,
                    "deposit.paid",
                    f"Caparra pagata — {appointment.client.full_name}",
                    payload={
                        "appointment_id": appointment.id,
                        "payment_intent_id": obj.get("id"),
                    },
                )
                # Il Checkout della caparra salva anche la carta: registrala per
                # l'eventuale addebito no-show (evita un secondo passaggio).
                pm = obj.get("payment_method") or ""
                if isinstance(pm, dict):
                    pm = pm.get("id") or ""
                client = appointment.client
                if pm and not client.stripe_payment_method_id:
                    client.stripe_payment_method_id = pm
                    client.save(update_fields=["stripe_payment_method_id"])
            elif appointment and kind in ("no_show", "late_cancel"):
                log_activity(
                    appointment.salon,
                    f"sale.{kind}_charge_succeeded",
                    f"Addebito {kind} riuscito — {appointment.client.full_name}",
                    payload={
                        "appointment_id": appointment.id,
                        "payment_intent_id": obj.get("id"),
                        "amount": str(Decimal(str(obj.get("amount", 0))) / 100),
                    },
                )

    elif event_type == "setup_intent.succeeded":
        client_id = metadata.get("client_id")
        payment_method = obj.get("payment_method") or ""
        if isinstance(payment_method, dict):
            payment_method = payment_method.get("id") or ""
        if client_id and payment_method:
            Client = django_apps.get_model("clients", "Client")
            client = Client.objects.select_related("salon").filter(pk=client_id).first()
            if client:
                client.stripe_payment_method_id = payment_method
                client.save(update_fields=["stripe_payment_method_id"])
                log_activity(
                    client.salon,
                    "client.card_saved",
                    f"Carta salvata — {client.full_name}",
                    payload={"client_id": client.id},
                )

    return {"ok": True}
