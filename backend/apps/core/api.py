import re
from decimal import Decimal, InvalidOperation

from django.conf import settings as django_settings
from django.core.exceptions import ValidationError
from django.core.validators import URLValidator
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date
from ninja import File, Router
from ninja.errors import HttpError
from ninja.files import UploadedFile
from ninja.pagination import LimitOffsetPagination, paginate

from common.auth import staff_auth
from common.media import stored_upload_name
from common.permissions import require_owner, require_scope
from common.utils import salon_get

from .models import ActivityLog, DepositRule, Location, Salon, SalonSettings
from .schemas import (
    ActivityFeedOut,
    OutboxStatusOut,
    ActivityLogOut,
    DepositRuleIn,
    DepositRuleOut,
    LocationIn,
    LocationOut,
    OkOut,
    PublicBrandingOut,
    SalonOut,
    SettingsIn,
    SettingsOut,
)
from .services import log_activity, normalize_opening_hours_week, opening_hours_text

router = Router(tags=["core"])


def _settings(salon) -> SalonSettings:
    obj, _ = SalonSettings.objects.get_or_create(salon=salon)
    return obj


def _settings_readonly(salon) -> SalonSettings:
    """Impostazioni per la sola lettura, SENZA crearle.

    L'endpoint pubblico di branding non è autenticato: con `get_or_create`
    bastava chiamarlo per scrivere righe a database. L'istanza non salvata
    risponde con i valori predefiniti, che è esattamente ciò che va mostrato a
    un salone che non ha ancora toccato le impostazioni.
    """
    return SalonSettings.objects.filter(salon=salon).first() or SalonSettings(salon=salon)


def _settings_out(s: SalonSettings) -> dict:
    return {
        "logo_url": s.logo.url if s.logo else None,
        "brand_color": s.brand_color,
        "opening_hours": s.opening_hours,
        "opening_hours_week": s.opening_hours_week or {},
        "agenda_fill": s.agenda_fill,
        "slot_recovery": s.slot_recovery,
        "slot_interval_min": s.slot_interval_min,
        "lastminute_discount_cap": s.lastminute_discount_cap,
        "lastminute_monthly_budget": s.lastminute_monthly_budget,
        "flexible_enabled": s.flexible_enabled,
        "flexible_window_min": s.flexible_window_min,
        "flexible_reward_pct": s.flexible_reward_pct,
        "privacy_policy_url": s.privacy_policy_url,
        "cancel_min_hours": django_settings.CLIENT_MOVE_CANCEL_MIN_HOURS,
        "timezone": django_settings.TIME_ZONE,
        "deposit_hold_minutes": s.deposit_hold_minutes,
        "deposit_reminder_minutes": s.deposit_reminder_minutes,
        "automation_delay_seconds": s.automation_delay_seconds,
        "cancel_reasons": [str(x) for x in (s.cancel_reasons or [])],
        "no_show_reasons": [str(x) for x in (s.no_show_reasons or [])],
        "stripe_connected": bool(s.stripe_account_id),
        "stripe_connect_available": bool(
            django_settings.STRIPE_SECRET_KEY and django_settings.STRIPE_CONNECT_CLIENT_ID
        ),
        "stripe_account_id": s.stripe_account_id,
    }


# ---- Salone e impostazioni -------------------------------------------------


@router.get("/salon", auth=staff_auth, response=SalonOut)
def get_salon(request):
    salon = request.auth.salon
    return {
        "id": salon.id,
        "name": salon.name,
        "slug": salon.slug,
        "default_lang": salon.default_lang,
        "currency": salon.currency,
        "locations": list(salon.locations.all()),
        "settings": _settings_out(_settings(salon)),
    }


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
_BRAND_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
MAX_OPENING_HOURS_CHARS = 500
MAX_MONTHLY_BUDGET = Decimal("99999999.99")  # DecimalField(max_digits=10, decimal_places=2)


def _validate_url(raw: str, label: str) -> str:
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


