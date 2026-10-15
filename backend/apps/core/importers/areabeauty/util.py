"""Piccoli aiuti comuni ai passi: confronto di nomi, colori, testi."""

import re
import unicodedata

_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def norm(text) -> str:
    """Nome confrontabile: minuscole, senza accenti né punteggiatura, spazi singoli."""
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text).split())


def without_addon_prefix(name: str) -> str:
    """«add on full nail art» → «full nail art»: in AreaBeauty gli aggiuntivi hanno il prefisso."""
    for prefix in ("add on ", "addon ", "add "):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def color(value, default: str) -> str:
    value = (value or "").strip()
    return value.upper() if _HEX.match(value) else default


def clip(value, size: int) -> str:
    return str(value or "").strip()[:size]
