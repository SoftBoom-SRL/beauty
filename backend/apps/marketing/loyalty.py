"""Fedeltà: punti e timbri maturati in cassa, premi alla soglia, regole del programma.

L'accredito (`accrue_loyalty`, chiamato dalla cassa dentro la transazione
della vendita) stava in services.py; le regole con cui si salva un programma
stavano in api.py, con i commenti che rimandavano a services. Qui stanno
insieme: il tetto ai premi per vendita e quello al rapporto di accumulo si
difendono dallo stesso errore, uno a valle e uno a monte.
"""

import math
import re
from decimal import Decimal

from django.db import transaction
from django.db.models import F
from ninja.errors import HttpError

from apps.catalog.models import Service
from apps.core.services import emit_event, log_activity
from common.money import MAX_MONEY
from common.utils import salon_get

from .codes import COUPON_CODE_LENGTH, unique_code
from .gift_cards import LOYALTY_PAID_METHOD, create_gift_card
from .models import Coupon, LoyaltyAccount, LoyaltyProgram
from .schemas import LoyaltyProgramIn

# Premi che il gestionale sa davvero emettere e il banco sa riscattare. Il
# «prodotto omaggio» non c'è: non esiste un buono legato a un articolo di
# magazzino, e accettarlo qui significherebbe promettere alla cliente un premio
# che nessuna cassa può onorare.
ISSUABLE_REWARDS = ("coupon_amount", "discount_pct", "free_service", "gift_card")

# Tetto al rapporto di accumulo. Un refuso (1000 invece di 1) su un programma
# «per euro» con soglia bassa emetteva migliaia di premi a ogni scontrino;
# MAX_REWARDS_PER_SALE ferma l'emorragia a valle, questo la evita a
# monte. Cento punti per euro è già una scelta esotica, oltre è un errore.
MAX_EARN_RATIO = Decimal("100")
# Un punto che scade fra otto anni non scade: oltre questo non ha senso e il
# campo (PositiveSmallIntegerField) andrebbe comunque in overflow.
MAX_POINTS_EXPIRY_MONTHS = 120
MAX_THRESHOLD = 1_000_000

_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _issue_reward(program, client):
    """Emette il premio del programma. Ritorna None se non è emettibile.

    Ogni tipo di premio offerto dall'interfaccia ha qui la sua emissione:
    - buono € e sconto %: un Coupon, come prima;
    - servizio omaggio: una gift card legata a quel servizio, del suo prezzo —
      è il meccanismo che il banco sa già riscattare. Prima diventava un coupon
      da 0 €, perché la maschera manda reward_value=0 per questo tipo: la
      cliente raggiungeva la soglia, perdeva i punti e riceveva un buono che
      non scontava niente;
    - gift card: una carta del valore configurato.
    """
    salon = program.salon
    reward_type = program.reward_type
    value = Decimal(str(program.reward_value or 0))

    if reward_type in (
        LoyaltyProgram.RewardType.COUPON_AMOUNT,
        LoyaltyProgram.RewardType.DISCOUNT_PCT,
    ):
        if value <= 0:
            return None
        kind = (
            Coupon.Kind.PERCENT
            if reward_type == LoyaltyProgram.RewardType.DISCOUNT_PCT
            else Coupon.Kind.AMOUNT
        )
        coupon = Coupon.objects.create(
            salon=salon,
            client=client,
            code=unique_code(Coupon, salon, COUPON_CODE_LENGTH),
            kind=kind,
            value=value,
            origin=Coupon.Origin.LOYALTY,
        )
        suffix = "%" if kind == Coupon.Kind.PERCENT else "€"
        return {
            "label": f"coupon {coupon.code} ({value}{suffix})",
            "event": {"coupon_id": coupon.id, "coupon_code": coupon.code},
        }

    if reward_type == LoyaltyProgram.RewardType.FREE_SERVICE:
        service = program.reward_service
        # Un servizio a prezzo zero non diventa una carta (create_gift_card
        # rifiuta il valore 0): l'errore saliva dentro la transazione della
        # cassa e ogni scontrino di quella cliente veniva rifiutato. Il prezzo
        # può essere stato azzerato dopo aver salvato il programma, quindi il
        # controllo della maschera da solo non basta.
        if service is None or Decimal(str(service.price or 0)) <= 0:
            return None
        card = create_gift_card(
            salon,
            Decimal(str(service.price)),
            gift_service=service,
            recipient_client=client,
            recipient_name=client.full_name,
            paid=True,
            paid_method=LOYALTY_PAID_METHOD,
            cash_in=False,
        )
        return {
            "label": f"servizio omaggio {service.name_it} (carta {card.code})",
            "event": {
                "gift_card_id": card.id,
                "gift_card_code": card.code,
                "service_id": service.id,
            },
        }

    if reward_type == LoyaltyProgram.RewardType.GIFT_CARD:
        if value <= 0:
            return None
        card = create_gift_card(
            salon,
            value,
            recipient_client=client,
            recipient_name=client.full_name,
            paid=True,
            paid_method=LOYALTY_PAID_METHOD,
            cash_in=False,
        )
        return {
            "label": f"gift card {card.code} (€{value})",
            "event": {"gift_card_id": card.id, "gift_card_code": card.code},
        }

    return None


