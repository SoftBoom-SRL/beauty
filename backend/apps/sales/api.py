"""Endpoint vendite: checkout appuntamenti, POS, storico con KPI, Stripe.

Qui c'è solo il lato HTTP: permessi, appartenenza al salone, forma della
risposta. Il checkout sta in checkout.py, la cassa delle caparre in
deposits.py, il webhook Stripe in stripe_webhooks.py, riepilogo e storico in
reports.py, la forma delle vendite in serializers.py; services.py scrive le
vendite e stripe_service.py parla con Stripe.
"""

from typing import Optional

from ninja import Query, Router
from ninja.errors import HttpError

from django.conf import settings as django_settings

from common.auth import client_auth, staff_auth
from common.permissions import require_owner, require_scope
from common.schemas import OkOut
from common.utils import salon_get

from apps.agenda.models import Appointment
from apps.agenda.schemas import AppointmentOut
from apps.clients.models import Client
from apps.core.services import log_activity

from . import reports, serializers, stripe_service, stripe_webhooks
from .checkout import checkout_appointment, other_visits_to_cash
from .dues import client_amount_due, open_dues
from .models import Sale
from .schemas import (
    ChargeNoShowOut,
    CheckoutIn,
    CheckoutOut,
    ClientDuesOut,
    DepositLinkOut,
    PosIn,
    SaleDetailOut,
    SaleListOut,
    SettleIn,
    SetupIntentOut,
    StripeConnectCallbackIn,
    StripeConnectStartOut,
    StripeConnectStatusOut,
    TodaySummaryOut,
)
from .services import finalize_sale, record_no_show_charge, settle_sale

router = Router(tags=["sales"])

# ---- Checkout e POS ----------------------------------------------------------


@router.post("/checkout/{int:appointment_id}", auth=staff_auth, response=CheckoutOut)
def checkout(request, appointment_id: int, data: CheckoutIn):
    """Chiude il conto di una visita (e, con `extra_appointment_ids`, di altre visite
    della stessa cliente nello stesso giorno: conto unico). Con `leave_due` la
    cliente può pagare meno del dovuto e il resto resta da saldare."""
    ctx = request.auth
    require_scope(ctx, "sales")
    salon_get(Appointment, ctx, appointment_id)  # 404 fuori dal salone
    payload = data.dict()
    sale = checkout_appointment(ctx.salon, appointment_id, payload, actor=ctx.user)
    return {"sale": serializers.sale_detail(sale), "breakdown": serializers.operator_breakdown(sale)}


@router.get("/checkout/{int:appointment_id}/other-visits", auth=staff_auth, response=list[AppointmentOut])
def checkout_other_visits(request, appointment_id: int):
    """Le altre visite aperte della stessa cliente nello stesso giorno, ancora da incassare:
    si possono chiudere nello stesso conto (`extra_appointment_ids` del checkout)."""
    from apps.agenda.presenters import _appointment_out, gift_index  # lazy: forma della visita dell'agenda

    ctx = request.auth
    require_scope(ctx, "sales")
    appointment = salon_get(Appointment, ctx, appointment_id)
    visits = list(other_visits_to_cash(ctx.salon, appointment))
    gifts = gift_index(ctx.salon, [appointment.client_id])
    return [_appointment_out(visit, gifts, viewer=ctx) for visit in visits]


@router.post("/pos", auth=staff_auth, response=SaleDetailOut)
def pos_sale(request, data: PosIn):
    ctx = request.auth
    require_scope(ctx, "sales")
    client = None
    if data.client_id:
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
        allow_due=payload["leave_due"],
    )
    return serializers.sale_detail(sale)


# ---- Conti da saldare --------------------------------------------------------


@router.post("/{int:sale_id}/settle", auth=staff_auth, response=SaleDetailOut)
def settle(request, sale_id: int, data: SettleIn):
    """Paga (tutto o in parte) quanto resta da saldare di una vendita: i pagamenti
    hanno la data di adesso, ed è oggi che la cassa li conta."""
    ctx = request.auth
    require_scope(ctx, "sales")
    salon_get(Sale, ctx, sale_id)  # 404 fuori dal salone
    sale = settle_sale(ctx.salon, sale_id, data.dict()["payments"], actor=ctx.user)
    return serializers.sale_detail(sale)


