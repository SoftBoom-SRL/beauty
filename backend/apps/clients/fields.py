"""Campi della scheda cliente: dal corpo della richiesta alle colonne del modello.

Compleanno con o senza anno, genere, consensi (i tre flag e le date della prova
del consenso) e i campi del PUT per cui `null` vuol dire «svuota». Li usano la
scheda (POST e PUT) e, per compleanno e genere, l'import CSV.
"""

import datetime as dt
import re
from typing import Optional

from django.utils import timezone
from ninja.errors import HttpError

from common.phone import canonical_phone

from .models import Client
from .schemas import ClientIn


# ---- Compleanno: con o senza anno ----------------------------------------------


def parse_birthday(value) -> tuple[dt.date | None, bool]:
    """Normalizza il compleanno ricevuto dall'API.

    Accetta: None/"" → nessun compleanno; "YYYY-MM-DD" → data completa;
    "--MM-DD" o "MM-DD" (ISO 8601 senza anno) → giorno e mese con anno
    segnaposto BIRTHDAY_YEAR_UNKNOWN e year_known=False.
    Ritorna (date | None, year_known). Solleva 400 se non interpretabile.
    """
    if value in (None, ""):
        return None, True
    if isinstance(value, dt.date):
        return value, True
    raw = str(value).strip()
    m = re.fullmatch(r"-{0,2}(\d{1,2})-(\d{1,2})", raw)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        try:
            return dt.date(Client.BIRTHDAY_YEAR_UNKNOWN, month, day), False
        except ValueError:
            raise HttpError(400, "Compleanno non valido (giorno o mese fuori intervallo)")
    try:
        return dt.date.fromisoformat(raw), True
    except ValueError:
        raise HttpError(400, "Compleanno non valido (atteso YYYY-MM-DD oppure --MM-DD)")


def normalize_gender(value: str) -> str:
    """'female' | 'male' | 'other' | ''. Solleva 400 su valori sconosciuti."""
    v = (value or "").strip().lower()
    if v in ("", "female", "male", "other"):
        return v
    raise HttpError(400, "Genere non valido (female, male, other o vuoto)")


# ---- Consensi e corpo della scheda ---------------------------------------------


# I tre consensi che il resto del prodotto legge come booleani: le audience
# marketing filtrano su `consents__marketing=True` e stripe_service rifiuta
# l'addebito senza `card_charge`. Un "true" di testo o un 1 li facevano
# rispondere in modo diverso a seconda di chi leggeva.
CONSENT_FLAGS = ("privacy", "marketing", "card_charge")


def clean_consents(raw) -> dict:
    """Consensi con i tre flag riportati a booleano.

    Le altre chiavi restano come sono: sono le date della prova del consenso
    (`privacy_at`, `marketing_at`, `marketing_revoked_at`) e le scrive anche
    apps.marketing. Scartarle qui cancellerebbe, al primo salvataggio dalla
    scheda cliente, la traccia di quando il consenso è stato dato o revocato.
    """
    if not isinstance(raw, dict):
        raise HttpError(400, "Consensi non validi")
    cleaned = dict(raw)
    for name in CONSENT_FLAGS:
        if name in cleaned:
            cleaned[name] = bool(cleaned[name])
    return cleaned


def stamped_consents(stored, incoming: dict) -> dict:
    """Consensi dopo una scelta dello staff: i flag dal corpo, le date dal server.

    La scheda Consensi rimandava tutto il dizionario letto all'apertura: le
    date non le scriveva nessuno (la concessione restava senza `privacy_at` /
    `marketing_at`, la revoca lasciava `marketing_at`), benché la modale
    prometta che la scheda «ne conserva la data» (14-14), e la copia vecchia
    cancellava la revoca fatta nel frattempo dall'app (14-05). Ora dal corpo
    si leggono solo i tre flag; quando uno CAMBIA il server scrive
    `<flag>_at` (concesso) o `<flag>_revoked_at` (revocato), come
    `client_set_marketing_consent`. Le altre chiavi restano quelle salvate.
    """
    consents = dict(stored or {})
    now = timezone.now().isoformat()
    for name in CONSENT_FLAGS:
        if name not in incoming:
            continue
        value = bool(incoming[name])
        was = bool(consents.get(name))
        consents[name] = value
        if value == was:
            continue
        if value:
            consents[f"{name}_at"] = now
            consents.pop(f"{name}_revoked_at", None)
        else:
            consents[f"{name}_revoked_at"] = now
            consents[f"{name}_at"] = ""
    return consents


# Campi del PUT per cui `null` significa «svuota»: i testi facoltativi e le
# due date (per `category_ids` vuol dire «lascia le etichette come sono»).
# Sugli altri un null non ha un significato e finirebbe a 500 sulla colonna
# NOT NULL (o, peggio, in archivio come valore che nessuno legge).
_NULL_MEANS_EMPTY = {"last_name": "", "email": "", "origin": "", "gender": ""}
_NULLABLE = {"birthday", "since", "category_ids"}


def client_payload(data: ClientIn, *, partial: bool = False) -> tuple[dict, Optional[list[int]]]:
    """ClientIn → kwargs del modello: compleanno (con/senza anno) e genere validati.

    Con `partial=True` (il PUT) restano solo i campi davvero presenti nel
    corpo. `ClientIn` ha un default per quasi tutto: riversarlo intero su una
    scheda esistente significava che chiunque aggiornasse il solo telefono
    cancellava i consensi (con la prova del consenso privacy), riportava
    l'affidabilità a 100 e riattivava una scheda disattivata. Il chiamante che
    non manda un campo non lo sta svuotando: non lo sta toccando.
    """
    payload = data.dict(exclude_unset=True) if partial else data.dict()
    for name, value in list(payload.items()):
        if value is not None or name in _NULLABLE:
            continue
        if name not in _NULL_MEANS_EMPTY:
            raise HttpError(400, f"Il campo {name} non può essere vuoto")
        payload[name] = _NULL_MEANS_EMPTY[name]
    category_ids = payload.pop("category_ids", None)  # None = lasciare le etichette come sono
    if "phone" in payload:
        # Salvato in E.164 quando riconoscibile: login OTP, import e sync Yourang
        # confrontano lo stesso numero, comunque sia stato digitato.
        payload["phone"] = canonical_phone(payload["phone"])
        if not payload["phone"]:
            raise HttpError(400, "Il telefono è obbligatorio")
    if "gender" in payload:
        payload["gender"] = normalize_gender(payload.get("gender") or "")
    if "birthday" in payload:
        birthday, year_known = parse_birthday(payload.pop("birthday"))
        payload["birthday"] = birthday
        payload["birthday_year_known"] = year_known
    if "consents" in payload:
        payload["consents"] = clean_consents(payload["consents"])
    if "first_name" in payload and not payload["first_name"].strip():
        raise HttpError(400, "Il nome è obbligatorio")
    return payload, category_ids
