from django.conf import settings as django_settings
from django.db import transaction
from django.utils.dateparse import parse_date
from ninja import File, Router
from ninja.errors import HttpError
from ninja.files import UploadedFile
from ninja.pagination import LimitOffsetPagination, paginate

from common.auth import staff_auth
from common.media import stored_upload_name
from common.permissions import require_owner, require_scope
from common.schemas import OkOut
from common.utils import salon_get

from .livefeed import feed_page
from .models import ActivityLog, DepositRule, Location, SalonSettings
from .outbox import delivery_status
from .schemas import (
    ActivityFeedOut,
    OutboxStatusOut,
    ActivityLogOut,
    DepositRuleIn,
    DepositRuleOut,
    LocationIn,
    LocationOut,
    PublicBrandingOut,
    SalonOut,
    SettingsIn,
    SettingsOut,
)
from .services import default_location, get_salon_by_slug, log_activity, make_only_default_location
from .validation import clean_settings_payload, deposit_rule_fields
from .views import STREAM_TICKET_TTL, issue_stream_ticket

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


@router.put("/settings", auth=staff_auth, response=SettingsOut)
def update_settings(request, data: SettingsIn):
    ctx = request.auth
    require_owner(ctx)
    s = _settings(ctx.salon)
    payload, default_lang = clean_settings_payload(data.dict(exclude_unset=True), s)
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


@router.post("/locations", auth=staff_auth, response=LocationOut)
def create_location(request, data: LocationIn):
    ctx = request.auth
    require_owner(ctx)
    with transaction.atomic():
        location = Location.objects.create(salon=ctx.salon, **data.dict())
        if location.is_default:
            make_only_default_location(ctx.salon, location)
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
            make_only_default_location(ctx.salon, loc)
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


@router.get("/deposit-rules", auth=staff_auth, response=list[DepositRuleOut])
def list_deposit_rules(request):
    require_owner(request.auth)
    return request.auth.salon.deposit_rules.all()


@router.post("/deposit-rules", auth=staff_auth, response=DepositRuleOut)
def create_deposit_rule(request, data: DepositRuleIn):
    ctx = request.auth
    require_owner(ctx)
    rule = DepositRule.objects.create(salon=ctx.salon, **deposit_rule_fields(data))
    log_activity(ctx.salon, "deposit_rule.created", f"Regola deposito: {rule.name}", actor=ctx.user)
    return rule


@router.put("/deposit-rules/{int:rule_id}", auth=staff_auth, response=DepositRuleOut)
def update_deposit_rule(request, rule_id: int, data: DepositRuleIn):
    ctx = request.auth
    require_owner(ctx)
    rule = salon_get(DepositRule, ctx, rule_id)
    for name, value in deposit_rule_fields(data).items():
        setattr(rule, name, value)
    rule.save()
    # Come la creazione: il registro ne tiene traccia e il feed live aggiorna
    # le altre postazioni del titolare.
    log_activity(
        ctx.salon, "deposit_rule.updated", f"Regola deposito modificata: {rule.name}",
        actor=ctx.user, payload={"rule_id": rule.id},
    )
    return rule


@router.delete("/deposit-rules/{int:rule_id}", auth=staff_auth, response=OkOut)
def delete_deposit_rule(request, rule_id: int):
    ctx = request.auth
    require_owner(ctx)
    rule = salon_get(DepositRule, ctx, rule_id)
    name, rule_id_value = rule.name, rule.id
    rule.delete()
    log_activity(
        ctx.salon, "deposit_rule.deleted", f"Regola deposito eliminata: {name}",
        actor=ctx.user, payload={"rule_id": rule_id_value},
    )
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


@router.get("/activity/feed", auth=staff_auth, response=ActivityFeedOut)
def activity_feed(request, after: int | None = None):
    """Feed live per il polling della dashboard.

    Senza `after` restituisce solo il cursore corrente: il client parte da lì
    e non riceve lo storico (un salone nuovo parte da 0, che è un cursore
    valido). Con `after=<id>` restituisce, in ordine cronologico, gli eventi
    con id maggiore (max LIVE_FEED_LIMIT) e il nuovo cursore, più quelli con id
    minore comparsi da poco (finestra di sicurezza, vedi
    core.views.LIVE_FEED_SAFETY_SECONDS): un evento può quindi arrivare due
    volte, e la dashboard lo scarta per id (contratto C20). Ogni membro riceve
    solo gli eventi delle aree su cui ha il permesso: il feed non deve essere
    una scorciatoia per leggere in tempo reale incassi, magazzino o impostazioni
    a chi il permesso d'area li nega (lo stream SSE applica lo stesso filtro).
    """
    ctx = request.auth
    return feed_page(ctx.salon, after, is_owner=ctx.is_owner, scopes=ctx.scopes)


@router.get("/outbox/status", auth=staff_auth, response=OutboxStatusOut)
def outbox_status(request):
    """Diagnostica della consegna messaggi: perché un OTP «non arriva».

    Gli eventi (OTP, conferme, promemoria, link caparra) vengono accodati in
    `OutboxEvent` e consegnati da `flush_outbox` a `YOURANG_API_URL`. Senza
    quell'URL — o senza il comando schedulato — restano in coda: è la causa più
    comune, e va detta al titolare invece di lasciarlo aspettare un SMS.
    """
    ctx = request.auth
    require_owner(ctx)
    return delivery_status(ctx.salon)


@router.post("/activity/stream-ticket", auth=staff_auth)
def activity_stream_ticket(request):
    """Ticket effimero per aprire lo stream SSE (EventSource non manda header)."""
    ctx = request.auth
    # Il biglietto dice chi sta ascoltando (lo stream non ha altro modo di
    # saperlo): utente e versione della password, con cui lo stream rilegge la
    # membership e i permessi all'apertura.
    return {
        "ticket": issue_stream_ticket(
            ctx.salon.id,
            ctx.user.id if ctx.user else None,
            is_owner=ctx.is_owner,
            scopes=ctx.scopes,
            token_version=getattr(ctx.user, "token_version", 0) or 0,
        ),
        "expires_in": STREAM_TICKET_TTL,
    }


# ---- Endpoint pubblico per il boot della web app cliente --------------------


@router.get("/public/branding", response=PublicBrandingOut)
def public_branding(request, salon: str):
    s = get_salon_by_slug(salon)
    st = _settings_readonly(s)
    location = default_location(s)
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
