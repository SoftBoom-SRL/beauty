"""Controlli dei valori che arrivano dal client e finiscono grezzi in colonne strette.

Senza questi controlli un colore di venti caratteri o un ordine negativo non
sono un errore della richiesta ma un errore del database: 500, e chi compila il
modulo non sa quale campo rifare. Catalogo, magazzino e staff li scrivevano
ciascuno per conto proprio, con la stessa espressione regolare e gli stessi
messaggi: qui sono una volta sola, con quei messaggi.

Restano fuori, di proposito, i colori validati altrove con una loro
espressione (il programma fedeltà in marketing, le impostazioni del salone:
anche lì chiusa come `HEX_COLOR_RE`, che non accetta l'a capo finale) o dallo
schema (etichette cliente): messaggi e codici diversi, non copie di questa.
"""

import re

from ninja.errors import HttpError

# `\Z` e non `$`: `$` lascerebbe passare anche un a capo finale, e la colonna
# del colore è di sette caratteri. Si usa con `.match`, che ancora già l'inizio.
HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}\Z")

# Tetti delle colonne intere positive: oltre, il database rifiuta la riga.
MAX_POSITIVE_SMALL_INT = 32767  # PositiveSmallIntegerField
MAX_POSITIVE_INT = 2147483647  # PositiveIntegerField


def require_hex_color(value: str) -> None:
    """400 se `value` non è esattamente un colore #RRGGBB (il chiamante toglie gli spazi)."""
    if not HEX_COLOR_RE.match(value):
        raise HttpError(400, "Colore non valido (atteso #RRGGBB)")


def validate_category_in(data, *, max_order: int) -> None:
    """Ordine e colore di una categoria (listino, magazzino): 400 invece di 500.

    `data.order` va da 0 a `max_order`, il tetto della colonna del modello.
    `data.color` None vuol dire «non toccare il colore» e non si controlla.
    """
    if not (0 <= data.order <= max_order):
        raise HttpError(400, "Ordine della categoria non valido")
    if data.color is not None:
        require_hex_color((data.color or "").strip())
