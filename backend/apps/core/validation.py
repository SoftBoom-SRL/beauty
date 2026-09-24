"""Validazione di ciò che il titolare scrive nelle impostazioni del salone e nelle regole caparra.

Stava in core/api.py fra un endpoint e l'altro, lunga il doppio degli
endpoint stessi: chi aggiungeva un'impostazione doveva trovare il punto giusto
in mezzo al PUT. Qui ci sono i limiti dei campi, i messaggi d'errore (400, in
italiano: la dashboard li mostra così come sono) e la normalizzazione dei
valori; gli endpoint leggono e salvano.
"""

import re
from decimal import Decimal, InvalidOperation

from django.core.exceptions import ValidationError
from django.core.validators import URLValidator
from ninja.errors import HttpError

from common.money import MAX_MONEY

from .models import DepositRule, Salon, SalonSettings
from .schemas import DepositRuleIn
from .services import normalize_opening_hours_week, opening_hours_text

# Limiti dei campi numerici delle impostazioni: [min, max] INCLUSI. Senza,
# `int(None)` esplodeva con un 500 e un valore fuori scala finiva a database su
# colonne PositiveSmallInteger (che su Postgres si ferma a 32767).
_SETTINGS_INT_RANGES = {
    "slot_interval_min": (15, 30),
    "lastminute_discount_cap": (0, 100),
    "flexible_window_min": (0, 24 * 60),
    "flexible_reward_pct": (0, 100),
    "deposit_hold_minutes": (0, 7 * 24 * 60),
    "deposit_reminder_minutes": (0, 7 * 24 * 60),
    # Oltre i dieci minuti non è più un ritardo di sicurezza: è un messaggio che
    # la cliente riceve quando non se lo aspetta più.
    "automation_delay_seconds": (0, 600),
}
# `\Z` e non `$`: con `.match`, `$` accetta anche un a capo finale, e
# «#AABBCC\n» arrivava a una colonna di sette caratteri (500 su PostgreSQL).
_BRAND_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}\Z")
MAX_OPENING_HOURS_CHARS = 500


def validate_url(raw: str, label: str) -> str:
    """URL assoluto http/https, o stringa vuota per cancellarlo.

    Il valore viene reso come `href` nell'app pubblica delle clienti: un
    "javascript:…" o un "www.qualcosa" finivano tali e quali nel link.
    """
    value = (raw or "").strip()
    if not value:
        return ""
    if len(value) > 200:
        raise HttpError(400, f"{label} troppo lungo (max 200 caratteri)")
    try:
        URLValidator(schemes=["http", "https"])(value)
    except ValidationError:
        raise HttpError(400, f"{label} non valido: serve un indirizzo http(s) completo")
    return value


