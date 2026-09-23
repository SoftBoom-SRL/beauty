"""Anagrafica clienti: etichette, cliente, note interne, schede tecniche.

Letture base → solo `staff_auth`. Scritture → scope "clients" (vedi
common.permissions). Le schede tecniche sono uno storico immutabile: solo
GET (lista) e POST (creazione), nessun endpoint di update/delete.
"""

import logging
import re
import unicodedata
from decimal import Decimal
from typing import Optional

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import File, Form, Router
from ninja.errors import HttpError
from ninja.files import UploadedFile
from ninja.pagination import LimitOffsetPagination, paginate

from apps.agenda.schemas import AppointmentOut
from apps.core.models import Salon, SalonSettings
from apps.core.services import emit_event, log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import require_scope
from common.media import signed_media_url, stored_upload_name, validate_upload
from common.phone import canonical_phone, find_client_by_phone, phone_key
from common.utils import salon_get

from .models import (
    Client,
    ClientCategory,
    ClientNote,
    ClientNoteAttachment,
    TechnicalSheet,
    default_consents,
)
from .schemas import (
    AttachmentOut,
    CategoryIn,
    CategoryOut,
    HookLeadIn,
    HookLeadOut,
    ClientDetailOut,
    ClientIn,
    ClientOut,
    ClientUpdateIn,
    ImportIn,
    ImportOut,
    NoteIn,
    NoteOut,
    NoteUpdateIn,
    OkOut,
    TechnicalSheetIn,
    TechnicalSheetOut,
)
from .services import client_stats, import_rows, normalize_gender, parse_birthday

logger = logging.getLogger("youty.clients")
router = Router(tags=["clients"])


# ---- Etichette (ClientCategory) ---------------------------------------------


@router.get("/categories", auth=staff_auth, response=list[CategoryOut])
def list_categories(request):
    return request.auth.salon.client_categories.all()


DUPLICATE_LABEL = "Esiste già un'etichetta con questo nome"


def _label_payload(ctx, data: CategoryIn, *, exclude_id: Optional[int] = None) -> dict:
    """CategoryIn ripulito, con il nome unico nel salone senza badare alle maiuscole.

    Un nome già usato (o il doppio clic su «Salva») arrivava al vincolo del
    database e usciva come 500 (06-12). E «VIP» accanto a «vip» sono due
    etichette che le condizioni non distinguono: `contains` confronta i nomi
    senza maiuscole.
    """
    payload = data.dict()
    payload["name"] = payload["name"].strip()
    if not payload["name"]:
        raise HttpError(400, "Il nome dell'etichetta è obbligatorio")
    same = ClientCategory.objects.filter(salon=ctx.salon, name__iexact=payload["name"])
    if exclude_id is not None:
        same = same.exclude(id=exclude_id)
    if same.exists():
        raise HttpError(400, DUPLICATE_LABEL)
    return payload


def _cites_label(rule, name: str) -> bool:
    return (
        isinstance(rule, dict)
        and rule.get("field") == "categories"
        and isinstance(rule.get("value"), str)
        and rule["value"].strip().casefold() == name.strip().casefold()
    )


def _label_rules(conditions) -> list:
    if not isinstance(conditions, dict) or not isinstance(conditions.get("rules"), list):
        return []
    return conditions["rules"]


def _rules_citing_label(salon, name: str) -> tuple[list, list]:
    """Regole caparra e automazioni del salone le cui condizioni citano l'etichetta.

    Le condizioni salvano il NOME dell'etichetta (è quello che confronta
    `client_facts`, ed è quello che le automazioni mandano a Yourang).
    """
    from apps.core.models import DepositRule  # lazy: come le altre letture cross-app

    rules = [
        r for r in DepositRule.objects.filter(salon=salon)
        if any(_cites_label(rule, name) for rule in _label_rules(r.conditions))
    ]
    try:
        from apps.automations.models import Automation  # lazy
    except ImportError:
        return rules, []
    automations = [
        a for a in Automation.objects.filter(salon=salon)
        if any(_cites_label(rule, name) for rule in _label_rules(a.conditions))
    ]
    return rules, automations


def _renamed(conditions: dict, old: str, new: str) -> dict:
    return {
        **conditions,
        "rules": [
            {**rule, "value": new} if _cites_label(rule, old) else rule
            for rule in _label_rules(conditions)
        ],
    }


def _rename_label_in_conditions(salon, old: str, new: str) -> tuple[int, int]:
    """Riscrive il nome dell'etichetta nelle condizioni che la citano.

    Rinominare «Da seguire» in «Da seguire!» spegneva in silenzio la regola
    «SE etichetta = Da seguire → caparra 20 €»: alle clienti a rischio non si
    chiedeva più la caparra, e i filtri delle automazioni smettevano di
    scattare (06-06, 01-13, 15-07). Le automazioni aggiornate si rimandano a
    Yourang, che le esegue con le condizioni che ha ricevuto.
    """
    rules, automations = _rules_citing_label(salon, old)
    for rule in rules:
        rule.conditions = _renamed(rule.conditions, old, new)
        rule.save(update_fields=["conditions", "updated_at"])
    if automations:
        try:
            from apps.automations.api import _definition  # lazy: la definizione è la loro
        except ImportError:
            _definition = None
        for automation in automations:
            automation.conditions = _renamed(automation.conditions, old, new)
            automation.save(update_fields=["conditions", "updated_at"])
            if _definition is not None:
                emit_event(salon, "automation.updated", _definition(automation))
    return len(rules), len(automations)


