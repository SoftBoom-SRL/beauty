import re
from decimal import Decimal
from typing import Optional

from django.apps import apps as django_apps
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError
from ninja.pagination import LimitOffsetPagination, paginate

from apps.core.services import log_activity
from common import ratelimit
from common.auth import client_auth, staff_auth
from common.money import CENT, MAX_MONEY
from common.permissions import require_scope
from common.schemas import OkOut
from common.utils import salon_get

from .codes import COUPON_CODE_LENGTH, codes_hidden, status_q, unique_code
from .coupons import validate_coupon_value
from .gift_cards import (
    CLIENT_GIFT_CARD_MAX,
    CLIENT_GIFT_CARD_MIN,
    CLIENT_GIFT_CARD_PER_DAY,
    cash_gift_card,
    create_gift_card,
    gift_card_kpis,
    sell_gift_card,
)
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
    LoyaltyEnrollIn,
    LoyaltyProgramIn,
    LoyaltyProgramOut,
    MarketingConsentIn,
    MarkPaidIn,
    WalletOut,
)
from .services import (
    cancel_pending_send,
    marketing_consent_changed,
    send_communication,
    settle_due_communications,
)

router = Router(tags=["marketing"])

def _get_client(ctx, client_id):
    Client = django_apps.get_model("clients", "Client")  # lazy: evita cicli
    return salon_get(Client, ctx, client_id)


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
    ctx = request.auth
    qs = Coupon.objects.filter(salon=ctx.salon).select_related("client")
    if origin:
        qs = qs.filter(origin=origin)
    if status:
        qs = qs.filter(status_q(Coupon, status))
    if q:
        match = Q(client__first_name__icontains=q) | Q(client__last_name__icontains=q)
        # A chi vede i codici mascherati la ricerca per codice direbbe comunque
        # se un pezzo di codice esiste: carattere dopo carattere lo ricostruisce.
        if not codes_hidden(ctx):
            match |= Q(code__icontains=q)
        qs = qs.filter(match)
    if client_id:
        qs = qs.filter(client_id=client_id)
    # `id` come spareggio: le pagine restano stabili anche a parità di data.
    return qs.order_by("-created_at", "-id")


