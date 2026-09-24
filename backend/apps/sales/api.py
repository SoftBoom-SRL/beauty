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
from common.schemas import OkOut
from common.utils import salon_get

from apps.core.services import emit_event, log_activity

from . import serializers, stripe_service, stripe_webhooks
from .models import Sale, SaleLine
from .schemas import (
    ChargeNoShowOut,
    CheckoutIn,
    CheckoutOut,
    DepositLinkOut,
    PosIn,
    SaleDetailOut,
    SaleListOut,
    SetupIntentOut,
    StripeConnectCallbackIn,
    StripeConnectStartOut,
    StripeConnectStatusOut,
    TodaySummaryOut,
)
from .deposits import deposit_retained, settle_deposit_excess
from .services import finalize_sale, record_no_show_charge, today_summary

logger = logging.getLogger("youty.stripe")
router = Router(tags=["sales"])

# compat refactoring: rimuovere dopo l'integrazione — lo storico della scheda
# cliente (clients/api.py, `client_history`) importa ancora `_sale_out` da qui.
_sale_out = serializers.sale_out
# compat refactoring: rimuovere dopo l'integrazione — il test dell'ordine dei
# lock (sales/tests/test_locking.py, LockOrderTests, che riscrive il pacchetto
# agenda) importa ancora `_payment_intent_succeeded` da qui.
_payment_intent_succeeded = stripe_webhooks.on_payment_intent_succeeded


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

    from apps.agenda.services import lock_salon  # lazy

    with transaction.atomic():
        # Prima il salone, poi la riga: lo stesso ordine delle mutazioni
        # d'agenda. Senza il lock del salone un annullamento (o un check-in, o
        # un «torna indietro») rileggeva l'appuntamento prima del commit della
        # cassa e poi lo riscriveva: visita «annullata» con la sua vendita, e
        # caparra già detratta rimborsata (05-20). Nell'ordine inverso, su
        # PostgreSQL, cassa e agenda potevano aspettarsi a vicenda (18-08).
        lock_salon(ctx.salon)
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
        # Quanto della caparra è ancora del salone, contando anche i rimborsi
        # in volo: con un rimborso parziale «pending» la quota detraibile è
        # zero, ma il resto va comunque restituito qui sotto (02-21, 05-14).
        deposit_retained_amount = deposit_retained(appointment)
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
        # Un evento che l'agenda riceve: `sale.created` arriva solo a chi ha
        # il permesso vendite, e l'operatrice continuava a vedere la visita
        # «in corso» finché qualcos'altro non le ricaricava la giornata (08-03).
        # Niente importi: l'agenda la vede anche chi non vede la cassa.
        log_activity(
            ctx.salon,
            "appointment.closed",
            f"Visita di {appointment.client.full_name} chiusa in cassa",
            actor=ctx.user,
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
        actor=ctx.user,
    )

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
        coalesce_key=appointment_event_key(appointment.id),
    )
    return {"sale": serializers.sale_detail(sale), "breakdown": serializers.operator_breakdown(sale)}


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
    return serializers.sale_detail(sale)


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
    # Le vendite-caparra sono un anticipo, non un conto: il checkout fattura già
    # il servizio per intero e ne detrae la caparra. Contate qui, «Incasso
    # totale» diceva 130 per un servizio da 100 con 30 di caparra, i conteggi
    # raddoppiavano e la caparra compariva come vendita «Da banco» (05-03,
    # 14-03). Si vedono solo chiedendole: `kind=deposit`.
    if kind == "deposit":
        qs = qs.filter(deposit_appointment__isnull=False)
    else:
        qs = qs.filter(deposit_appointment__isnull=True)
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
        "items": [serializers.sale_out(s) for s in items],
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
    return serializers.sale_detail(sale)


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
    intent_id = stripe_service.as_dict(intent).get("id") or ""
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
            "payment_intent_id": intent_id,
        },
    )
    return {"ok": True, "payment_intent_id": intent_id, "amount": amount}


@router.post("/client/setup-intent", auth=client_auth, response=SetupIntentOut)
def client_setup_intent(request):
    intent = stripe_service.as_dict(stripe_service.create_setup_intent(request.auth.client))
    return {"setup_intent_id": intent.get("id") or "", "client_secret": intent.get("client_secret")}


# ---- Link caparra ------------------------------------------------------------


@router.post("/appointments/{int:appointment_id}/deposit-link", auth=staff_auth, response=DepositLinkOut)
def deposit_link(request, appointment_id: int, resend: bool = True):
    """Crea (o rimanda) il link di pagamento della caparra alla cliente."""
    ctx = request.auth
    require_scope(ctx, "sales")
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = salon_get(Appointment, ctx, appointment_id)
    if appointment.deposit_status != "required":
        raise HttpError(400, "La caparra di questo appuntamento non è in attesa di pagamento")
    if appointment.status not in stripe_service.OPEN_APPOINTMENT_STATUSES:
        raise HttpError(400, "L'appuntamento non è più in agenda: nessun link da mandare")
    if not stripe_service.payments_enabled(ctx.salon):
        raise HttpError(503, "Pagamenti online non configurati: collega Stripe nelle Impostazioni")
    stripe_service.ensure_deposit_link(appointment, resend=resend, actor=ctx.user)
    return serializers.deposit_link_out(appointment)


@router.post("/client/appointments/{int:appointment_id}/deposit-link", auth=client_auth, response=DepositLinkOut)
def client_deposit_link(request, appointment_id: int):
    """La cliente chiede il link per pagare la caparra del proprio appuntamento."""
    ctx = request.auth
    Appointment = django_apps.get_model("agenda", "Appointment")
    appointment = salon_get(Appointment, ctx, appointment_id, client=ctx.client)
    if appointment.deposit_status != "required":
        raise HttpError(400, "Nessuna caparra da pagare per questo appuntamento")
    # Dopo il rilascio per caparra non versata la caparra resta «richiesta» ma
    # l'appuntamento è annullato: un link nuovo porterebbe solo a un rimborso.
    if appointment.status not in stripe_service.OPEN_APPOINTMENT_STATUSES:
        raise HttpError(400, "Questo appuntamento non è più attivo: contatta il salone")
    if not stripe_service.payments_enabled(ctx.salon):
        raise HttpError(503, "Il salone non accetta ancora pagamenti online: paga in sede")
    # Se la sessione salvata è scaduta (Stripe la chiude dopo 24 ore) il link
    # viene rifatto: prima la cliente riceveva per sempre quello morto (05-10).
    stripe_service.ensure_deposit_link(appointment)
    return serializers.deposit_link_out(appointment)


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


@router.post("/stripe/webhook", response=OkOut)
def stripe_webhook(request):
    event = stripe_service.verify_webhook(
        request.body, request.META.get("HTTP_STRIPE_SIGNATURE", "")
    )
    stripe_webhooks.handle_event(event)
    return {"ok": True}