# Tetto ai premi che una singola vendita può emettere. Un programma configurato
# male (1000 punti per euro, soglia 10) trasformava un incasso da 100 € in
# diecimila premi: trentamila insert e diecimila messaggi WhatsApp dentro la
# transazione della cassa, con la cassiera bloccata a guardare la rotellina.
# Oltre il tetto i punti restano sul saldo del cliente — non si perde niente, i
# premi successivi arriveranno con le spese seguenti — e resta a registro una
# riga che segnala al salone che la configurazione è sbagliata.
MAX_REWARDS_PER_SALE = 10


def _loyalty_basis(sale) -> dict:
    """Quanto della vendita conta per la fedeltà: una volta per vendita, non
    una per programma.

    - Le gift card vendute non danno punti: li darà la spesa fatta con la
      carta. Contarle significava pagare due volte lo stesso denaro, una
      all'acquisto e una al riscatto. Per la stessa ragione una vendita fatta
      SOLO di gift card non è una visita: cinque carte di Natale in cinque
      scontrini valevano cinque timbri.
    - Il premio speso non fa guadagnare altro: una piega omaggio da 45 € pagata
      con la carta premio accreditava 45 punti, e con i timbri per servizio
      l'omaggio contava come timbro — il premio arrivava ogni nove visite
      pagate invece che ogni dieci. Le carte premio sono quelle con
      paid_method="loyalty" (vedi _issue_reward); i buoni premio abbassano già
      `sale.total`, e contano solo se il conto l'hanno pagato per intero.
    """
    sold_cards = Decimal("0")
    gift_card_lines = other_lines = services = 0
    for line in sale.lines.all():
        if line.line_type == "gift_card":
            gift_card_lines += 1
            sold_cards += Decimal(str(line.amount))
        else:
            other_lines += 1
            if line.line_type == "service":
                services += 1
    reward_paid = Decimal("0")
    reward_service_cards = set()
    for payment in sale.payments.filter(
        method="gift_card", gift_card__paid_method=LOYALTY_PAID_METHOD
    ).select_related("gift_card"):
        reward_paid += Decimal(str(payment.amount))
        if payment.gift_card.gift_service_id:
            reward_service_cards.add(payment.gift_card_id)
    reward_coupon = sale.coupons.filter(origin=Coupon.Origin.LOYALTY).exists()
    paid = Decimal(str(sale.total)) - sold_cards - reward_paid
    return {
        "paid": paid,
        "only_gift_cards": gift_card_lines > 0 and other_lines == 0,
        # Il conto l'ha pagato per intero un premio: non è una visita pagata.
        "reward_only": (reward_paid > 0 or reward_coupon) and paid <= 0,
        # Ogni carta «servizio omaggio» spesa copre un servizio del conto.
        "services": max(0, services - len(reward_service_cards)),
    }


def _points_earned(sale, program, basis=None) -> int:
    """Punti maturati dalla vendita secondo la metrica del programma."""
    basis = basis or _loyalty_basis(sale)
    metric = program.earn_metric
    # Un programma «A timbri» dà un timbro per visita o per servizio, MAI per
    # euro: la dashboard creava le tessere timbri con la metrica «per euro»
    # rimasta dal modello vuoto, e una piega da 45 € valeva 45 timbri — più
    # premi a ogni scontrino. L'API ora rifiuta la combinazione e la
    # migrazione 0004 ha corretto i programmi salvati; qui si resta al sicuro
    # anche con un programma scritto da un'altra via. Il rapporto non conta:
    # la maschera non lo mostra per i timbri, e un valore rimasto da «Punti»
    # (2, oppure 0,5 che arrotondato dava zero timbri) cambiava la tessera
    # senza che nessuno lo vedesse.
    stamps = program.type == LoyaltyProgram.Type.STAMPS
    if stamps and metric == LoyaltyProgram.EarnMetric.PER_EURO:
        metric = LoyaltyProgram.EarnMetric.PER_VISIT
    if metric == LoyaltyProgram.EarnMetric.PER_EURO:
        paid = basis["paid"]
        return math.floor(paid * program.earn_ratio) if paid > 0 else 0
    if basis["only_gift_cards"] or basis["reward_only"]:
        return 0
    if metric == LoyaltyProgram.EarnMetric.PER_VISIT:
        return 1 if stamps else math.floor(program.earn_ratio)
    # per_service
    n_services = basis["services"]
    return n_services if stamps else math.floor(program.earn_ratio * n_services)


