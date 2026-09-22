"""Numeri di telefono: normalizzazione E.164 e ricerca cliente per numero.

Un solo punto per tutti gli ingressi (dashboard, app cliente, form pubblico,
import CSV, sync Yourang): «+39 333 1234567», «3331234567» e «0039 333…» sono
lo stesso numero e devono trovare lo stesso cliente. Prima di questa
centralizzazione login e registrazione confrontavano la stringa quasi letterale
e lo stesso telefono scritto in due modi diventava due identità.
"""

import re

# Lo 0 subito dopo il country code è il prefisso interurbano e quasi ovunque va
# tolto: +44 020 7946 0958 e +44 20 7946 0958 sono lo stesso numero di Londra.
# L'Italia è l'eccezione — lo 0 di distretto fa parte del numero nazionale e
# resta: +39 02 1234567 è giusto, +39 2 1234567 non esiste.
TRUNK_ZERO_KEPT = {"39"}

# Per togliere quello 0 bisogna sapere dove finisce il country code, e i CC
# hanno lunghezza variabile. La tabella è volutamente corta (i paesi da cui
# arrivano davvero le clienti) e un CC che non c'è lascia il numero intatto:
# accorciare senza sapere dove finisce il prefisso è peggio che non toccare.
COUNTRY_CODES = ("39", "44", "49", "33", "34", "41", "43", "32", "31", "30", "351", "353", "420")

# Cifre massime di un numero nazionale (Italia: 11, quanto il fisso più lungo).
# Oltre questa soglia una stringa senza «+» porta già il proprio prefisso
# internazionale: gli export dei gestionali e WhatsApp scrivono «393331234567».
NATIONAL_MAX_DIGITS = 11


def _already_international(digits: str) -> bool:
    """Cifre senza «+» che sono già in forma E.164.

    Servono entrambe le condizioni — prefisso noto E più lunghe di un numero
    nazionale — perché molti numeri italiani cominciano con il prefisso di
    qualcun altro: «3331234567» inizia per «33» (Francia) ma è un cellulare
    italiano. È la stessa regola di `splitPhone` in
    frontend/packages/shared/src/phone.js: se le due divergono, la stessa
    persona diventa due schede e i promemoria partono verso un numero che non
    esiste (39 39 333…).
    """
    if len(digits) <= NATIONAL_MAX_DIGITS:
        return False
    return any(digits.startswith(cc) for cc in COUNTRY_CODES)


def _drop_trunk_zero(digits: str) -> str:
    """Toglie l'eventuale 0 interurbano dopo il country code, dove serve."""
    for cc in sorted(COUNTRY_CODES, key=len, reverse=True):
        if not digits.startswith(cc):
            continue
        rest = digits[len(cc):]
        if cc in TRUNK_ZERO_KEPT or not rest.startswith("0"):
            return digits
        return cc + rest[1:]
    return digits


def normalize_phone(raw: str, default_cc: str = "39") -> str | None:
    """Porta un numero a testo libero in E.164 (`+39...`). None se non normalizzabile."""
    if not raw:
        return None
    s = re.sub(r"[^\d+]", "", str(raw).strip())
    if s.startswith("+"):
        digits = s[1:]
    elif s.startswith("00"):
        digits = s[2:]
    elif _already_international(s):
        # Niente prefisso davanti: le cifre lo contengono già.
        digits = s
    else:
        digits = default_cc + s
    digits = _drop_trunk_zero(digits)
    if not re.fullmatch(r"[1-9]\d{6,14}", digits):
        return None
    return "+" + digits


def canonical_phone(raw: str) -> str:
    """Forma da SALVARE: E.164 se il numero è normalizzabile, altrimenti il testo ripulito.

    Non si perde mai l'input dell'utente (un numero strano resta com'è), ma
    tutto ciò che è riconoscibile converge sulla stessa scrittura.
    """
    text = (raw or "").strip()
    return normalize_phone(text) or text


def phone_key(raw: str) -> str:
    """Chiave di confronto tollerante: E.164 senza '+', oppure le sole cifre."""
    normalized = normalize_phone(raw)
    if normalized:
        return normalized[1:]
    return re.sub(r"\D", "", raw or "")


def find_client_by_phone(salon, phone: str, *, active_only: bool = False, exclude_id=None):
    """Cliente del salone con quel numero, comunque sia stato scritto. None se assente.

    Prima il confronto esatto (indice), poi il confronto per chiave normalizzata
    sui clienti del salone: i numeri salvati prima della normalizzazione
    possono avere spazi o prefissi diversi.
    """
    from apps.clients.models import Client  # lazy: evita cicli in fase di load

    text = (phone or "").strip()
    if not text:
        return None
    qs = Client.objects.filter(salon=salon)
    if active_only:
        qs = qs.filter(is_active=True)
    if exclude_id is not None:
        qs = qs.exclude(id=exclude_id)

    candidates = {text}
    normalized = normalize_phone(text)
    if normalized:
        candidates.add(normalized)
    exact = qs.filter(phone__in=candidates).order_by("id").first()
    if exact is not None:
        return exact

    key = phone_key(text)
    if not key:
        return None
    # Colonna indicizzata: la stessa chiave, calcolata al salvataggio. Prima qui
    # si scorreva TUTTA l'anagrafica del salone in memoria, a ogni richiesta e
    # anche su endpoint pubblici.
    by_key = qs.filter(phone_key=key).order_by("id").first()
    if by_key is not None:
        return by_key
    # Schede scritte prima della colonna e mai risalvate: confronto in memoria,
    # ristretto a quelle che la chiave non ha ancora.
    for client in qs.filter(phone_key="").only("id", "phone").order_by("id").iterator():
        if phone_key(client.phone) == key:
            return qs.get(pk=client.pk)
    return None