@router.get("/dues", auth=staff_auth, response=ClientDuesOut)
def client_dues(request, client_id: int):
    """I conti della cliente ancora da saldare, dal più vecchio, e il loro totale."""
    ctx = request.auth
    require_scope(ctx, "sales")
    client = salon_get(Client, ctx, client_id)
    sales = list(open_dues(client).select_related("client"))
    return {
        "client_id": client.id,
        "amount_due": client_amount_due(client),
        "sales": [serializers.sale_out(sale) for sale in sales],
    }


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
    due: bool = False,
):
    """Storico vendite con KPI {revenue, count, items_count, due_total} sul filtro corrente.
    `due=1`: solo i conti con qualcosa ancora da saldare."""
    ctx = request.auth
    require_scope(ctx, "sales")
    return reports.sales_history(
        ctx.salon,
        kind=kind,
        date_from=date_from,
        date_to=date_to,
        q=q,
        client_id=client_id,
        operator_id=operator_id,
        limit=limit,
        offset=offset,
        due=due,
    )


@router.get("/today-summary", auth=staff_auth, response=TodaySummaryOut)
def get_today_summary(request):
    # Senza `require_scope`: è il riquadro incassi dell'agenda, che ogni
    # operatrice vede aprendo la sua giornata. Sono totali di giornata, non lo
    # scontrino di una cliente: il dettaglio, quello sì, chiede il permesso.
    return reports.today_summary(request.auth.salon)


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
    appointment = salon_get(Appointment, ctx, appointment_id)
    # L'importo torna dal servizio: è quello davvero chiesto a Stripe. Prima si
    # ricalcolava qui il totale della visita, e con una caparra trattenuta la
    # carta veniva addebitata di 70 mentre risposta e registro dicevano 100.
    intent, amount = stripe_service.charge_full_amount(appointment)
    intent_id = intent.get("id") or ""
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
    # La carta si salva sull'account del salone: senza, finirebbe su quello
    # della piattaforma e un eventuale addebito no-show incasserebbe lei.
    if not stripe_service.payments_enabled(request.auth.salon):
        raise HttpError(503, "Il salone non accetta ancora pagamenti online")
    intent = stripe_service.create_setup_intent(request.auth.client)
    return {"setup_intent_id": intent.get("id") or "", "client_secret": intent.get("client_secret")}


# ---- Link caparra ------------------------------------------------------------


@router.post("/appointments/{int:appointment_id}/deposit-link", auth=staff_auth, response=DepositLinkOut)
def deposit_link(request, appointment_id: int, resend: bool = True):
    """Crea (o rimanda) il link di pagamento della caparra alla cliente."""
    ctx = request.auth
    require_scope(ctx, "sales")
    appointment = salon_get(Appointment, ctx, appointment_id)
    if appointment.deposit_status != "required":
        raise HttpError(400, "La caparra di questo appuntamento non è in attesa di pagamento")
    if appointment.status not in stripe_service.OPEN_APPOINTMENT_STATUSES:
        raise HttpError(400, "L'appuntamento non è più in agenda: nessun link da mandare")
    if not stripe_service.payments_enabled(ctx.salon):
        raise HttpError(503, stripe_service.NOT_CONNECTED_MSG)
    stripe_service.ensure_deposit_link(appointment, resend=resend, actor=ctx.user)
    return serializers.deposit_link_out(appointment)


@router.post("/client/appointments/{int:appointment_id}/deposit-link", auth=client_auth, response=DepositLinkOut)
def client_deposit_link(request, appointment_id: int):
    """La cliente chiede il link per pagare la caparra del proprio appuntamento."""
    ctx = request.auth
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
    suspended = stripe_service.connect_disconnect(ctx.salon)
    log_activity(
        ctx.salon,
        "settings.stripe_disconnected",
        "Account Stripe scollegato"
        + (f": {suspended} caparre in attesa senza più scadenza, da incassare al banco" if suspended else ""),
        actor=ctx.user,
        payload={"source": "dashboard", "deposits_suspended": suspended},
    )
    ctx.salon.refresh_from_db()
    return _connect_status(ctx.salon)


@router.post("/stripe/webhook", response=OkOut)
def stripe_webhook(request):
    event = stripe_service.verify_webhook(
        request.body, request.META.get("HTTP_STRIPE_SIGNATURE", "")
    )
    stripe_webhooks.handle_event(event)
    return {"ok": True}