def accrue_loyalty(sale):
    """Accredita punti per la vendita su ogni programma attivo; alla soglia genera
    un Coupon origin=loyalty ed emette `loyalty.reward`. No-op se la vendita è anonima."""
    client = sale.client
    if client is None:
        return
    salon = sale.salon
    basis = None  # calcolata al primo programma che serve, poi riusata
    for program in LoyaltyProgram.objects.filter(salon=salon, active=True):
        # Lettura del saldo, emissione dei premi e scrittura stanno in una sola
        # transazione con la riga del conto bloccata. Prima erano una lettura, una
        # somma in Python e un save: due casse che chiudevano insieme due scontrini
        # della stessa cliente leggevano entrambe 95 punti su una soglia di 100,
        # emettevano entrambe il premio e si sovrascrivevano il saldo a vicenda.
        with transaction.atomic():
            account = (
                LoyaltyAccount.objects.select_for_update()
                .filter(program=program, client=client)
                .first()
            )
            if account is None:
                if program.enrollment != LoyaltyProgram.Enrollment.AUTO:
                    continue  # iscrizione su richiesta/a pagamento: nessun auto-enroll
                # get_or_create ripiega su una get quando la unique scatta. Con la
                # create secca, due vendite simultanee della stessa cliente appena
                # iscritta facevano esplodere l'IntegrityError dentro l'atomic di
                # finalize_sale: 500 alla cassiera e scontrino annullato per intero.
                LoyaltyAccount.objects.get_or_create(program=program, client=client)
                account = LoyaltyAccount.objects.select_for_update().get(
                    program=program, client=client
                )

            if basis is None:
                basis = _loyalty_basis(sale)
            earned = _points_earned(sale, program, basis)
            if earned <= 0:
                continue

            points = account.points + earned
            issued = 0
            while (
                program.threshold > 0
                and points >= program.threshold
                and issued < MAX_REWARDS_PER_SALE
            ):
                reward = _issue_reward(program, client)
                if reward is None:
                    # Premio non emettibile (servizio omaggio senza servizio
                    # scelto, valore a zero): i punti NON si consumano, altrimenti
                    # la cliente pagherebbe la soglia per niente.
                    log_activity(
                        salon,
                        "loyalty.reward_misconfigured",
                        f"Premio fedeltà «{program.name}» non emesso: configurazione incompleta",
                        payload={"client_id": client.id, "program_id": program.id},
                    )
                    break
                points -= program.threshold
                issued += 1
                emit_event(
                    salon,
                    "loyalty.reward",
                    {
                        "client_id": client.id,
                        "client_name": client.full_name,
                        "phone": client.phone,
                        "lang": client.lang,
                        "program_id": program.id,
                        "program": program.name,
                        **reward["event"],
                    },
                )
                log_activity(
                    salon,
                    "loyalty.reward",
                    f"Premio fedeltà «{program.name}» per {client.full_name}: {reward['label']}",
                    payload={
                        "client_id": client.id,
                        "program_id": program.id,
                        "sale_id": sale.id,
                        **reward["event"],
                    },
                )
            if issued >= MAX_REWARDS_PER_SALE and points >= program.threshold > 0:
                log_activity(
                    salon,
                    "loyalty.reward_capped",
                    f"Programma «{program.name}»: raggiunto il tetto di {MAX_REWARDS_PER_SALE} "
                    "premi per vendita, i punti restanti restano sul saldo",
                    payload={
                        "client_id": client.id,
                        "program_id": program.id,
                        "sale_id": sale.id,
                        "points_left": points,
                    },
                )
            # Incremento in SQL: il delta si applica al valore che il database ha
            # davvero, non a una copia letta prima di emettere i premi.
            LoyaltyAccount.objects.filter(pk=account.pk).update(
                points=F("points") + (points - account.points)
            )


def apply_program_data(program: LoyaltyProgram, ctx, data: LoyaltyProgramIn):
    """Valida i campi del programma e li scrive su `program` (creazione o modifica).

    `ctx` serve a cercare il servizio del premio dentro il salone di chi scrive.
    """
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
    # vedi `_points_earned`): si scrive 1 qualunque cosa arrivi, così
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
