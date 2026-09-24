"""Ricerca in anagrafica: nome e cognome senza accenti, telefono comunque scritto.

`search_filter` è il filtro della lista clienti. `strip_accents` e
`APOSTROPHE_CLASS` servono anche all'import CSV, che riconosce la stessa persona
con le stesse regole: una lettera accentata o un apostrofo tipografico non
fanno di «D’Amico» un'altra persona.
"""

import re
import unicodedata

from django.db.models import Q

from common.phone import phone_key

# Ricerca senza accenti: «nicolo» deve trovare «Nicolò» e «d'amico» la
# «D’Amico» scritta con l'apostrofo tipografico (quello che mettono iPhone e
# Word). `icontains` confronta i caratteri come sono, su PostgreSQL come su
# SQLite (06-16, 13-22). Ogni lettera della ricerca diventa la classe delle sue
# varianti accentate e la parola si cerca con `iregex`: in produzione è `~*`
# di PostgreSQL, nei test la REGEXP che Django registra su SQLite, senza
# estensioni da installare (unaccent vorrebbe i privilegi per crearla).
APOSTROPHES = "'’‘ʼ`´"
APOSTROPHE_CLASS = f"[{APOSTROPHES}]"
# Lettere senza scomposizione Unicode che si leggono come la lettera base.
_EXTRA_VARIANTS = {"o": "øØ", "l": "łŁ", "d": "đĐ", "i": "ı"}


def _letter_classes() -> dict[str, str]:
    variants: dict[str, set] = {}
    for code in range(0x00C0, 0x0250):  # Latin-1, Latin esteso A e B
        ch = chr(code)
        base = unicodedata.normalize("NFKD", ch)[0]
        if base.isascii() and base.isalpha() and ch != base:
            variants.setdefault(base.lower(), set()).add(ch)
    for base, extra in _EXTRA_VARIANTS.items():
        variants.setdefault(base, set()).update(extra)
    return {
        base: "[" + base + base.upper() + "".join(sorted(chars)) + "]"
        for base, chars in variants.items()
    }


_LETTER_CLASSES = _letter_classes()


def strip_accents(text: str) -> str:
    """Il testo senza segni diacritici: «Nicolò» → «Nicolo» (NFKD, poi via i segni combinanti)."""
    return "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))


def _accent_insensitive(word: str) -> str:
    """Espressione regolare che trova `word` con o senza accenti e apostrofi tipografici."""
    plain = strip_accents(word).lower()
    parts = []
    for ch in plain:
        for base, extra in _EXTRA_VARIANTS.items():
            if ch in extra:
                ch = base
        if ch in APOSTROPHES:
            parts.append(APOSTROPHE_CLASS)
        elif ch in _LETTER_CLASSES:
            parts.append(_LETTER_CLASSES[ch])
        else:
            parts.append(re.escape(ch))
    return "".join(parts)


def search_filter(q: str) -> Q:
    """Filtro della ricerca in anagrafica: nome completo e numero formattato.

    Il filtro campo per campo non trovava né «Sofia Ricci» (nessuna colonna
    contiene nome e cognome insieme) né «+39 333 123 4567» (in archivio il
    numero è E.164 senza separatori). Chi non trova la cliente ne crea una
    seconda e si vede rifiutare il telefono senza capire perché.

    Ogni parola deve comparire da qualche parte nella scheda (AND fra le
    parole, OR fra i campi): «Sofia Ricci» trova solo Sofia Ricci, non tutte
    le Sofia. Nome e cognome si confrontano senza accenti né apostrofi
    tipografici. Il numero si cerca sulla chiave normalizzata, la stessa che
    riconosce la cliente al login.
    """
    words = [w for w in q.split() if w]
    condition = Q()
    for word in words:
        pattern = _accent_insensitive(word)
        condition &= (
            Q(first_name__iregex=pattern)
            | Q(last_name__iregex=pattern)
            | Q(phone__icontains=word)
            | Q(email__icontains=word)
        )
    key = phone_key(q)
    if key:
        condition |= Q(phone_key__contains=key)
    return condition
