"""Codici al portatore di coupon e gift card: generazione, mascheramento, stato letto adesso.

Stavano in tre posti: la generazione in services.py, la maschera e lo stato
«come lo vede chi legge» in schemas.py, il filtro di stato degli elenchi in
api.py. L'agenda usa la stessa maschera per i regali della prenotazione.
"""

from django.db.models import Q
from django.utils import timezone

from common.utils import human_code

# Lunghezza dei codici `human_code` (le colonne ne tengono 16).
COUPON_CODE_LENGTH = 8
GIFT_CARD_CODE_LENGTH = 12


def unique_code(model, salon, length: int) -> str:
    """Codice human_code unico per salone (coupon 8, gift card 12)."""
    while True:
        code = human_code(length)
        if not model.objects.filter(salon=salon, code=code).exists():
            return code


# ---- Maschera ------------------------------------------------------------------

# Chi conosce il codice di una gift card o di un coupon lo spende in cassa: è
# denaro al portatore. Le letture restano aperte a tutto lo staff (l'agenda
# mostra i regali, la scheda cliente il portafoglio), ma il codice intero lo
# vede solo chi lavora con quegli strumenti — marketing o cassa — come si fa
# già con i webhook_token delle automazioni. Prima un'operatrice con la sola
# agenda sfogliava codici e saldi di tutte le carte pagate del salone.
CODE_SCOPES = frozenset({"marketing", "sales"})
CODE_MASK = "••••"


def codes_hidden(auth) -> bool:
    """True se chi guarda è staff senza marketing né cassa.

    Il contesto della cliente (app) non ha scope: vede solo le proprie carte e
    il codice le serve per spenderle.
    """
    scopes = getattr(auth, "scopes", None)
    if scopes is None:
        return False
    return not (getattr(auth, "is_owner", False) or CODE_SCOPES & set(scopes))


def mask_code(code: str) -> str:
    code = code or ""
    return CODE_MASK + code[-4:] if len(code) > 4 else CODE_MASK


def code_for(obj, context) -> str:
    """Il codice di `obj` come lo può vedere chi fa la richiesta (contesto dello schema)."""
    request = (context or {}).get("request")
    if request is not None and codes_hidden(getattr(request, "auth", None)):
        return mask_code(obj.code)
    return obj.code


# ---- Scadenza ------------------------------------------------------------------


def effective_status(obj) -> str:
    """Lo stato come lo vede chi legge: attivo ma oltre la scadenza = scaduto.

    EXPIRED a database lo scrive solo un tentativo di riscatto, quindi una carta
    scaduta la settimana scorsa risultava «attiva» negli elenchi dello staff (e
    la nuova prenotazione la prometteva come regalo) mentre il filtro «Scadute»
    non la trovava. Coupon e gift card hanno gli stessi valori di stato.
    """
    if obj.status == "active" and obj.expires_at and obj.expires_at < timezone.now():
        return "expired"
    return obj.status


def status_q(model, status: str) -> Q:
    """Filtro di stato di coupon e gift card con la scadenza letta adesso (C21).

    EXPIRED a database lo scrive solo un tentativo di riscatto: con il filtro
    secco su `status` una carta scaduta la settimana scorsa stava fra le
    «attive» — la nuova prenotazione la prometteva come regalo e la cassa poi
    la rifiutava — e «Scadute» non la trovava. Stessa regola dell'uscita
    (`effective_status`).
    """
    now = timezone.now()
    if status == model.Status.ACTIVE:
        return Q(status=model.Status.ACTIVE) & (
            Q(expires_at__isnull=True) | Q(expires_at__gte=now)
        )
    if status == model.Status.EXPIRED:
        return Q(status=model.Status.EXPIRED) | Q(
            status=model.Status.ACTIVE, expires_at__lt=now
        )
    return Q(status=status)
