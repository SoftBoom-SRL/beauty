import re
from decimal import Decimal
from typing import Optional

from django.apps import apps as django_apps
from django.db import transaction
from django.db.models import Count, DecimalField, F, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError
from ninja.pagination import LimitOffsetPagination, paginate

from apps.core.services import log_activity
from common import ratelimit
from common.auth import client_auth, staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from .models import Communication, Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram
from .schemas import (
    ClientGiftCardIn,
    CommunicationIn,
    CommunicationOut,
    CommunicationSendIn,
    CouponIn,
    CouponOut,
    CouponRedeemIn,
    GiftCardIn,
    GiftCardListOut,
    GiftCardOut,
    LoyaltyAccountOut,
    LoyaltyProgramIn,
    LoyaltyProgramOut,
    MarketingConsentIn,
    MarkPaidIn,
    OkOut,
    WalletOut,
)
from .services import (
    cancel_pending_send,
    create_gift_card,
    send_communication,
    unique_code,
)

router = Router(tags=["marketing"])

_ZERO = Value(Decimal("0"), output_field=DecimalField(max_digits=12, decimal_places=2))


def _get_client(ctx, client_id):
    Client = django_apps.get_model("clients", "Client")  # lazy: evita cicli
    return salon_get(Client, ctx, client_id)


# Tetto compatibile con DecimalField(max_digits=10, decimal_places=2): oltre
# questa cifra il salvataggio esplode in 500 invece di dire cosa non va.
MAX_MONEY = Decimal("99999999.99")


def _validate_coupon_value(kind: str, value: Decimal) -> Decimal:
    """Un buono deve scontare qualcosa, e non più del conto.

    Senza questi controlli passavano un «-20 €» (che aumentava il totale), uno
    «sconto del 500%» mostrato tale e quale nel portafoglio della cliente, e
    valori fuori scala che facevano fallire la scrittura.
    """
    value = Decimal(str(value))
    if value <= 0:
        raise HttpError(422, "Il valore del coupon dev'essere maggiore di zero")
    if kind == Coupon.Kind.PERCENT and value > 100:
        raise HttpError(422, "Uno sconto percentuale non può superare il 100%")
    if value > MAX_MONEY:
        raise HttpError(422, "Valore del coupon fuori scala")
    return value


# ---- Coupon ------------------------------------------------------------------


@router.get("/coupons", auth=staff_auth, response=list[CouponOut])
@paginate(LimitOffsetPagination)
def list_coupons(
    request,
    origin: str = "",
    status: str = "",
    q: str = "",
    client_id: Optional[int] = None,
):
    qs = Coupon.objects.filter(salon=request.auth.salon).select_related("client")
    if origin:
        qs = qs.filter(origin=origin)
    if status:
        qs = qs.filter(status=status)
    if q:
        qs = qs.filter(
            Q(code__icontains=q)
            | Q(client__first_name__icontains=q)
            | Q(client__last_name__icontains=q)
        )
    if client_id:
        qs = qs.filter(client_id=client_id)
    return qs