@router.post("/coupons", auth=staff_auth, response=CouponOut)
def create_coupon(request, data: CouponIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    if data.kind not in Coupon.Kind.values:
        raise HttpError(422, "Tipo coupon non valido")
    value = validate_coupon_value(data.kind, data.value)
    client = _get_client(ctx, data.client_id) if data.client_id else None
    coupon = Coupon.objects.create(
        salon=ctx.salon,
        client=client,
        code=unique_code(Coupon, ctx.salon, COUPON_CODE_LENGTH),
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
    value = validate_coupon_value(data.kind, data.value)
    client = _get_client(ctx, data.client_id) if data.client_id else None
    # UPDATE condizionato a status='active', solo sui campi della maschera. Il
    # save() completo della copia letta a inizio richiesta riscriveva anche
    # status e vendita: se nel frattempo la cassa aveva consumato il buono
    # (mark_coupon_redeemed), tornava «attivo» e senza vendita — scontrino
    # scontato e buono di nuovo spendibile.
    updated = Coupon.objects.filter(
        pk=coupon.pk, salon=ctx.salon, status=Coupon.Status.ACTIVE
    ).update(client=client, kind=data.kind, value=value, expires_at=data.expires_at)
    if not updated:
        raise HttpError(422, "Coupon appena utilizzato o scaduto: non è più modificabile")
    coupon.refresh_from_db()
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
    ctx = request.auth
    qs = GiftCard.objects.filter(salon=ctx.salon).select_related(
        "buyer_client", "gift_service"
    )
    if status:
        qs = qs.filter(status_q(GiftCard, status))
    if payment_status:
        qs = qs.filter(payment_status=payment_status)
    if q:
        match = (
            Q(recipient_name__icontains=q)
            | Q(buyer_client__first_name__icontains=q)
            | Q(buyer_client__last_name__icontains=q)
        )
        # Codici mascherati: niente ricerca per pezzi di codice (vedi list_coupons).
        if not codes_hidden(ctx):
            match |= Q(code__icontains=q)
        qs = qs.filter(match)
    if client_id:
        # il cliente può comparire come acquirente e/o destinatario della carta
        qs = qs.filter(Q(buyer_client_id=client_id) | Q(recipient_client_id=client_id))
    kpi = gift_card_kpis(qs)
    # Elenco paginato: i KPI restano calcolati su TUTTE le carte filtrate, ma
    # la risposta non trascina più migliaia di righe in un colpo solo.
    total = qs.count()
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    items = list(qs.order_by("-created_at", "-id")[offset : offset + limit])
    return {"kpi": kpi, "total": total, "items": items}


@router.post("/gift-cards", auth=staff_auth, response=GiftCardOut)
def create_gift_card_staff(request, data: GiftCardIn):
    ctx = request.auth
    # «Pagata ora» è un incasso: crea vendita e pagamento, quindi lo decide la
    # cassa (`sales`), non il marketing. Il Front desk non poteva vendere una
    # carta intestata alla destinataria (il POS crea solo carte con un nome
    # scritto a mano), e un ruolo solo-marketing registrava incassi senza poter
    # vedere la cassa. Una carta che nasce da pagare resta del marketing.
    require_scope(ctx, "sales" if data.paid else "marketing")
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
    return sell_gift_card(
        ctx.salon,
        value,
        gift_service=gift_service,
        buyer=buyer,
        recipient=recipient,
        recipient_name=data.recipient_name,
        paid=data.paid,
        paid_method=data.paid_method,
        delivery_date=data.delivery_date,
        expires_at=data.expires_at,
        actor=ctx.user,
    )


@router.post("/gift-cards/{int:card_id}/mark-paid", auth=staff_auth, response=GiftCardOut)
def mark_gift_card_paid(request, card_id: int, data: MarkPaidIn):
    ctx = request.auth
    # Incassare è della cassa (vedi create_gift_card_staff): la carta comprata
    # dall'app la paga la cliente al banco, dove c'è chi ha `sales`.
    require_scope(ctx, "sales")
    card = salon_get(GiftCard, ctx, card_id)
    return cash_gift_card(ctx.salon, card, method=data.method, actor=ctx.user)


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
    # Una tessera «A timbri» salvata con la metrica «per euro» (quella del
    # modello vuoto della dashboard, che per i timbri nasconde il selettore)
    # dava un timbro per euro: una piega da 45 € valeva quattro premi.
    stamps = data.type == LoyaltyProgram.Type.STAMPS
    if stamps and data.earn_metric == LoyaltyProgram.EarnMetric.PER_EURO:
        raise HttpError(
            400,
            "Un programma a timbri dà un timbro per visita o per servizio, non per euro speso",
        )
    # threshold=0 faceva accumulare punti che non diventavano mai un premio.
    if not 1 <= data.threshold <= MAX_THRESHOLD:
        raise HttpError(422, "La soglia dev'essere un numero di punti fra 1 e 1.000.000")
    # Per i timbri il rapporto non si sceglie (un timbro a visita o a servizio,
    # vedi services._points_earned): si scrive 1 qualunque cosa arrivi, così
    # quello che la scheda mostra è quello che succede in cassa.
    if not stamps:
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
        # Il listino ammette servizi a 0 €: come premio diventavano una carta da
        # zero che nessuno può emettere, e alla soglia l'errore bloccava ogni
        # incasso di quella cliente.
        if data.reward_type == "free_service" and Decimal(
            str(program.reward_service.price or 0)
        ) <= 0:
            raise HttpError(
                422, "Il servizio da regalare ha prezzo zero: scegline uno a pagamento"
            )
    else:
        program.reward_service = None
    for name, value in data.dict(exclude={"reward_service_id"}).items():
        setattr(program, name, value)
    if stamps:
        program.earn_ratio = Decimal("1")
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
    # `id` come spareggio: con migliaia di iscritte a pari punti (i timbri
    # vanno da 0 a 9) PostgreSQL non garantisce lo stesso ordine fra una
    # pagina e l'altra, e una cliente poteva non cadere in nessuna pagina —
    # «Non ancora iscritta» per chi era a un timbro dal premio.
    qs = program.accounts.select_related("client").order_by("-points", "id")
    if client_id:
        qs = qs.filter(client_id=client_id)
    return qs


@router.post(
    # Stessa stringa di percorso dell'elenco: con «{int:program_id}» Django
    # registrerebbe un secondo pattern, e la POST finirebbe sul primo (solo GET).
    "/loyalty-programs/{program_id}/accounts",
    auth=staff_auth,
    response=LoyaltyAccountOut,
)
def enroll_loyalty_client(request, program_id: int, data: LoyaltyEnrollIn):
    """Iscrive una cliente al programma dallo staff.

    Con l'iscrizione «Su richiesta» o «A pagamento» nessuna via creava il conto
    (accrue_loyalty iscrive da sola solo con «Automatica»): il programma si
    salvava, il cassetto prometteva l'iscrizione su richiesta, e le nuove
    clienti non maturavano niente, in silenzio.
    """
    ctx = request.auth
    require_scope(ctx, "marketing")
    program = salon_get(LoyaltyProgram, ctx, program_id)
    if not program.active:
        raise HttpError(400, "Programma disattivato: riattivalo per iscrivere nuove clienti")
    client = _get_client(ctx, data.client_id)
    # get_or_create: due clic ravvicinati non fanno esplodere la unique, il
    # secondo trova il conto e riceve il 400.
    account, created = LoyaltyAccount.objects.get_or_create(program=program, client=client)
    if not created:
        raise HttpError(400, "La cliente è già iscritta a questo programma")
    log_activity(
        ctx.salon,
        "loyalty.enrolled",
        f"{client.full_name} iscritta al programma fedeltà «{program.name}»",
        actor=ctx.user,
        payload={"program_id": program.id, "client_id": client.id, "account_id": account.id},
    )
    return account


# ---- Comunicazioni -----------------------------------------------------------


@router.get("/communications", auth=staff_auth, response=list[CommunicationOut])
@paginate(LimitOffsetPagination)
def list_communications(request, status: str = ""):
    salon = request.auth.salon
    # Le programmate arrivate alla data sono partite: la scheda le mostra fra
    # le inviate, non più modificabili (07-02).
    settle_due_communications(salon)
    qs = Communication.objects.filter(salon=salon)
    if status:
        qs = qs.filter(status=status)
    return qs.order_by("-created_at", "-id")


def _locked_communication(ctx, comm_id: int) -> Communication:
    """La comunicazione del salone, bloccata fino a fine transazione.

    Modifica, invio ed eliminazione decidevano ciascuna sulla propria copia
    letta a inizio richiesta: un «Programma» e una modifica nello stesso
    momento lasciavano un invio vivo su una bozza.
    """
    comm = salon_get(Communication, ctx, comm_id)
    return Communication.objects.select_for_update().get(pk=comm.pk)


def _already_sent(comm: Communication) -> bool:
    """Inviata, o programmata con la data già passata: l'evento è partito."""
    if comm.status == Communication.Status.SENT:
        return True
    return (
        comm.status == Communication.Status.SCHEDULED
        and comm.scheduled_at is not None
        and comm.scheduled_at <= timezone.now()
    )


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
    _check_audience(data)
    fields = data.dict()
    with transaction.atomic():
        comm = _locked_communication(ctx, comm_id)
        if _already_sent(comm):
            raise HttpError(422, "Comunicazione già inviata: non modificabile")
        # Modificare una comunicazione già programmata annulla l'invio in coda
        # (o presso Yourang, se l'ha già ricevuto) e la riporta in bozza:
        # altrimenti alla data partiva la versione vecchia, e un nuovo «Invia»
        # ne accodava una seconda copia.
        cancel_pending_send(comm)
        comm.status = Communication.Status.DRAFT
        for name, value in fields.items():
            setattr(comm, name, value)
        # Solo i campi della maschera: il save completo riscriveva anche
        # sent_at e l'immagine della copia letta a inizio richiesta (18-07).
        comm.save(update_fields=[*fields, "status"])
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
    with transaction.atomic():
        comm = _locked_communication(ctx, comm_id)
        log_activity(
            ctx.salon,
            "communication.deleted",
            f"Comunicazione «{comm.title}» eliminata",
            actor=ctx.user,
            payload={"communication_id": comm.id},
        )
        # Prima l'invio in coda partiva lo stesso: i clienti ricevevano il
        # messaggio di una campagna che il salone aveva cancellato. Se Yourang
        # l'aveva già ricevuto, ora gli arriva l'annullamento.
        cancel_pending_send(comm)
        comm.delete()
    return OkOut()


@router.post("/communications/{int:comm_id}/send", auth=staff_auth, response=CommunicationOut)
def send_communication_endpoint(request, comm_id: int, data: CommunicationSendIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    # `scheduled_at` assente = «usa la data salvata»; `scheduled_at: null`
    # esplicito = «invia adesso» anche se una data è salvata.
    fields = data.dict(exclude_unset=True)
    with transaction.atomic():
        comm = _locked_communication(ctx, comm_id)
        # Si invia solo da bozza. Prima una comunicazione già programmata
        # restava rinviabile all'infinito e ogni clic accodava un invio in più:
        # la stessa promozione arrivava due, tre, dieci volte alla stessa
        # cliente. Per cambiarle data si passa dalla modifica, che la riporta in
        # bozza.
        if comm.status != Communication.Status.DRAFT:
            if _already_sent(comm):
                raise HttpError(422, "Comunicazione già inviata")
            raise HttpError(
                422, "Comunicazione già programmata: modificala per cambiarle data"
            )
        if "scheduled_at" in fields:
            return send_communication(
                comm, scheduled_at=fields["scheduled_at"], actor=ctx.user
            )
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
        # Contratto C3, stessa regola di gift_index nell'agenda: pagata, con
        # saldo (attiva e non scaduta la filtra già la query), e sua — ne è la
        # destinataria, oppure l'ha comprata lei senza intestarla a nessuno.
        # Una carta comprata «per Maria» (nome scritto a mano) è di Maria.
        card._spendable = (
            card.payment_status == GiftCard.PaymentStatus.PAID
            and card.balance > 0
            and (
                card._received
                or (
                    card.buyer_client_id == ctx.client.id
                    and card.recipient_client_id is None
                    and card.recipient_name == ""
                )
            )
        )
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


@router.post("/client/gift-cards", auth=client_auth, response=GiftCardOut)
def client_create_gift_card(request, data: ClientGiftCardIn):
    """Acquisto gift card dall'app: nasce unpaid, pagamento in salone
    (Stripe checkout in fase 2)."""
    ctx = request.auth
    value = Decimal(str(data.value)).quantize(CENT)
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
    was_accepted = bool(consents.get("marketing"))
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
    # La revoca vale anche per le campagne già programmate o in coda (07-03):
    # si ripete a ogni revoca, perché la cliente può essere finita in un invio
    # anche quando il consenso era stato tolto da un'altra parte.
    if not data.accepted or not was_accepted:
        marketing_consent_changed(client, bool(data.accepted))
    log_activity(
        request.auth.salon,
        "client.consent_updated",
        f"{client.full_name}: consenso marketing "
        + ("concesso" if data.accepted else "revocato"),
        payload={"client_id": client.id, "marketing": bool(data.accepted)},
    )
    return OkOut()
