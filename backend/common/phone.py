"""Numeri di telefono: normalizzazione E.164 e ricerca cliente per numero.

Un solo punto per tutti gli ingressi (dashboard, app cliente, form pubblico,
import CSV, sync Yourang): «+39 333 1234567», «3331234567» e «0039 333…» sono
lo stesso numero e devono trovare lo stesso cliente. Prima di questa
centralizzazione login e registrazione confrontavano la stringa quasi letterale
e lo stesso telefono scritto in due modi diventava due identità.
"""

import re

# Prefissi internazionali assegnati dall'ITU (E.164), elenco completo. Serve a
# sapere dove finisce il country code, che ha lunghezza variabile: la tabella
# corta di prima (i dodici paesi «da cui arrivano le clienti») lasciava fuori
# Romania, Albania, Ucraina, Marocco, Moldavia… La cliente romena che scriveva
# «0721 234 567» con la bandiera RO finiva salvata come +40 0721…, un numero
# che non esiste: niente OTP, niente promemoria, e la stessa persona scritta
# senza lo 0 diventava una seconda scheda (06-04). I prefissi E.164 sono
# «prefix-free» (nessuno è l'inizio di un altro), quindi al più uno combacia.
# Deve restare IDENTICO all'elenco di frontend/packages/shared/src/phone.js:
# se i due divergono, lo stesso numero dà due identità.
COUNTRY_CODES = (
    "1", "7",
    "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44",
    "45", "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58",
    "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91",
    "92", "93", "94", "95", "98",
    "211", "212", "213", "216", "218", "220", "221", "222", "223", "224", "225",
    "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236",
    "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247",
    "248", "249", "250", "251", "252", "253", "254", "255", "256", "257", "258",
    "260", "261", "262", "263", "264", "265", "266", "267", "268", "269", "290",
    "291", "297", "298", "299",
    "350", "351", "352", "353", "354", "355", "356", "357", "358", "359", "370",
    "371", "372", "373", "374", "375", "376", "377", "378", "379", "380", "381",
    "382", "383", "385", "386", "387", "389",
    "420", "421", "423",
    "500", "501", "502", "503", "504", "505", "506", "507", "508", "509", "590",
    "591", "592", "593", "594", "595", "596", "597", "598", "599",
    "670", "672", "673", "674", "675", "676", "677", "678", "679", "680", "681",
    "682", "683", "685", "686", "687", "688", "689", "690", "691", "692",
    "800", "808", "850", "852", "853", "855", "856", "870", "878", "880", "881",
    "882", "883", "886", "888",
    "960", "961", "962", "963", "964", "965", "966", "967", "968", "970", "971",
    "972", "973", "974", "975", "976", "977", "979", "992", "993", "994", "995",
    "996", "997", "998",
)

# Lo 0 subito dopo il country code è il prefisso interurbano e quasi ovunque va
# tolto (uno solo): +44 020 7946 0958 e +44 20 7946 0958 sono lo stesso numero
# di Londra. Fanno eccezione i paesi in cui lo 0 fa parte del numero nazionale
# e resta anche da fuori: Italia (+39 02 1234567 è giusto, +39 2 1234567 non
# esiste), San Marino (+378 0549…), Vaticano (+379) e Costa d'Avorio (+225,
# numeri a 10 cifre che cominciano per 0 dal 2021).
TRUNK_ZERO_KEPT = {"39", "378", "379", "225"}

# Cifre massime di un numero nazionale italiano (quanto il fisso più lungo).
# Oltre questa soglia una stringa senza «+» porta già il proprio prefisso
# internazionale: gli export dei gestionali e WhatsApp scrivono «393331234567».
NATIONAL_MAX_DIGITS = 11

_LONGEST_FIRST = sorted(COUNTRY_CODES, key=len, reverse=True)


def _country_code(digits: str) -> str | None:
    """Il prefisso ITU con cui cominciano le cifre, o None se non è assegnato."""
    for cc in _LONGEST_FIRST:
        if digits.startswith(cc):
            return cc
    return None


def _already_international(digits: str) -> bool:
    """Cifre senza «+» che sono già in forma E.164.

    Servono entrambe le condizioni — più lunghe di un numero nazionale E con
    un prefisso assegnato — perché molti numeri italiani cominciano con il
    prefisso di qualcun altro: «3331234567» inizia per «33» (Francia) ma è un
    cellulare italiano. Con l'elenco corto di prima «380501234567» (Ucraina)
    riceveva un +39 davanti, mentre il frontend lo leggeva come ucraino: lo
    stesso numero importato da Excel e digitato nell'app erano due persone.
    È la stessa regola di `splitPhone` in frontend/packages/shared/src/phone.js:
    se le due divergono, la stessa persona diventa due schede e i promemoria
    partono verso un numero che non esiste (39 39 333…).
    """
    if len(digits) <= NATIONAL_MAX_DIGITS:
        return False
    return _country_code(digits) is not None


def _drop_trunk_zero(digits: str) -> str:
    """Toglie l'eventuale 0 interurbano dopo il country code, dove serve.

    Un prefisso non assegnato lascia il numero intatto: accorciare senza sapere
    dove finisce il prefisso è peggio che non toccare.
    """
    cc = _country_code(digits)
    if cc is None or cc in TRUNK_ZERO_KEPT:
        return digits
    rest = digits[len(cc):]
    if not rest.startswith("0"):
        return digits
    return cc + rest[1:]


def _drop_repeated_italian_prefix(digits: str) -> str:
    """«+39 39 333 1234567» → «+39 333 1234567».

    Dopo il +39 un numero italiano ha al più 11 cifre: 12 o più che cominciano
    ancora per 39 sono il prefisso scritto due volte (PhoneInput con la
    bandiera IT e «39 333…» digitato a mano, gli export con il prefisso già
    dentro). Passava per valido: seconda identità, OTP verso un numero che non
    esiste (06-11). «+39 393 1234567» (10 cifre) è un cellulare vero e resta.
    """
    national = digits[2:]
    if digits.startswith("39") and len(national) > NATIONAL_MAX_DIGITS and national.startswith("39"):
        return "39" + national[2:]
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
    digits = _drop_repeated_italian_prefix(_drop_trunk_zero(digits))
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