@router.post("/categories", auth=staff_auth, response=CategoryOut)
def create_category(request, data: CategoryIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    payload = _label_payload(ctx, data)
    try:
        with transaction.atomic():
            category = ClientCategory.objects.create(salon=ctx.salon, **payload)
    except IntegrityError:
        # Due «Salva» nello stesso istante: il controllo sopra non è atomico.
        raise HttpError(400, DUPLICATE_LABEL)
    log_activity(
        ctx.salon,
        "client_category.created",
        f"Etichetta creata: {category.name}",
        actor=ctx.user,
        payload={"category_id": category.id},
    )
    return category


@router.put("/categories/{int:category_id}", auth=staff_auth, response=CategoryOut)
def update_category(request, category_id: int, data: CategoryIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    category = salon_get(ClientCategory, ctx, category_id)
    old_name = category.name
    payload = _label_payload(ctx, data, exclude_id=category.id)
    with transaction.atomic():
        for name, value in payload.items():
            setattr(category, name, value)
        try:
            with transaction.atomic():
                category.save()
        except IntegrityError:
            raise HttpError(400, DUPLICATE_LABEL)
        rules = automations = 0
        if category.name != old_name:
            rules, automations = _rename_label_in_conditions(ctx.salon, old_name, category.name)
        summary = (
            f"Etichetta rinominata: {old_name} → {category.name}"
            if category.name != old_name
            else f"Etichetta aggiornata: {category.name}"
        )
        if rules or automations:
            summary += f" (condizioni aggiornate: {rules} regole caparra, {automations} automazioni)"
        log_activity(
            ctx.salon,
            "client_category.updated",
            summary,
            actor=ctx.user,
            payload={"category_id": category.id},
        )
    return category


@router.delete("/categories/{int:category_id}", auth=staff_auth, response=OkOut)
def delete_category(request, category_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    category = salon_get(ClientCategory, ctx, category_id)
    name = category.name
    # Eliminata l'etichetta, la regola che la cita non scatta più per nessuna,
    # senza che niente lo dica — lo stesso silenzio del rinomina. Togliere la
    # condizione al posto del titolare sarebbe peggio: in una regola «E» il
    # resto varrebbe per tutte le clienti. Prima si sistemano le regole.
    rules, automations = _rules_citing_label(ctx.salon, name)
    if rules or automations:
        used_by = [f"regola caparra «{r.name}»" for r in rules] + [
            f"automazione «{a.name}»" for a in automations
        ]
        more = f" e altre {len(used_by) - 3}" if len(used_by) > 3 else ""
        raise HttpError(
            400,
            f"L'etichetta «{name}» è usata da {', '.join(used_by[:3])}{more}: "
            "togli la condizione da lì, poi eliminala.",
        )
    category.delete()
    log_activity(
        ctx.salon,
        "client_category.deleted",
        f"Etichetta eliminata: {name}",
        actor=ctx.user,
        payload={"category_id": category_id},
    )
    return OkOut()


# ---- Cliente ------------------------------------------------------------------


def _set_categories(client: Client, category_ids: list[int]) -> bool:
    """Etichette della scheda = quelle indicate (del salone). True se sono cambiate."""
    categories = list(ClientCategory.objects.filter(salon=client.salon_id, id__in=category_ids))
    before = set(client.categories.values_list("id", flat=True))
    client.categories.set(categories)
    return before != {c.id for c in categories}


DUPLICATE_PHONE = "Telefono già registrato per un altro cliente"


def _archived_phone_message(holder: Client, *, creating: bool = True) -> str:
    if creating:
        return (
            f"Il numero è di una scheda archiviata: {holder.full_name}. "
            "Riattivala invece di crearne un'altra."
        )
    return f"Il numero è già di una scheda archiviata: {holder.full_name}."


def _check_phone_unique(ctx, phone: str, *, exclude_id: Optional[int] = None) -> Optional[Client]:
    """Il numero è unico per salone comunque sia scritto (+39 / spazi / 0039).

    Ritorna la scheda ARCHIVIATA che ha già quel numero (il chiamante decide
    come indicarla), solleva 400 se il numero è di una scheda attiva.
    """
    holder = find_client_by_phone(ctx.salon, phone, exclude_id=exclude_id)
    if holder is None:
        return None
    if not holder.is_active:
        return holder
    raise HttpError(400, DUPLICATE_PHONE)


# Ricerca senza accenti: «nicolo» deve trovare «Nicolò» e «d'amico» la
# «D’Amico» scritta con l'apostrofo tipografico (quello che mettono iPhone e
# Word). `icontains` confronta i caratteri come sono, su PostgreSQL come su
# SQLite (06-16, 13-22). Ogni lettera della ricerca diventa la classe delle sue
# varianti accentate e la parola si cerca con `iregex`: in produzione è `~*`
# di PostgreSQL, nei test la REGEXP che Django registra su SQLite, senza
# estensioni da installare (unaccent vorrebbe i privilegi per crearla).
_APOSTROPHES = "'’‘ʼ`´"
_APOSTROPHE_CLASS = f"[{_APOSTROPHES}]"
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


def _accent_insensitive(word: str) -> str:
    """Espressione regolare che trova `word` con o senza accenti e apostrofi tipografici."""
    plain = "".join(
        ch for ch in unicodedata.normalize("NFKD", word) if not unicodedata.combining(ch)
    ).lower()
    parts = []
    for ch in plain:
        for base, extra in _EXTRA_VARIANTS.items():
            if ch in extra:
                ch = base
        if ch in _APOSTROPHES:
            parts.append(_APOSTROPHE_CLASS)
        elif ch in _LETTER_CLASSES:
            parts.append(_LETTER_CLASSES[ch])
        else:
            parts.append(re.escape(ch))
    return "".join(parts)


def _search_filter(q: str) -> Q:
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


@router.get("/", auth=staff_auth, response=list[ClientOut])
@paginate(LimitOffsetPagination)
def list_clients(
    request,
    q: str = "",
    category_id: Optional[int] = None,
    reliability_min: Optional[int] = None,
    reliability_max: Optional[int] = None,
    is_active: Optional[bool] = None,
):
    ctx = request.auth
    qs = Client.objects.filter(salon=ctx.salon).prefetch_related("categories")
    if q:
        qs = qs.filter(_search_filter(q))
    if category_id is not None:
        qs = qs.filter(categories__id=category_id)
    if reliability_min is not None:
        qs = qs.filter(reliability__gte=reliability_min)
    if reliability_max is not None:
        qs = qs.filter(reliability__lte=reliability_max)
    if is_active is not None:
        qs = qs.filter(is_active=is_active)
    return qs.distinct()


# I tre consensi che il resto del prodotto legge come booleani: le audience
# marketing filtrano su `consents__marketing=True` e stripe_service rifiuta
# l'addebito senza `card_charge`. Un "true" di testo o un 1 li facevano
# rispondere in modo diverso a seconda di chi leggeva.
CONSENT_FLAGS = ("privacy", "marketing", "card_charge")


def _clean_consents(raw) -> dict:
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


def _stamped_consents(stored, incoming: dict) -> dict:
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


def _client_payload(data: ClientIn, *, partial: bool = False) -> tuple[dict, Optional[list[int]]]:
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
        payload["consents"] = _clean_consents(payload["consents"])
    if "first_name" in payload and not payload["first_name"].strip():
        raise HttpError(400, "Il nome è obbligatorio")
    return payload, category_ids


@router.post("/", auth=staff_auth, response=ClientOut)
def create_client(request, data: ClientIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    payload, category_ids = _client_payload(data)
    phone = payload["phone"]
    archived = _check_phone_unique(ctx, phone)
    if archived is not None:
        # Cliente archiviata che richiama per prenotare: la ricerca della
        # dashboard mostra solo le attive e la creazione rispondeva «già
        # registrato» senza dire da chi — un vicolo cieco (06-02). Non la si
        # riattiva da qui: il numero può essere passato a un'altra persona, che
        # entrerebbe nello storico di chi non è più cliente. Si indica la
        # scheda (409 con il suo id) e la riattivazione resta una scelta dello
        # staff: PUT {"is_active": true}.
        return JsonResponse(
            {
                "detail": _archived_phone_message(archived),
                "archived_client_id": archived.id,
                "archived_client_name": archived.full_name,
            },
            status=409,
        )
    # Le date dei consensi le scrive il server, come sul PUT (14-14).
    payload["consents"] = _stamped_consents(default_consents(), payload.get("consents") or {})
    if not payload.get("since"):
        # Cliente dal giorno in cui è entrata in rubrica. Nessuna via di
        # creazione la valorizzava e il KPI «nuovi clienti» restava a zero per
        # sempre; chi importa uno storico può sempre correggerla dopo.
        payload["since"] = timezone.localdate()
    try:
        with transaction.atomic():
            client = Client.objects.create(salon=ctx.salon, **payload)
    except IntegrityError:
        # Il controllo qui sopra non è atomico: due salvataggi simultanei dello
        # stesso numero lo superano entrambi e a fermarli è il vincolo del
        # database. Meglio il 400 «già registrato» di un 500 sulla violazione.
        raise HttpError(400, DUPLICATE_PHONE)
    _set_categories(client, category_ids or [])
    log_activity(
        ctx.salon,
        "client.created",
        f"Cliente creato: {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id},
    )
    return client


@router.get("/{int:client_id}", auth=staff_auth, response=ClientDetailOut)
def get_client(request, client_id: int):
    ctx = request.auth
    client = salon_get(Client, ctx, client_id)
    # Spesa totale, numero di visite e ultima visita sono dati di cassa: li
    # vede solo chi ha il permesso «vendite», come sulla lista degli incassi.
    # A chi non ce l'ha la scheda arriva completa, con i contatori a zero.
    may_see = ctx.is_owner or "sales" in ctx.scopes
    if may_see:
        stats = client_stats(client)
    else:
        stats = {"visits": 0, "total_spent": Decimal("0"), "last_visit": None}
    client.visits = stats["visits"]
    client.total_spent = stats["total_spent"]
    client.last_visit = stats["last_visit"]
    # Senza questo flag l'interfaccia mostrava «0 visite · 0 € spesi» a chi non
    # ha il permesso vendite: una cliente storica sembrava alla prima visita, e
    # l'operatrice rischiava di trattarla come tale (caparra compresa). Zero e
    # «non visibile» devono restare distinguibili.
    client.stats_hidden = not may_see
    return client


@router.put("/{int:client_id}", auth=staff_auth, response=ClientOut)
def update_client(request, client_id: int, data: ClientUpdateIn):
    """Applica i soli campi presenti nel corpo e scrive le sole colonne cambiate (C15).

    Il salvataggio completo riscriveva la scheda letta a inizio richiesta —
    e il corpo completo della dashboard quella letta all'apertura della
    scheda: lingua, email, promemoria e consensi cambiati nel frattempo
    dall'app tornavano indietro, e con loro i dati Stripe scritti dal webhook
    (18-07).
    """
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    payload, category_ids = _client_payload(data, partial=True)
    phone = payload.get("phone")
    if phone and phone != client.phone:
        archived = _check_phone_unique(ctx, phone, exclude_id=client.id)
        if archived is not None:
            raise HttpError(400, _archived_phone_message(archived, creating=False))
    with transaction.atomic():
        # Riletta sotto lock: i consensi si fondono con quelli salvati, e una
        # revoca arrivata dall'app un istante prima non deve tornare indietro.
        client = Client.objects.select_for_update().get(pk=client.pk)
        marketing_before = bool((client.consents or {}).get("marketing"))
        if "consents" in payload:
            payload["consents"] = _stamped_consents(client.consents, payload["consents"])
        changed = [name for name, value in payload.items() if getattr(client, name) != value]
        for name in changed:
            setattr(client, name, payload[name])
        if changed:
            try:
                with transaction.atomic():
                    client.save(update_fields=changed)
            except IntegrityError:
                raise HttpError(400, DUPLICATE_PHONE)
        if category_ids is not None and _set_categories(client, category_ids):
            changed.append("category_ids")
        if changed:
            reactivated = "is_active" in changed and client.is_active
            log_activity(
                ctx.salon,
                "client.updated",
                f"Cliente {'riattivato' if reactivated else 'aggiornato'}: {client.full_name}",
                actor=ctx.user,
                payload={"client_id": client.id, "fields": changed},
            )
        # Il consenso marketing tolto dalla scheda vale anche per le campagne
        # già programmate, e una scheda disattivata esce dagli invii in coda
        # (07-03, GDPR art. 7.3): la destinataria fissata al «Programma» di
        # lunedì riceveva comunque la promozione di sabato.
        marketing_after = bool((client.consents or {}).get("marketing"))
        if marketing_after != marketing_before:
            _marketing_hook("marketing_consent_changed", client, accepted=marketing_after)
        if payload.get("is_active") is False:
            _marketing_hook("drop_from_pending_sends", client)
    return client


@router.delete("/{int:client_id}", auth=staff_auth, response=OkOut)
def delete_client(request, client_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    with transaction.atomic():
        client.is_active = False
        client.save(update_fields=["is_active"])
        log_activity(
            ctx.salon,
            "client.deleted",
            f"Cliente disattivato: {client.full_name}",
            actor=ctx.user,
            payload={"client_id": client.id},
        )
        # Archiviata = fuori anche dagli invii marketing non ancora partiti (07-03).
        _marketing_hook("drop_from_pending_sends", client)
    return OkOut()


def _marketing_hook(name: str, *args, **kwargs) -> None:
    """Chiama `apps.marketing.services.<name>`, se c'è.

    Le due funzioni (marketing_consent_changed, drop_from_pending_sends)
    appartengono al marketing: un'installazione che non le ha ancora non deve
    perdere il salvataggio della scheda, ma deve lasciarne traccia nei log.
    """
    try:
        from apps.marketing import services as marketing_services  # lazy: evita cicli

        hook = getattr(marketing_services, name)
    except (ImportError, AttributeError):
        logger.warning("clients: apps.marketing.services.%s non disponibile", name)
        return
    hook(*args, **kwargs)


@router.post("/import", auth=staff_auth, response=ImportOut)
def import_clients(request, data: ImportIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    result = import_rows(
        ctx.salon,
        [row.dict() for row in data.rows],
        update_existing=data.update_existing,
        actor=ctx.user,
    )
    log_activity(
        ctx.salon,
        "client.imported",
        f"Import clienti: {result['created']} creati, {result['updated']} aggiornati, {result['skipped']} saltati",
        actor=ctx.user,
        payload={k: result[k] for k in ("created", "updated", "skipped")},
    )
    return result


# ---- Storico appuntamenti (staff) -----------------------------------------------


@router.get("/{int:client_id}/appointments", auth=staff_auth, response=list[AppointmentOut])
def list_client_appointments(request, client_id: int):
    """Storico appuntamenti del cliente (passati e futuri), ordinati cronologicamente.

    Riusa la serializzazione di apps.agenda.api._appointment_out; import lazy
    per evitare dipendenze a livello di modulo tra le due app di dominio.
    """
    ctx = request.auth
    # Stessa invariante di storico, note e schede: l'elenco delle visite di una
    # persona è un dato della sua scheda, non dell'agenda del giorno.
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)

    from apps.agenda.api import _appointment_out, gift_index  # lazy: riuso serializzazione esistente
    from apps.agenda.models import Appointment  # lazy: evita import cross-app a livello modulo

    appointments = (
        Appointment.objects.filter(salon=ctx.salon, client=client)
        .select_related("client", "operator", "salon")
        .prefetch_related("items__service", "items__operator")
        .order_by("start")
    )
    # Indice delle gift card calcolato una volta sola: senza, _appointment_out
    # ne interroga una per appuntamento (più una SELECT sul salone, che non era
    # in select_related). Una cliente con 80 visite costava 160 query in più.
    gifts = gift_index(ctx.salon, [client.id])
    return [_appointment_out(a, gifts) for a in appointments]


# ---- Storico unificato (visite + note + schede) ---------------------------------


def _note_out(note: ClientNote) -> dict:
    author = getattr(note, "author", None)
    return {
        "id": note.id,
        "client_id": note.client_id,
        "appointment_id": note.appointment_id,
        "text": note.text,
        "visibility": note.visibility,
        "author_id": note.author_id,
        "author_name": (author.get_full_name() or author.email) if author else "",
        "attachments": [_attachment_out(a) for a in note.attachments.all()],
        "created_at": note.created_at,
        "updated_at": note.updated_at,
    }


def _attachment_out(att: ClientNoteAttachment) -> dict:
    # URL firmato e a scadenza: gli allegati delle note sono riservati e il
    # download sotto /media/ non passa dall'autenticazione delle API.
    return {
        "id": att.id,
        "name": att.name,
        "url": signed_media_url(att.file),
        "content_type": att.content_type,
        "size": att.size,
        "is_image": att.is_image,
        "created_at": att.created_at,
    }


def _sheet_out(sheet: TechnicalSheet) -> dict:
    author = getattr(sheet, "author", None)
    return {
        "id": sheet.id,
        "client_id": sheet.client_id,
        "appointment_id": sheet.appointment_id,
        "category": sheet.category,
        "treatment": sheet.treatment,
        "zone": sheet.zone,
        "products": sheet.products,
        "params": sheet.params,
        "outcome": sheet.outcome,
        "duration_hold": sheet.duration_hold,
        "advice": sheet.advice,
        "protocol": sheet.protocol,
        "next_step": sheet.next_step,
        "photo": signed_media_url(sheet.photo) if sheet.photo else None,
        "author_id": sheet.author_id,
        "author_name": (author.get_full_name() or author.email) if author else "",
        "created_at": sheet.created_at,
    }


@router.get("/{int:client_id}/history", auth=staff_auth)
def client_history(request, client_id: int):
    """Storico completo del cliente in un'unica timeline (più recente prima).

    Voci: `visit` (appuntamento con servizi, operatrici, stato, incasso,
    caparra `deposit_sale`, nota appuntamento + note di trattamento e schede
    tecniche collegate), `sale` (vendita al banco senza appuntamento), `note`
    e `sheet` non legate a una visita. Gli appuntamenti futuri hanno
    `upcoming: true`. `sales_hidden` dice se gli incassi sono stati omessi
    perché chi legge non ha il permesso «vendite».
    """
    ctx = request.auth
    # Storico, note e schede sono i dati più sensibili che il gestionale
    # conserva: leggerli richiede il permesso «clienti», come scriverli.
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)

    from apps.agenda.api import _appointment_out, gift_index  # lazy: riuso serializzazione
    from apps.agenda.models import Appointment  # lazy
    from apps.sales.api import _sale_out  # lazy
    from apps.sales.models import Sale  # lazy

    # Gli incassi di ogni visita sono dati di cassa: senza il permesso
    # «vendite» la timeline resta completa ma senza importi, come la lista
    # degli incassi che a quel ruolo è già preclusa.
    can_read_sales = ctx.is_owner or "sales" in ctx.scopes

    appointments = list(
        Appointment.objects.filter(salon=ctx.salon, client=client)
        .select_related("client", "operator", "salon")
        .prefetch_related("items__service", "items__operator")
        .order_by("-start")
    )
    # Una lista sola: la stessa query girava due volte, e l'indice delle gift
    # card va calcolato una volta per tutte (vedi list_client_appointments).
    gifts = gift_index(ctx.salon, [client.id])
    all_sales = (
        list(Sale.objects.filter(salon=ctx.salon, client=client).select_related("client"))
        if can_read_sales
        else []
    )
    sales = {s.appointment_id: s for s in all_sales if s.appointment_id}
    # La vendita-caparra non ha `appointment` (resta libero per il conto
    # finale) ma `deposit_appointment`: finiva fra le vendite al banco e lo
    # storico mostrava una «Vendita al banco» da 30 € accanto alla visita che
    # quei 30 € li aveva già detratti. È l'anticipo di quella visita, e lì sta.
    visit_ids = {a.id for a in appointments}
    deposits = {
        s.deposit_appointment_id: s for s in all_sales if s.deposit_appointment_id in visit_ids
    }
    counter_sales = [
        s for s in all_sales if not s.appointment_id and s.deposit_appointment_id not in visit_ids
    ]
    notes = list(client.notes.select_related("author").prefetch_related("attachments"))
    sheets = list(client.sheets.select_related("author"))
    notes_by_appt: dict = {}
    for n in notes:
        if n.appointment_id:
            notes_by_appt.setdefault(n.appointment_id, []).append(n)
    sheets_by_appt: dict = {}
    for sh in sheets:
        if sh.appointment_id:
            sheets_by_appt.setdefault(sh.appointment_id, []).append(sh)

    now = timezone.now()
    entries = []
    for a in appointments:
        sale = sales.get(a.id)
        deposit = deposits.get(a.id)
        entries.append(
            {
                "kind": "visit",
                "date": a.start,
                "upcoming": a.start >= now and a.status in ("confirmed", "checked_in", "in_progress"),
                "appointment": _appointment_out(a, gifts),
                "operator_name": f"{a.operator.first_name} {a.operator.last_name}".strip() if a.operator_id else "",
                "sale": _sale_out(sale) if sale else None,
                "deposit_sale": _sale_out(deposit) if deposit else None,
                "notes": [_note_out(n) for n in notes_by_appt.get(a.id, [])],
                "sheets": [_sheet_out(sh) for sh in sheets_by_appt.get(a.id, [])],
            }
        )
    for s in counter_sales:
        entries.append({"kind": "sale", "date": s.created_at, "sale": _sale_out(s)})
    for n in notes:
        if not n.appointment_id:
            entries.append({"kind": "note", "date": n.created_at, "note": _note_out(n)})
    for sh in sheets:
        if not sh.appointment_id:
            entries.append({"kind": "sheet", "date": sh.created_at, "sheet": _sheet_out(sh)})
    entries.sort(key=lambda e: e["date"], reverse=True)
    return {
        "client_id": client.id,
        # Senza il permesso «vendite» `sale` è sempre null, anche sulle visite
        # pagate: l'interfaccia lo leggeva come «non incassato» e l'operatrice
        # diceva alla reception che la cliente l'ultima volta non aveva pagato.
        # Come `stats_hidden` sulla scheda: nascosto e assente si distinguono.
        "sales_hidden": not can_read_sales,
        "counts": {
            "visits": sum(1 for e in entries if e["kind"] == "visit" and not e["upcoming"]),
            "upcoming": sum(1 for e in entries if e["kind"] == "visit" and e["upcoming"]),
            "notes": len(notes),
            "sheets": len(sheets),
            "sales": len(sales) + len(counter_sales),
        },
        "entries": entries,
    }


# ---- Note interne (con allegati: foto e documenti) -------------------------------


def _appointment_for(ctx, client: Client, appointment_id):
    if not appointment_id:
        return None
    from apps.agenda.models import Appointment  # lazy

    appointment = Appointment.objects.filter(salon=ctx.salon, client=client, id=appointment_id).first()
    if appointment is None:
        raise HttpError(404, "Appuntamento non trovato per questo cliente")
    return appointment


# Tipi ammessi negli allegati di una nota: quelli del modello, che l'interfaccia
# già dichiara. Il controllo vero (estensione coerente col tipo e nome generato
# dal server) sta in common.media, unico posto dove vive questa regola.
ATTACHMENT_TYPES = ClientNoteAttachment.IMAGE_TYPES + ClientNoteAttachment.DOC_TYPES


def _validate_upload(f: UploadedFile) -> None:
    """Controlla un allegato prima di scrivere qualunque cosa su disco.

    Guardava solo il tipo DICHIARATO dal client — che si falsifica cambiando una
    riga della richiesta — e salvava il file col nome scelto da chi caricava: un
    «foto.png.html» spacciato per image/png finiva su /media/ con estensione
    .html, sullo stesso origin di /admin/.
    """
    validate_upload(f, allowed_types=ATTACHMENT_TYPES, max_bytes=ClientNoteAttachment.MAX_BYTES)


def _attach_files(note: ClientNote, files: list[UploadedFile]) -> None:
    # Prima tutti i controlli, poi le scritture: un file rifiutato a metà elenco
    # lasciava a terra gli allegati già salvati.
    names = [
        stored_upload_name(f, allowed_types=ATTACHMENT_TYPES, max_bytes=ClientNoteAttachment.MAX_BYTES)
        for f in files
    ]
    for f, stored in zip(files, names):
        # Il nome originale resta nel campo descrittivo (è quello che
        # l'operatrice ha scritto e riconosce); sul disco ci va quello nostro.
        att = ClientNoteAttachment(
            note=note,
            name=(f.name or "")[:200],
            content_type=(f.content_type or "")[:100],
            size=f.size,
        )
        att.file.save(stored, f, save=True)


@router.get("/{int:client_id}/notes", auth=staff_auth, response=list[NoteOut])
def list_notes(request, client_id: int):
    ctx = request.auth
    # Storico, note e schede sono i dati più sensibili che il gestionale
    # conserva: leggerli richiede il permesso «clienti», come scriverli.
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    return [_note_out(n) for n in client.notes.select_related("author").prefetch_related("attachments")]


@router.post("/{int:client_id}/notes", auth=staff_auth, response=NoteOut)
def create_note(request, client_id: int, data: NoteIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    if not data.text.strip():
        raise HttpError(400, "Il testo della nota è obbligatorio")
    note = ClientNote.objects.create(
        client=client,
        appointment=_appointment_for(ctx, client, data.appointment_id),
        text=data.text.strip(),
        visibility=data.visibility,
        author=ctx.user,
    )
    log_activity(
        ctx.salon,
        "client.note_added",
        f"Nota aggiunta per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "note_id": note.id},
    )
    return _note_out(note)


@router.post("/{int:client_id}/notes/upload", auth=staff_auth, response=NoteOut)
def create_note_with_files(
    request,
    client_id: int,
    files: list[UploadedFile] = File(...),
    text: str = Form(""),
    visibility: str = Form("private"),
    appointment_id: Optional[int] = Form(None),
):
    """Nota di trattamento con foto/documenti allegati (multipart)."""
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    if not files and not text.strip():
        raise HttpError(400, "Scrivi una nota o allega almeno un file")
    for f in files:
        _validate_upload(f)
    note = ClientNote.objects.create(
        client=client,
        appointment=_appointment_for(ctx, client, appointment_id),
        text=text.strip(),
        # "shared" non è una scelta di ClientNote.Visibility: era ammesso qui e
        # finiva in archivio come valore che nessuna lettura sa interpretare.
        visibility=visibility if visibility in ("private", "ai") else "private",
        author=ctx.user,
    )
    _attach_files(note, files)
    log_activity(
        ctx.salon,
        "client.note_added",
        f"Nota con {len(files)} allegat{'o' if len(files) == 1 else 'i'} per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "note_id": note.id, "attachments": len(files)},
    )
    return _note_out(note)


@router.put("/{int:client_id}/notes/{int:note_id}", auth=staff_auth, response=NoteOut)
def update_note(request, client_id: int, note_id: int, data: NoteUpdateIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = get_object_or_404(ClientNote, pk=note_id, client=client)
    if data.text is not None:
        if not data.text.strip() and not note.attachments.exists():
            raise HttpError(400, "Una nota senza allegati non può essere vuota")
        note.text = data.text.strip()
    if data.visibility is not None:
        note.visibility = data.visibility
    note.save()
    return _note_out(note)


@router.post("/{int:client_id}/notes/{int:note_id}/attachments", auth=staff_auth, response=NoteOut)
def add_attachments(request, client_id: int, note_id: int, files: list[UploadedFile] = File(...)):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = get_object_or_404(ClientNote, pk=note_id, client=client)
    _attach_files(note, files)
    note.save(update_fields=["updated_at"])
    return _note_out(note)


@router.delete(
    "/{int:client_id}/notes/{int:note_id}/attachments/{int:attachment_id}",
    auth=staff_auth,
    response=OkOut,
)
def delete_attachment(request, client_id: int, note_id: int, attachment_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    att = get_object_or_404(ClientNoteAttachment, pk=attachment_id, note_id=note_id, note__client=client)
    att.file.delete(save=False)
    att.delete()
    return OkOut()


@router.delete("/{int:client_id}/notes/{int:note_id}", auth=staff_auth, response=OkOut)
def delete_note(request, client_id: int, note_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = get_object_or_404(ClientNote, pk=note_id, client=client)
    for att in note.attachments.all():
        att.file.delete(save=False)
    note.delete()
    log_activity(
        ctx.salon,
        "client.note_deleted",
        f"Nota eliminata per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "note_id": note_id},
    )
    return OkOut()


# ---- Schede tecniche (sola lettura dopo la creazione) --------------------------


@router.get("/{int:client_id}/sheets", auth=staff_auth, response=list[TechnicalSheetOut])
def list_sheets(request, client_id: int):
    ctx = request.auth
    # Storico, note e schede sono i dati più sensibili che il gestionale
    # conserva: leggerli richiede il permesso «clienti», come scriverli.
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    return [_sheet_out(sh) for sh in client.sheets.select_related("author")]


@router.post("/{int:client_id}/sheets", auth=staff_auth, response=TechnicalSheetOut)
def create_sheet(request, client_id: int, data: TechnicalSheetIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    payload = data.dict()
    # Come l'endpoint gemello delle note: l'appuntamento va risolto, non
    # passato grezzo. Un id inesistente usciva come 500 sulla chiave esterna e
    # un id di un altro salone (o di un'altra cliente) veniva salvato lo
    # stesso, facendo sparire la scheda dallo storico — lo storico la cerca fra
    # gli appuntamenti di questa cliente, dove quell'id non c'è.
    appointment = _appointment_for(ctx, client, payload.pop("appointment_id", None))
    sheet = TechnicalSheet.objects.create(
        client=client,
        author=ctx.user,
        appointment=appointment,
        **payload,
    )
    log_activity(
        ctx.salon,
        "client.sheet_added",
        f"Scheda tecnica aggiunta per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "sheet_id": sheet.id},
    )
    return _sheet_out(sheet)


@router.post("/{int:client_id}/sheets/{int:sheet_id}/photo", auth=staff_auth, response=TechnicalSheetOut)
def upload_sheet_photo(request, client_id: int, sheet_id: int, photo: UploadedFile = File(...)):
    """Foto della scheda tecnica (unico campo modificabile dopo la creazione)."""
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    sheet = get_object_or_404(TechnicalSheet, pk=sheet_id, client=client)
    # Stessa regola degli allegati: tipo dichiarato nella whitelist, estensione
    # coerente e nome generato dal server. La foto finisce sotto
    # technical_sheets/, servito dallo stesso origin di /admin/.
    stored = stored_upload_name(
        photo,
        allowed_types=ClientNoteAttachment.IMAGE_TYPES,
        max_bytes=ClientNoteAttachment.MAX_BYTES,
    )
    if sheet.photo:
        sheet.photo.delete(save=False)
    sheet.photo.save(stored, photo, save=True)
    return _sheet_out(sheet)


# ---------------------------------------------------------------------------
# Form pubblico di raccolta contatti — /<slug>/hook nell'app cliente
# ---------------------------------------------------------------------------

HOOK_LABEL = "Da form"
HOOK_LABEL_COLOR = "#8B5CF6"
# Soglia per IP e per salone. Non troppo bassa: un salone che fa compilare il
# form da un tablet sul bancone, o clienti sulla stessa rete pubblica, arrivano
# tutti dallo stesso IP. Serve a fermare uno script, non a contare le persone —
# contro lo spam mirato la difesa è l'honeypot.
HOOK_MAX_PER_WINDOW = 20
HOOK_WINDOW_SECONDS = 3600


@router.post("/public/hook", auth=None, response=HookLeadOut)
def public_hook(request, data: HookLeadIn):
    """Raccoglie un contatto dal form pubblico del salone.

    Risponde 200 in ogni caso in cui il salone esiste — anche se il numero è già
    in rubrica o se la richiesta è stata scartata. Distinguere gli esiti
    trasformerebbe l'endpoint in un oracolo: chiunque potrebbe verificare se un
    numero è cliente di quel salone provandolo.
    """
    if data.trap or data.website.strip():  # honeypot
        # WARNING, non INFO: se questa trappola scatta su un utente vero
        # perdiamo un contatto senza che nessuno lo sappia, quindi deve essere
        # visibile nei log. La risposta resta 200 per non istruire i bot.
        logger.warning(
            "hook: submission scartata dall'honeypot (salone=%s, trap=%s, website=%r)",
            data.salon_slug, data.trap, data.website[:40],
        )
        return {"ok": True}

    if not data.privacy:
        raise HttpError(400, "Il consenso al trattamento dei dati è obbligatorio")

    first_name = data.first_name.strip()
    phone = canonical_phone(data.phone)
    if not first_name or not phone:
        raise HttpError(400, "Nome e telefono sono obbligatori")

    try:
        salon = Salon.objects.get(slug=data.salon_slug)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")

    # Il modulo raccoglie anche se il salone non ha configurato l'informativa:
    # bloccarlo spegnerebbe la raccolta contatti alla maggior parte dei saloni
    # attivi, ed è una decisione commerciale, non tecnica. Resta il WARNING qui
    # e l'avviso in dashboard — il consenso senza informativa da leggere è
    # debole, e chi lo raccoglie deve poterlo sapere.
    # values_list().first() e non _settings(): un endpoint pubblico non deve
    # creare righe (get_or_create) su richiesta di uno sconosciuto.
    privacy_url = (
        SalonSettings.objects.filter(salon=salon)
        .values_list("privacy_policy_url", flat=True)
        .first()
    )
    if not privacy_url:
        logger.warning(
            "hook: consenso raccolto senza informativa privacy configurata (salone=%s)", salon.slug
        )

    # Rate limit per IP, sul contatore condiviso di common.ratelimit: è una
    # UPDATE atomica sul database, mentre il vecchio leggi-poi-scrivi sulla
    # cache lasciava passare un flood in parallelo contandolo come una
    # richiesta sola (ogni richiesta qui crea una scheda e un evento).
    key = f"hook:{salon.id}:{ratelimit.client_ip(request)}"
    if not ratelimit.hit(key, HOOK_MAX_PER_WINDOW, HOOK_WINDOW_SECONDS):
        logger.warning("hook: rate limit superato per %s", key)
        return {"ok": True}

    now = timezone.now().isoformat()
    client = find_client_by_phone(salon, phone)

    if client is None:
        try:
            with transaction.atomic():
                lang = (data.lang or "").strip().lower()
                client = Client.objects.create(
                    salon=salon,
                    first_name=first_name,
                    last_name=data.last_name.strip(),
                    phone=phone,
                    email=data.email.strip(),
                    lang=lang if lang in Client.Lang.values else Client.Lang.IT,
                    origin="hook",
                    since=timezone.localdate(),
                    consents={
                        "privacy": True,
                        "privacy_at": now,
                        "marketing": bool(data.marketing),
                        "marketing_at": now if data.marketing else "",
                        "card_charge": False,
                    },
                )
        except IntegrityError:
            # Doppio tocco su «Invia», o due invii in parallelo: il controllo
            # qui sopra non è atomico, il vincolo di unicità sì. Si riprende la
            # scheda appena nata e si prosegue come per chi è già in rubrica —
            # questo endpoint risponde 200 in ogni caso, un 500 racconterebbe a
            # uno sconosciuto che quel numero è cliente del salone.
            client = find_client_by_phone(salon, phone)
            if client is None:
                logger.warning(
                    "hook: creazione rifiutata e scheda non ritrovata (salone=%s)", salon.slug
                )
                return {"ok": True}
        else:
            _mark_as_hook_lead(salon, client)
            return {"ok": True}

    if not client.is_active:
        # Scheda archiviata dallo staff: il modulo la riattivava da solo, con un
        # consenso marketing «fresco» dato da chiunque conoscesse nome e numero
        # — anche la cliente tolta di proposito, o chi ha chiesto di non
        # essere più contattata (10-15). Non si tocca: il salone riceve la
        # segnalazione e decide, come quando la stessa persona prova a entrare
        # dall'app (accounts). Il numero può essere passato a un'altra persona.
        _notify_archived_client(salon, client)
        return {"ok": True}

    # Cliente già in rubrica: si aggiornano i consensi (è il senso del form) e
    # si riempiono solo i campi vuoti. Sovrascrivere nome o email con quanto
    # digitato da uno sconosciuto rovinerebbe una scheda reale, e l'etichetta
    # "Da form" non va messa a chi è già cliente.
    stored = client.consents or {}
    marketing_before = bool(stored.get("marketing"))
    client.consents = {
        **stored,
        "privacy": True,
        "privacy_at": now,
        "marketing": bool(data.marketing) or marketing_before,
        "marketing_at": now if data.marketing else stored.get("marketing_at", ""),
    }
    if data.marketing:
        client.consents.pop("marketing_revoked_at", None)
    fields = ["consents"]
    if not client.email and data.email.strip():
        client.email = data.email.strip()
        fields.append("email")
    if not client.last_name and data.last_name.strip():
        client.last_name = data.last_name.strip()
        fields.append("last_name")
    client.save(update_fields=fields)
    if bool(client.consents["marketing"]) != marketing_before:
        # Consenso ridato dopo una revoca: Yourang deve togliere il blocco.
        _marketing_hook("marketing_consent_changed", client, accepted=True)
    # Con il suo id la scheda aperta in dashboard si ricarica: senza, la
    # reception continuava a vedere i consensi di prima (06-10).
    log_activity(
        salon,
        "client.updated",
        f"Consensi aggiornati dal form: {client.full_name}",
        payload={"client_id": client.id, "fields": fields},
    )

    return {"ok": True}


# Una segnalazione al giorno per scheda archiviata. La chiave è la stessa
# delle segnalazioni dell'accesso dall'app (accounts, «archived-notice:<id>»):
# app e modulo nello stesso giorno sono un avviso solo.
ARCHIVED_NOTICE_WINDOW_SECONDS = 24 * 3600


def _notify_archived_client(salon, client: Client) -> None:
    """Segnala al salone (feed, scope clienti) la scheda archiviata che si è fatta viva."""
    if not ratelimit.hit(f"archived-notice:{client.id}", 1, ARCHIVED_NOTICE_WINDOW_SECONDS):
        return
    log_activity(
        salon,
        "client.reactivation_requested",
        f"{client.full_name}: scheda archiviata, ha compilato il modulo contatti. "
        "Riattivala se vuoi che entri.",
        payload={"client_id": client.id, "source": "hook"},
    )


def _mark_as_hook_lead(salon, client: Client) -> None:
    """Etichetta «Da form», evento SSE e registro: la scheda è un lead nuovo."""
    label, _ = ClientCategory.objects.get_or_create(
        salon=salon, name=HOOK_LABEL, defaults={"color": HOOK_LABEL_COLOR}
    )
    client.categories.add(label)
    emit_event(
        salon,
        "client.created",
        {"client_id": client.id, "name": client.full_name, "phone": client.phone, "source": "hook"},
    )
    log_activity(salon, "client.created", f"Contatto dal form: {client.full_name}")