def clean_settings_payload(payload: dict, current: SalonSettings) -> tuple[dict, str | None]:
    """Il corpo di PUT /settings validato e normalizzato, più la lingua del salone.

    `payload` è `data.dict(exclude_unset=True)`; `current` sono le impostazioni
    lette a inizio richiesta, per gli invarianti fra campi (sollecito prima
    della scadenza della caparra). Ritorna (campi da scrivere, lingua o None).
    Il primo valore non valido risponde 400, nell'ordine di prima.
    """
    default_lang = payload.pop("default_lang", None)
    if default_lang is not None and default_lang not in Salon.Lang.values:
        raise HttpError(400, "Lingua non valida (it o en)")
    # I campi sono tutti Optional nello schema, quindi `exclude_unset` lascia
    # passare i null mandati esplicitamente: finivano per `setattr` su colonne
    # NOT NULL (IntegrityError) o dentro `int()` (500). Un null significa «non
    # tocco questo campo», non «azzeralo».
    payload = {k: v for k, v in payload.items() if v is not None}
    if "slot_interval_min" in payload and payload["slot_interval_min"] not in (15, 20, 30):
        raise HttpError(400, "Intervallo fasce orarie non valido (15, 20 o 30 minuti)")
    for key, (low, high) in _SETTINGS_INT_RANGES.items():
        if key in payload:
            try:
                value = int(payload[key])
            except (TypeError, ValueError):
                raise HttpError(400, f"Valore non numerico per {key}")
            if not low <= value <= high:
                raise HttpError(400, f"Valore fuori scala per {key} ({low}–{high})")
            payload[key] = value
    for key, choices in (
        ("agenda_fill", SalonSettings.AgendaFill.values),
        ("slot_recovery", SalonSettings.SlotRecovery.values),
    ):
        if key in payload and payload[key] not in choices:
            raise HttpError(400, f"Valore non valido per {key}: usa {' o '.join(choices)}")
    if "brand_color" in payload and not _BRAND_COLOR_RE.match(str(payload["brand_color"])):
        raise HttpError(400, "Colore non valido: usa il formato #RRGGBB")
    if "opening_hours" in payload:
        text = str(payload["opening_hours"])
        if len(text) > MAX_OPENING_HOURS_CHARS:
            raise HttpError(400, f"Orari troppo lunghi (max {MAX_OPENING_HOURS_CHARS} caratteri)")
        payload["opening_hours"] = text
    if "lastminute_monthly_budget" in payload:
        try:
            budget = Decimal(str(payload["lastminute_monthly_budget"]))
        except (InvalidOperation, TypeError, ValueError):
            raise HttpError(400, "Budget non valido")
        if not 0 <= budget <= MAX_MONEY:
            raise HttpError(400, "Budget fuori scala")
        payload["lastminute_monthly_budget"] = budget
    if "privacy_policy_url" in payload:
        payload["privacy_policy_url"] = validate_url(
            payload["privacy_policy_url"], "Indirizzo dell'informativa privacy"
        )
    # L'invariante va verificata sui valori EFFETTIVI dopo il salvataggio, non
    # solo quando arriva il sollecito: abbassando la sola scadenza il sollecito
    # restava oltre, non partiva più e in Impostazioni continuava a comparire.
    hold = payload.get("deposit_hold_minutes", current.deposit_hold_minutes)
    reminder = payload.get("deposit_reminder_minutes", current.deposit_reminder_minutes)
    if hold and reminder and reminder >= hold:
        raise HttpError(
            400,
            "Il sollecito deve precedere la scadenza della caparra: "
            f"riduci anche il sollecito sotto i {hold} minuti",
        )
    for key in ("cancel_reasons", "no_show_reasons"):
        if key in payload:
            cleaned = [str(x).strip()[:80] for x in (payload[key] or []) if str(x).strip()]
            if len(cleaned) > 30:
                raise HttpError(400, "Troppe motivazioni (max 30)")
            payload[key] = cleaned
    if "opening_hours_week" in payload:
        try:
            payload["opening_hours_week"] = normalize_opening_hours_week(payload["opening_hours_week"])
        except ValueError as exc:
            raise HttpError(400, str(exc))
        # il testo per l'app cliente segue gli orari strutturati, salvo testo esplicito
        if "opening_hours" not in payload:
            payload["opening_hours"] = opening_hours_text(payload["opening_hours_week"])
    return payload, default_lang


def deposit_rule_fields(data: DepositRuleIn) -> dict:
    """Campi della regola, validati.

    Lo schema accettava qualunque importo: convertendo una regola da «Importo
    fisso» 150 € a «% del totale» la dashboard salvava un acconto del 150 %, e
    `compute_deposit` chiedeva come caparra l'intero prezzo del servizio.
    """
    fields = data.dict()
    if fields["amount_type"] not in DepositRule.AmountType.values:
        raise HttpError(400, "Tipo di acconto non valido: usa pct o fixed")
    amount = fields["amount"]
    if amount < 0:
        raise HttpError(400, "L'acconto non può essere negativo")
    if fields["amount_type"] == DepositRule.AmountType.PERCENT and amount > 100:
        raise HttpError(400, "Un acconto in percentuale va da 0 a 100")
    if amount > MAX_MONEY:
        raise HttpError(400, "Importo dell'acconto fuori scala")
    return fields