@router.put("/settings", auth=staff_auth, response=SettingsOut)
def update_settings(request, data: SettingsIn):
    ctx = request.auth
    require_owner(ctx)
    s = _settings(ctx.salon)
    payload = data.dict(exclude_unset=True)
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
        if not 0 <= budget <= MAX_MONTHLY_BUDGET:
            raise HttpError(400, "Budget fuori scala")
        payload["lastminute_monthly_budget"] = budget
    if "privacy_policy_url" in payload:
        payload["privacy_policy_url"] = _validate_url(
            payload["privacy_policy_url"], "Indirizzo dell'informativa privacy"
        )
    # L'invariante va verificata sui valori EFFETTIVI dopo il salvataggio, non
    # solo quando arriva il sollecito: abbassando la sola scadenza il sollecito
    # restava oltre, non partiva più e in Impostazioni continuava a comparire.
    hold = payload.get("deposit_hold_minutes", s.deposit_hold_minutes)
    reminder = payload.get("deposit_reminder_minutes", s.deposit_reminder_minutes)
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
    for name, value in payload.items():
        setattr(s, name, value)
    # Solo le colonne del payload: `s` è la copia letta a inizio richiesta, e un
    # save() completo riscriveva anche quelle che altri hanno cambiato nel
    # frattempo — il callback di Stripe Connect che salva `stripe_account_id`
    # veniva annullato e il salone risultava scollegato.
    s.save(update_fields=[*payload, "updated_at"])
    if default_lang is not None:
        ctx.salon.default_lang = default_lang
        ctx.salon.save(update_fields=["default_lang"])
    log_activity(ctx.salon, "settings.updated", "Impostazioni aggiornate", actor=ctx.user)
    return _settings_out(s)


# Il logo finisce in `branding/`, che NON è fra i PRIVATE_PREFIXES di
# common.media: il file è scaricabile da chiunque conosca l'URL, sull'origin
# dell'API dove vive anche /admin/. Senza controlli si caricava un evil.html
# dichiarato "image/png" e la pagina eseguiva JavaScript in quell'origin.
# La validazione (tipo dichiarato, estensione coerente, nome generato dal
# server) è quella condivisa di common.media, la stessa degli altri upload.
# Niente SVG: è un documento XML che può contenere script.
LOGO_TYPES = ("image/jpeg", "image/png", "image/webp")
LOGO_MAX_BYTES = 2 * 1024 * 1024


@router.post("/settings/logo", auth=staff_auth, response=SettingsOut)
def upload_logo(request, logo: UploadedFile = File(...)):
    ctx = request.auth
    require_owner(ctx)
    s = _settings(ctx.salon)
    stored_name = stored_upload_name(logo, allowed_types=LOGO_TYPES, max_bytes=LOGO_MAX_BYTES)
    # Il logo precedente va cancellato: `save` gli darebbe solo un nome diverso
    # e il vecchio file resterebbe su disco (e scaricabile) per sempre.
    if s.logo:
        s.logo.delete(save=False)
    # save=False e poi solo `logo`: il save() completo di FieldFile.save
    # riscriveva l'intera riga letta a inizio richiesta (stripe_account_id
    # compreso) sopra le scritture concorrenti.
    s.logo.save(stored_name, logo, save=False)
    s.save(update_fields=["logo", "updated_at"])
    log_activity(ctx.salon, "settings.updated", "Logo aggiornato", actor=ctx.user)
    return _settings_out(s)


@router.delete("/settings/logo", auth=staff_auth, response=SettingsOut)
def delete_logo(request):
    ctx = request.auth
    require_owner(ctx)
    s = _settings(ctx.salon)
    if s.logo:
        s.logo.delete(save=False)
    s.save(update_fields=["logo", "updated_at"])
    log_activity(ctx.salon, "settings.updated", "Logo rimosso", actor=ctx.user)
    return _settings_out(s)


# ---- Sedi ------------------------------------------------------------------


@router.get("/locations", auth=staff_auth, response=list[LocationOut])
def list_locations(request):
    return request.auth.salon.locations.all()


def _make_only_default(salon, location) -> None:
    """La sede predefinita è UNA: le altre vanno azzerate nella stessa transazione.

    Chi legge fa `filter(is_default=True).first()`, che senza ordinamento
    esplicito restituisce la più vecchia: marcandone una seconda, la scelta del
    titolare veniva ignorata e dall'interfaccia non c'era modo di correggerla.
    """
    Location.objects.filter(salon=salon, is_default=True).exclude(pk=location.pk).update(
        is_default=False
    )


@router.post("/locations", auth=staff_auth, response=LocationOut)
def create_location(request, data: LocationIn):
    ctx = request.auth
    require_owner(ctx)
    with transaction.atomic():
        location = Location.objects.create(salon=ctx.salon, **data.dict())
        if location.is_default:
            _make_only_default(ctx.salon, location)
    return location


@router.put("/locations/{int:location_id}", auth=staff_auth, response=LocationOut)
def update_location(request, location_id: int, data: LocationIn):
    ctx = request.auth
    require_owner(ctx)
    with transaction.atomic():
        loc = salon_get(Location, ctx, location_id)
        for name, value in data.dict().items():
            setattr(loc, name, value)
        loc.save()
        if loc.is_default:
            _make_only_default(ctx.salon, loc)
    return loc