@router.post("/coupons", auth=staff_auth, response=CouponOut)
def create_coupon(request, data: CouponIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    if data.kind not in Coupon.Kind.values:
        raise HttpError(422, "Tipo coupon non valido")
    value = _validate_coupon_value(data.kind, data.value)
    client = _get_client(ctx, data.client_id) if data.client_id else None
    coupon = Coupon.objects.create(
        salon=ctx.salon,
        client=client,
        code=unique_code(Coupon, ctx.salon, 8),
        kind=data.kind,
        value=value,
        origin=Coupon.Origin.MANUAL,
        expires_at=data.expires_at,
    )
    log_activity(
        ctx.salon,
        "coupon.created",
        f"Coupon {coupon.code} ({coupon.get_kind_display()} {coupon.value})",
        actor=ctx.user,
        payload={"coupon_id": coupon.id, "code": coupon.code},
    )
    return coupon


@router.put("/coupons/{int:coupon_id}", auth=staff_auth, response=CouponOut)
def update_coupon(request, coupon_id: int, data: CouponIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    coupon = salon_get(Coupon, ctx, coupon_id)
    if coupon.status != Coupon.Status.ACTIVE:
        raise HttpError(422, "Solo i coupon attivi sono modificabili")
    if data.kind not in Coupon.Kind.values:
        raise HttpError(422, "Tipo coupon non valido")
    value = _validate_coupon_value(data.kind, data.value)
    coupon.client = _get_client(ctx, data.client_id) if data.client_id else None
    coupon.kind = data.kind
    coupon.value = value
    coupon.expires_at = data.expires_at
    coupon.save()
    log_activity(
        ctx.salon,
        "coupon.updated",
        f"Coupon {coupon.code} aggiornato",
        actor=ctx.user,
        payload={"coupon_id": coupon.id},
    )
    return coupon


@router.delete("/coupons/{int:coupon_id}", auth=staff_auth, response=OkOut)
def delete_coupon(request, coupon_id: int):
    ctx = request.auth
    require_scope(ctx, "marketing")
    coupon = salon_get(Coupon, ctx, coupon_id)
    log_activity(
        ctx.salon,
        "coupon.deleted",
        f"Coupon {coupon.code} eliminato",
        actor=ctx.user,
        payload={"coupon_id": coupon.id, "code": coupon.code},
    )
    coupon.delete()
    return OkOut()


@router.post("/coupons/{int:coupon_id}/redeem", auth=staff_auth, response=CouponOut)
def redeem_coupon(request, coupon_id: int, data: CouponRedeemIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    coupon = salon_get(Coupon, ctx, coupon_id)
    if coupon.status != Coupon.Status.ACTIVE:
        raise HttpError(422, "Coupon non più valido")
    if coupon.expires_at and coupon.expires_at < timezone.now():
        coupon.status = Coupon.Status.EXPIRED
        coupon.save(update_fields=["status"])
        raise HttpError(422, "Coupon scaduto")
    sale = None
    if data.sale_id:
        Sale = django_apps.get_model("sales", "Sale")  # lazy
        sale = salon_get(Sale, ctx, data.sale_id)
    # Il consumo è una sola UPDATE filtrata su status='active': è il database a
    # decidere chi arriva primo. Con il leggi-poi-scrivi di prima, due banchi che
    # battevano lo stesso codice nello stesso istante lo trovavano attivo
    # entrambi e lo scalavano due volte.
    now = timezone.now()
    updated = Coupon.objects.filter(
        pk=coupon.pk, salon=ctx.salon, status=Coupon.Status.ACTIVE
    ).update(status=Coupon.Status.REDEEMED, redeemed_at=now, sale=sale)
    if not updated:
        raise HttpError(422, "Coupon non più valido")
    coupon.refresh_from_db()
    log_activity(
        ctx.salon,
        "coupon.redeemed",
        f"Coupon {coupon.code} utilizzato",
        actor=ctx.user,
        payload={"coupon_id": coupon.id, "sale_id": data.sale_id},
    )
    return coupon


# ---- Gift card ---------------------------------------------------------------


@router.get("/gift-cards", auth=staff_auth, response=GiftCardListOut)
def list_gift_cards(
    request,
    status: str = "",
    payment_status: str = "",
    q: str = "",
    client_id: Optional[int] = None,
    limit: int = 200,
    offset: int = 0,
):
    # select_related anche su gift_service: la riga «carta a trattamento» mostra
    # il nome del servizio, e senza questo ogni carta dell'elenco costava una
    # query in più.
    qs = GiftCard.objects.filter(salon=request.auth.salon).select_related(
        "buyer_client", "gift_service"
    )
    if status:
        qs = qs.filter(status=status)
    if payment_status:
        qs = qs.filter(payment_status=payment_status)
    if q:
        qs = qs.filter(
            Q(code__icontains=q)
            | Q(recipient_name__icontains=q)
            | Q(buyer_client__first_name__icontains=q)
            | Q(buyer_client__last_name__icontains=q)
        )
    if client_id:
        # il cliente può comparire come acquirente e/o destinatario della carta
        qs = qs.filter(Q(buyer_client_id=client_id) | Q(recipient_client_id=client_id))
    # «Venduto» è il denaro davvero incassato: le carte ancora da pagare non
    # sono ricavi, e i premi fedeltà (paid_method="loyalty") non li ha pagati
    # nessuno — contarli gonfiava il KPI di soldi mai entrati in cassa.
    sold = Q(payment_status=GiftCard.PaymentStatus.PAID) & ~Q(paid_method="loyalty")
    # «Da spendere» è il credito che il salone deve ancora onorare: solo carte
    # attive, pagate e non scadute.
    spendable = (
        Q(status=GiftCard.Status.ACTIVE)
        & Q(payment_status=GiftCard.PaymentStatus.PAID)
        & (Q(expires_at__isnull=True) | Q(expires_at__gte=timezone.now()))
    )
    kpi = qs.aggregate(
        sold_total=Coalesce(Sum("initial_value", filter=sold), _ZERO),
        redeemed_total=Coalesce(
            Sum(
                F("initial_value") - F("balance"),
                output_field=DecimalField(max_digits=12, decimal_places=2),
            ),
            _ZERO,
        ),
        outstanding=Coalesce(Sum("balance", filter=spendable), _ZERO),
    )
    # Elenco paginato: i KPI restano calcolati su TUTTE le carte filtrate, ma
    # la risposta non trascina più migliaia di righe in un colpo solo.
    total = qs.count()
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    return {"kpi": kpi, "total": total, "items": list(qs[offset : offset + limit])}


@router.post("/gift-cards", auth=staff_auth, response=GiftCardOut)
def create_gift_card_staff(request, data: GiftCardIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    buyer = _get_client(ctx, data.buyer_client_id) if data.buyer_client_id else None
    # Gift card trattamento: il valore è (autoritativamente) il prezzo del servizio,
    # ignora l'eventuale `value` inviato. gift_service_id None => carta monetaria.
    gift_service = None
    value = data.value
    if data.gift_service_id:
        Service = django_apps.get_model("catalog", "Service")  # lazy
        gift_service = salon_get(Service, ctx, data.gift_service_id)
        value = gift_service.price
    recipient = _get_client(ctx, data.recipient_client_id) if data.recipient_client_id else None
    # Carta e incasso nascono insieme o non nascono: una carta «pagata» senza la
    # sua vendita è esattamente il buco che stiamo chiudendo.
    with transaction.atomic():
        card = create_gift_card(
            ctx.salon,
            value,
            gift_service=gift_service,
            buyer_client=buyer,
            recipient_client=recipient,
            recipient_name=data.recipient_name,
            paid=data.paid,
            paid_method=data.paid_method,
            sold_by=ctx.user,
        )
        extra = []
        if data.delivery_date:
            card.delivery_date = data.delivery_date
            extra.append("delivery_date")
        if data.expires_at:
            card.expires_at = data.expires_at
            extra.append("expires_at")
        if extra:
            card.save(update_fields=extra)
        if data.paid:
            # «Vendo e segno pagata subito» è il caso normale al banco (la
            # maschera manda paid=true di default), ma nasceva una carta
            # payment_status=paid senza nessuna vendita a registro: quei soldi
            # non comparivano nei ricavi né nel riepilogo di giornata, e al
            # riscatto venivano perfino sottratti dall'incasso. La carta faceva
            # SPARIRE il suo valore dai conti invece di aggiungerlo, e non c'era
            # modo di rimediare dopo (mark-paid rispondeva «già pagata»).
            # record_gift_card_cashed si difende da sola dal doppio conteggio.
            from apps.sales.services import record_gift_card_cashed  # lazy

            record_gift_card_cashed(ctx.salon, card, method=data.paid_method, actor=ctx.user)
    return card


@router.post("/gift-cards/{int:card_id}/mark-paid", auth=staff_auth, response=GiftCardOut)
def mark_gift_card_paid(request, card_id: int, data: MarkPaidIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    card = salon_get(GiftCard, ctx, card_id)
    # La marcatura «scaduta» si scrive FUORI dalla transazione dell'incasso: se
    # stesse dentro, il rollback provocato dall'errore se la porterebbe via.
    if card.status == GiftCard.Status.ACTIVE and card.expires_at and card.expires_at < timezone.now():
        card.status = GiftCard.Status.EXPIRED
        card.save(update_fields=["status"])
        raise HttpError(422, "Gift card scaduta: non può essere incassata")
    # Tutto l'incasso sta in una transazione con la riga bloccata: il doppio clic
    # su «Segna come pagata» trovava la carta ancora da pagare in entrambe le
    # richieste e registrava due vendite (e due pagamenti) per gli stessi soldi.
    from apps.sales.services import record_gift_card_cashed  # lazy

    with transaction.atomic():
        card = GiftCard.objects.select_for_update().get(pk=card.pk)
        if card.payment_status == GiftCard.PaymentStatus.PAID:
            raise HttpError(422, "Gift card già pagata")
        # Una carta annullata o scaduta non si incassa: il salone prenderebbe soldi
        # per un credito che non è più spendibile.
        if card.status != GiftCard.Status.ACTIVE:
            raise HttpError(422, "Gift card non attiva: non può essere incassata")
        card.payment_status = GiftCard.PaymentStatus.PAID
        card.paid_at = timezone.now()
        card.paid_method = data.method
        card.save(update_fields=["payment_status", "paid_at", "paid_method"])
        # L'incasso diventa una vendita, altrimenti il denaro non entra nei ricavi
        # e al riscatto viene addirittura sottratto.
        record_gift_card_cashed(ctx.salon, card, method=data.method, actor=ctx.user)
    log_activity(
        ctx.salon,
        "giftcard.paid",
        f"Incasso gift card {card.code}: €{card.initial_value} ({data.method})",
        actor=ctx.user,
        payload={"gift_card_id": card.id, "amount": str(card.initial_value), "method": data.method},
    )
    return card


# ---- Programmi fedeltà -------------------------------------------------------


@router.get("/loyalty-programs", auth=staff_auth, response=list[LoyaltyProgramOut])
def list_loyalty_programs(request, active: bool | None = None):
    # Il conteggio degli iscritti arriva con la stessa query: risolto da
    # LoyaltyProgramOut come attributo annotato, non più con un COUNT per riga.
    qs = LoyaltyProgram.objects.filter(salon=request.auth.salon).annotate(
        accounts_count=Count("accounts")
    )
    if active is not None:
        qs = qs.filter(active=active)
    return qs


# Premi che il gestionale sa davvero emettere e il banco sa riscattare. Il
# «prodotto omaggio» non c'è: non esiste un buono legato a un articolo di
# magazzino, e accettarlo qui significherebbe promettere alla cliente un premio
# che nessuna cassa può onorare.
ISSUABLE_REWARDS = ("coupon_amount", "discount_pct", "free_service", "gift_card")

# Tetto al rapporto di accumulo. Un refuso (1000 invece di 1) su un programma
# «per euro» con soglia bassa emetteva migliaia di premi a ogni scontrino;
# services.MAX_REWARDS_PER_SALE ferma l'emorragia a valle, questo la evita a
# monte. Cento punti per euro è già una scelta esotica, oltre è un errore.
MAX_EARN_RATIO = Decimal("100")
# Un punto che scade fra otto anni non scade: oltre questo non ha senso e il
# campo (PositiveSmallIntegerField) andrebbe comunque in overflow.
MAX_POINTS_EXPIRY_MONTHS = 120
MAX_THRESHOLD = 1_000_000

_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _apply_program_data(program: LoyaltyProgram, ctx, data: LoyaltyProgramIn):
    if data.reward_type not in ISSUABLE_REWARDS:
        raise HttpError(422, "Tipo di premio non gestito: scegli buono, sconto, servizio omaggio o gift card")
    if data.reward_type == "free_service" and not data.reward_service_id:
        raise HttpError(422, "Scegli il servizio da regalare")
    if data.reward_type != "free_service" and Decimal(str(data.reward_value or 0)) <= 0:
        raise HttpError(422, "Indica il valore del premio")
    # Gli altri enum arrivavano scritti a database tali e quali: un "per_euro "
    # con lo spazio finiva nel ramo «per servizio» senza dire niente, e un
    # enrollment sbagliato spegneva in silenzio ogni iscrizione automatica —
    # punti fermi a zero e nessun errore da nessuna parte.
    if data.type not in LoyaltyProgram.Type.values:
        raise HttpError(422, "Tipo di programma non valido")
    if data.earn_metric not in LoyaltyProgram.EarnMetric.values:
        raise HttpError(422, "Modalità di accumulo non valida")
    if data.enrollment not in LoyaltyProgram.Enrollment.values:
        raise HttpError(422, "Modalità di iscrizione non valida")
    # threshold=0 faceva accumulare punti che non diventavano mai un premio.
    if not 1 <= data.threshold <= MAX_THRESHOLD:
        raise HttpError(422, "La soglia dev'essere un numero di punti fra 1 e 1.000.000")
    earn_ratio = Decimal(str(data.earn_ratio))
    if not Decimal("0") < earn_ratio <= MAX_EARN_RATIO:
        raise HttpError(422, f"Punti per unità fuori scala (massimo {MAX_EARN_RATIO})")
    if Decimal(str(data.reward_value or 0)) > MAX_MONEY:
        raise HttpError(422, "Valore del premio fuori scala")
    if data.reward_type == "discount_pct" and Decimal(str(data.reward_value or 0)) > 100:
        raise HttpError(422, "Uno sconto percentuale non può superare il 100%")
    if not 0 <= data.points_expiry_months <= MAX_POINTS_EXPIRY_MONTHS:
        raise HttpError(422, "Scadenza punti non valida (0 = mai, massimo 120 mesi)")
    if not _HEX_COLOR.match(data.color or ""):
        raise HttpError(422, "Colore non valido: usa il formato #RRGGBB")
    if data.reward_service_id:
        Service = django_apps.get_model("catalog", "Service")  # lazy
        program.reward_service = salon_get(Service, ctx, data.reward_service_id)
    else:
        program.reward_service = None
    for name, value in data.dict(exclude={"reward_service_id"}).items():
        setattr(program, name, value)
    program.save()
    return program


@router.post("/loyalty-programs", auth=staff_auth, response=LoyaltyProgramOut)
def create_loyalty_program(request, data: LoyaltyProgramIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    program = _apply_program_data(LoyaltyProgram(salon=ctx.salon), ctx, data)
    log_activity(
        ctx.salon,
        "loyalty_program.created",
        f"Programma fedeltà «{program.name}»",
        actor=ctx.user,
        payload={"program_id": program.id},
    )
    return program


@router.put("/loyalty-programs/{int:program_id}", auth=staff_auth, response=LoyaltyProgramOut)
def update_loyalty_program(request, program_id: int, data: LoyaltyProgramIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    program = _apply_program_data(salon_get(LoyaltyProgram, ctx, program_id), ctx, data)
    log_activity(
        ctx.salon,
        "loyalty_program.updated",
        f"Programma fedeltà «{program.name}» aggiornato",
        actor=ctx.user,
        payload={"program_id": program.id},
    )
    return program


@router.delete("/loyalty-programs/{int:program_id}", auth=staff_auth, response=OkOut)
def delete_loyalty_program(request, program_id: int):
    """Disattivazione (soft): i saldi punti dei clienti restano consultabili."""
    ctx = request.auth
    require_scope(ctx, "marketing")
    program = salon_get(LoyaltyProgram, ctx, program_id)
    program.active = False
    program.save(update_fields=["active"])
    log_activity(
        ctx.salon,
        "loyalty_program.deleted",
        f"Programma fedeltà «{program.name}» disattivato",
        actor=ctx.user,
        payload={"program_id": program.id},
    )
    return OkOut()


@router.get(
    "/loyalty-programs/{program_id}/accounts",
    auth=staff_auth,
    response=list[LoyaltyAccountOut],
)
@paginate(LimitOffsetPagination)
def list_loyalty_accounts(request, program_id: int, client_id: Optional[int] = None):
    """Conti fedeltà del programma; con `client_id` solo quello di una cliente.

    Senza il filtro la scheda di una cliente si trovava solo scorrendo le
    pagine: con qualche migliaio di iscritte la dashboard doveva scaricarle
    tutte per mostrare i punti di una sola persona.
    """
    program = salon_get(LoyaltyProgram, request.auth, program_id)
    qs = program.accounts.select_related("client")
    if client_id:
        qs = qs.filter(client_id=client_id)
    return qs


# ---- Comunicazioni -----------------------------------------------------------


@router.get("/communications", auth=staff_auth, response=list[CommunicationOut])
@paginate(LimitOffsetPagination)
def list_communications(request, status: str = ""):
    qs = Communication.objects.filter(salon=request.auth.salon)
    if status:
        qs = qs.filter(status=status)
    return qs


def _check_audience(data: CommunicationIn):
    """Un audience_type sconosciuto veniva letto come «lista di id cliente»:
    un refuso su «labels» e la promozione pensata per le VIP partiva a due
    persone a caso, quelle con l'id uguale all'id dell'etichetta."""
    if data.audience_type not in Communication.AudienceType.values:
        raise HttpError(422, "Destinatari non validi: scegli etichette o clienti")


@router.post("/communications", auth=staff_auth, response=CommunicationOut)
def create_communication(request, data: CommunicationIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    _check_audience(data)
    comm = Communication.objects.create(salon=ctx.salon, **data.dict())
    log_activity(
        ctx.salon,
        "communication.created",
        f"Comunicazione «{comm.title}»",
        actor=ctx.user,
        payload={"communication_id": comm.id},
    )
    return comm


@router.put("/communications/{int:comm_id}", auth=staff_auth, response=CommunicationOut)
def update_communication(request, comm_id: int, data: CommunicationIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    comm = salon_get(Communication, ctx, comm_id)
    if comm.status == Communication.Status.SENT:
        raise HttpError(422, "Comunicazione già inviata: non modificabile")
    _check_audience(data)
    # Modificare una comunicazione già programmata annulla l'invio in coda e la
    # riporta in bozza: altrimenti Yourang consegnava alla data la versione
    # vecchia, e un nuovo «Invia» ne accodava una seconda copia.
    cancel_pending_send(comm)
    comm.status = Communication.Status.DRAFT
    for name, value in data.dict().items():
        setattr(comm, name, value)
    comm.save()
    log_activity(
        ctx.salon,
        "communication.updated",
        f"Comunicazione «{comm.title}» aggiornata",
        actor=ctx.user,
        payload={"communication_id": comm.id},
    )
    return comm


@router.delete("/communications/{int:comm_id}", auth=staff_auth, response=OkOut)
def delete_communication(request, comm_id: int):
    ctx = request.auth
    require_scope(ctx, "marketing")
    comm = salon_get(Communication, ctx, comm_id)
    log_activity(
        ctx.salon,
        "communication.deleted",
        f"Comunicazione «{comm.title}» eliminata",
        actor=ctx.user,
        payload={"communication_id": comm.id},
    )
    # Prima l'invio in coda partiva lo stesso: i clienti ricevevano il messaggio
    # di una campagna che il salone aveva cancellato.
    cancel_pending_send(comm)
    comm.delete()
    return OkOut()


@router.post("/communications/{int:comm_id}/send", auth=staff_auth, response=CommunicationOut)
def send_communication_endpoint(request, comm_id: int, data: CommunicationSendIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    comm = salon_get(Communication, ctx, comm_id)
    # Si invia solo da bozza. Prima una comunicazione già programmata restava
    # rinviabile all'infinito e ogni clic accodava un invio in più: la stessa
    # promozione arrivava due, tre, dieci volte alla stessa cliente. Per
    # cambiarle data si passa dalla modifica, che la riporta in bozza.
    if comm.status != Communication.Status.DRAFT:
        if comm.status == Communication.Status.SENT:
            raise HttpError(422, "Comunicazione già inviata")
        raise HttpError(
            422, "Comunicazione già programmata: modificala per cambiarle data"
        )
    # `scheduled_at` assente = «usa la data salvata»; `scheduled_at: null`
    # esplicito = «invia adesso» anche se una data è salvata.
    fields = data.dict(exclude_unset=True)
    if "scheduled_at" in fields:
        return send_communication(comm, scheduled_at=fields["scheduled_at"], actor=ctx.user)
    return send_communication(comm, actor=ctx.user)


# ---- Endpoint app cliente ----------------------------------------------------


@router.get("/client/wallet", auth=client_auth, response=WalletOut)
def client_wallet(request):
    ctx = request.auth
    now = timezone.now()
    # Il portafoglio filtrava solo su status=ACTIVE, ma EXPIRED si scrive
    # soltanto quando qualcuno prova a riscattare: una carta scaduta da mesi
    # continuava a comparire nel «Saldo totale» e la cassa poi la rifiutava
    # davanti alla cliente. La scadenza va quindi verificata in lettura.
    not_expired = Q(expires_at__isnull=True) | Q(expires_at__gte=now)
    # Le carte ancora da pagare restano visibili a CHI LE HA COMPRATE (l'app le
    # mostra con l'etichetta «Da pagare in salone»: nasconderle farebbe sparire
    # un acquisto appena fatto), ma non a chi le riceve: annunciare a una
    # destinataria un credito che il salone non ha ancora incassato significa
    # farglielo rifiutare in cassa. È la stessa regola dell'agenda, che tra i
    # regali prenotabili conta solo le carte pagate.
    mine = Q(payment_status=GiftCard.PaymentStatus.PAID) & (
        Q(buyer_client=ctx.client) | Q(recipient_client=ctx.client)
    ) | Q(payment_status=GiftCard.PaymentStatus.UNPAID, buyer_client=ctx.client)
    cards = list(
        GiftCard.objects.filter(salon=ctx.salon, status=GiftCard.Status.ACTIVE)
        .filter(not_expired)
        .filter(mine)
        .select_related("gift_service", "buyer_client")
        .order_by("-created_at")
    )
    for card in cards:
        card._received = card.recipient_client_id == ctx.client.id
    coupons = (
        Coupon.objects.filter(
            salon=ctx.salon, client=ctx.client, status=Coupon.Status.ACTIVE
        )
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gte=now))
        .order_by("-created_at")
    )
    loyalty = []
    accounts = LoyaltyAccount.objects.filter(
        client=ctx.client, program__salon=ctx.salon, program__active=True
    ).select_related("program")
    for account in accounts:
        program = account.program
        progress = (
            min(100, int(account.points * 100 / program.threshold))
            if program.threshold
            else 0
        )
        loyalty.append(
            {
                "program_id": program.id,
                "program_name": program.name,
                "type": program.type,
                "color": program.color,
                "points": account.points,
                "threshold": program.threshold,
                "progress_pct": progress,
            }
        )
    return {"gift_cards": list(cards), "coupons": list(coupons), "loyalty": loyalty}


# Una gift card comprata dall'app è un impegno che il salone dovrà onorare: il
# tetto è quello che una cliente può ragionevolmente regalare. Senza, un POST
# con value=99999999.99 creava una carta da cento milioni che entrava nei KPI
# del salone, e in ciclo riempiva la tabella.
CLIENT_GIFT_CARD_MIN = Decimal("5")
CLIENT_GIFT_CARD_MAX = Decimal("1000")
CLIENT_GIFT_CARD_PER_DAY = 5


@router.post("/client/gift-cards", auth=client_auth, response=GiftCardOut)
def client_create_gift_card(request, data: ClientGiftCardIn):
    """Acquisto gift card dall'app: nasce unpaid, pagamento in salone
    (Stripe checkout in fase 2)."""
    ctx = request.auth
    value = Decimal(str(data.value)).quantize(Decimal("0.01"))
    if not CLIENT_GIFT_CARD_MIN <= value <= CLIENT_GIFT_CARD_MAX:
        raise HttpError(
            422,
            f"Il valore della gift card dev'essere fra €{CLIENT_GIFT_CARD_MIN:.0f} "
            f"e €{CLIENT_GIFT_CARD_MAX:.0f}",
        )
    recipient_name = (data.recipient_name or "").strip()[:120]
    # Nessuna carta viene pagata al momento: senza un limite, un ciclo dall'app
    # riempie la tabella di carte fantasma che il salone si ritrova da smaltire.
    if not ratelimit.hit(f"giftcard:client:{ctx.client.id}", CLIENT_GIFT_CARD_PER_DAY, 24 * 3600):
        raise HttpError(429, "Troppe gift card richieste oggi: riprova domani")
    return create_gift_card(
        ctx.salon,
        value,
        buyer_client=ctx.client,
        recipient_name=recipient_name,
        paid=False,
    )


@router.post("/client/marketing-consent", auth=client_auth, response=OkOut)
def client_set_marketing_consent(request, data: MarketingConsentIn):
    """Consenso marketing: concesso o REVOCATO dalla cliente (GDPR art. 7.3).

    Finora il consenso si poteva solo accendere — dal form pubblico o dalla
    scheda in salone — e nessuna schermata permetteva di spegnerlo: una volta
    dentro le campagne non si usciva più. Qui la revoca è immediata, e siccome
    `send_communication` risolve i destinatari su `consents.marketing=True`
    l'invio successivo la salta senza altre modifiche.
    """
    client = request.auth.client
    now = timezone.now().isoformat()
    consents = dict(client.consents or {})
    consents["marketing"] = bool(data.accepted)
    # Si tiene traccia di QUANDO: il consenso va dimostrato, e la revoca pure.
    if data.accepted:
        consents["marketing_at"] = now
        consents.pop("marketing_revoked_at", None)
    else:
        consents["marketing_revoked_at"] = now
        consents["marketing_at"] = ""
    client.consents = consents
    client.save(update_fields=["consents"])
    log_activity(
        request.auth.salon,
        "client.consent_updated",
        f"{client.full_name}: consenso marketing "
        + ("concesso" if data.accepted else "revocato"),
        payload={"client_id": client.id, "marketing": bool(data.accepted)},
    )
    return OkOut()