@router.delete("/locations/{int:location_id}", auth=staff_auth, response=OkOut)
def delete_location(request, location_id: int):
    ctx = request.auth
    require_owner(ctx)
    loc = salon_get(Location, ctx, location_id)
    if ctx.salon.locations.count() <= 1:
        raise HttpError(400, "Impossibile eliminare l'unica sede")
    loc.delete()
    return OkOut()


# ---- Regole deposito -------------------------------------------------------

MAX_RULE_AMOUNT = Decimal("99999999.99")  # DecimalField(max_digits=10, decimal_places=2)


def _deposit_rule_fields(data: DepositRuleIn) -> dict:
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
    if amount > MAX_RULE_AMOUNT:
        raise HttpError(400, "Importo dell'acconto fuori scala")
    return fields


@router.get("/deposit-rules", auth=staff_auth, response=list[DepositRuleOut])
def list_deposit_rules(request):
    require_owner(request.auth)
    return request.auth.salon.deposit_rules.all()


@router.post("/deposit-rules", auth=staff_auth, response=DepositRuleOut)
def create_deposit_rule(request, data: DepositRuleIn):
    ctx = request.auth
    require_owner(ctx)
    rule = DepositRule.objects.create(salon=ctx.salon, **_deposit_rule_fields(data))
    log_activity(ctx.salon, "deposit_rule.created", f"Regola deposito: {rule.name}", actor=ctx.user)
    return rule


@router.put("/deposit-rules/{int:rule_id}", auth=staff_auth, response=DepositRuleOut)
def update_deposit_rule(request, rule_id: int, data: DepositRuleIn):
    ctx = request.auth
    require_owner(ctx)
    rule = salon_get(DepositRule, ctx, rule_id)
    for name, value in _deposit_rule_fields(data).items():
        setattr(rule, name, value)
    rule.save()
    return rule


@router.delete("/deposit-rules/{int:rule_id}", auth=staff_auth, response=OkOut)
def delete_deposit_rule(request, rule_id: int):
    ctx = request.auth
    require_owner(ctx)
    salon_get(DepositRule, ctx, rule_id).delete()
    return OkOut()


# ---- Registro attività -----------------------------------------------------


def _activity_date(raw: str, label: str):
    try:
        parsed = parse_date(raw)
    except ValueError:
        # «2026-02-30» è ben scritta ma non esiste: parse_date solleva, ed era un 500.
        parsed = None
    if parsed is None:
        raise HttpError(400, f"{label} non valida: usa il formato YYYY-MM-DD")
    return parsed


@router.get("/activity", auth=staff_auth, response=list[ActivityLogOut])
@paginate(LimitOffsetPagination)
def list_activity(
    request,
    type: str = "",
    q: str = "",
    date_from: str = "",
    date_to: str = "",
):
    ctx = request.auth
    require_scope(ctx, "activity_log")
    qs = ActivityLog.objects.filter(salon=ctx.salon)
    if type:
        qs = qs.filter(type__startswith=type)
    if q:
        qs = qs.filter(summary__icontains=q)
    if date_from:
        qs = qs.filter(created_at__date__gte=_activity_date(date_from, "Data iniziale"))
    if date_to:
        qs = qs.filter(created_at__date__lte=_activity_date(date_to, "Data finale"))
    return qs


# I prefissi di evento del feed live e i permessi richiesti sono definiti UNA
# volta in core.views (stream SSE) e riusati qui dal polling di riserva: due
# elenchi separati avevano perso `settings.` e `client_category.` solo lato HTTP.
from .views import allowed_prefixes  # noqa: E402

LIVE_FEED_LIMIT = 50


@router.get("/activity/feed", auth=staff_auth, response=ActivityFeedOut)
def activity_feed(request, after: int | None = None):
    """Feed live per il polling della dashboard.

    Senza `after` restituisce solo il cursore corrente: il client parte da lì
    e non riceve lo storico (un salone nuovo parte da 0, che è un cursore
    valido). Con `after=<id>` restituisce, in ordine cronologico, gli eventi
    con id maggiore (max LIVE_FEED_LIMIT) e il nuovo cursore. Ogni membro riceve
    solo gli eventi delle aree su cui ha il permesso: il feed non deve essere
    una scorciatoia per leggere in tempo reale incassi, magazzino o impostazioni
    a chi il permesso d'area li nega (lo stream SSE applica lo stesso filtro).
    """
    ctx = request.auth
    qs = ActivityLog.objects.filter(salon=ctx.salon)
    latest = qs.order_by("-id").values_list("id", flat=True).first() or 0
    if after is None:
        return {"cursor": latest, "events": []}

    prefixes = allowed_prefixes(ctx.is_owner, ctx.scopes)
    events = []
    if prefixes:
        prefix_q = Q()
        for prefix in prefixes:
            prefix_q |= Q(type__startswith=prefix)
        events = list(
            qs.filter(id__gt=after).filter(prefix_q).order_by("id")[:LIVE_FEED_LIMIT]
        )
    # Il cursore avanza sempre fino all'ultimo id visto (anche se filtrato via),
    # così un evento amministrativo non viene richiesto all'infinito.
    scanned = qs.filter(id__gt=after).order_by("id").values_list("id", flat=True)[:LIVE_FEED_LIMIT]
    scanned = list(scanned)
    cursor = max([after] + scanned + [e.id for e in events])
    if len(scanned) < LIVE_FEED_LIMIT:
        cursor = max(cursor, latest)
    return {
        "cursor": cursor,
        "events": [
            {
                "id": e.id,
                "type": e.type,
                "summary": e.summary,
                "actor_id": e.actor_id,
                "actor_name": e.actor_name,
                "payload": e.payload,
                "created_at": e.created_at,
            }
            for e in events
        ],
    }


@router.get("/outbox/status", auth=staff_auth, response=OutboxStatusOut)
def outbox_status(request):
    """Diagnostica della consegna messaggi: perché un OTP «non arriva».

    Gli eventi (OTP, conferme, promemoria, link caparra) vengono accodati in
    `OutboxEvent` e consegnati da `flush_outbox` a `YOURANG_API_URL`. Senza
    quell'URL — o senza il comando schedulato — restano in coda: è la causa più
    comune, e va detta al titolare invece di lasciarlo aspettare un SMS.
    """
    from datetime import timedelta

    from .models import OutboxEvent

    ctx = request.auth
    require_owner(ctx)
    qs = OutboxEvent.objects.filter(salon=ctx.salon)
    # `sending` = preso in carico da un worker in questo momento: per chi guarda
    # la diagnostica è ancora un messaggio che non è arrivato.
    pending = qs.filter(
        status__in=(OutboxEvent.Status.PENDING, OutboxEvent.Status.SENDING)
    )
    sent = qs.filter(status=OutboxEvent.Status.SENT)
    day_ago = timezone.now() - timedelta(hours=24)
    return {
        "configured": bool(django_settings.YOURANG_API_URL),
        "pending": pending.count(),
        "failed": qs.filter(status=OutboxEvent.Status.FAILED).count(),
        "sent_24h": sent.filter(sent_at__gte=day_ago).count(),
        "oldest_pending_at": pending.order_by("created_at").values_list("created_at", flat=True).first(),
        "last_sent_at": sent.order_by("-sent_at").values_list("sent_at", flat=True).first(),
        "pending_types": sorted(set(pending.order_by("-id").values_list("event_type", flat=True)[:50])),
    }


@router.post("/activity/stream-ticket", auth=staff_auth)
def activity_stream_ticket(request):
    """Ticket effimero per aprire lo stream SSE (EventSource non manda header)."""
    from .views import STREAM_TICKET_TTL, issue_stream_ticket

    ctx = request.auth
    # I permessi viaggiano nel biglietto: lo stream non ha altro modo di sapere
    # chi sta ascoltando e consegnava tutto a chiunque fosse autenticato.
    return {
        "ticket": issue_stream_ticket(
            ctx.salon.id,
            ctx.user.id if ctx.user else None,
            is_owner=ctx.is_owner,
            scopes=ctx.scopes,
        ),
        "expires_in": STREAM_TICKET_TTL,
    }


# ---- Endpoint pubblico per il boot della web app cliente --------------------


@router.get("/public/branding", response=PublicBrandingOut)
def public_branding(request, salon: str):
    try:
        s = Salon.objects.get(slug=salon)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")
    st = _settings_readonly(s)
    location = s.locations.filter(is_default=True).first() or s.locations.first()
    return {
        "name": s.name,
        "slug": s.slug,
        "default_lang": s.default_lang,
        "logo_url": st.logo.url if st.logo else None,
        "brand_color": st.brand_color,
        "address": location.address if location else "",
        "phone": location.phone if location else "",
        "opening_hours": st.opening_hours,
        "opening_hours_week": st.opening_hours_week or {},
        "privacy_policy_url": st.privacy_policy_url,
        "timezone": django_settings.TIME_ZONE,
        "cancel_min_hours": django_settings.CLIENT_MOVE_CANCEL_MIN_HOURS,
    }
