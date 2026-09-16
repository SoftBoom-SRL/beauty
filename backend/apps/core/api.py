from django.conf import settings as django_settings
from django.db.models import Q
from django.utils.dateparse import parse_date
from ninja import File, Router
from ninja.errors import HttpError
from ninja.files import UploadedFile
from ninja.pagination import LimitOffsetPagination, paginate

from common.auth import staff_auth
from common.permissions import require_owner, require_scope
from common.utils import salon_get

from .models import ActivityLog, DepositRule, Location, Salon, SalonSettings
from .schemas import (
    ActivityFeedOut,
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
    payload = data.dict(exclude_unset=True)
    default_lang = payload.pop("default_lang", None)
    if default_lang is not None and default_lang not in Salon.Lang.values:
        raise HttpError(400, "Lingua non valida (it o en)")
    if "slot_interval_min" in payload and payload["slot_interval_min"] not in (15, 20, 30):
        raise HttpError(400, "Intervallo fasce orarie non valido (15, 20 o 30 minuti)")
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
    s.save()
    if default_lang is not None:
        ctx.salon.default_lang = default_lang
        ctx.salon.save(update_fields=["default_lang"])
    log_activity(ctx.salon, "settings.updated", "Impostazioni aggiornate", actor=ctx.user)
    return _settings_out(s)


@router.post("/settings/logo", auth=staff_auth, response=SettingsOut)
def upload_logo(request, logo: UploadedFile = File(...)):
    ctx = request.auth
    require_owner(ctx)
    s = _settings(ctx.salon)
    s.logo.save(logo.name, logo)
    log_activity(ctx.salon, "settings.updated", "Logo aggiornato", actor=ctx.user)
    return _settings_out(s)


@router.delete("/settings/logo", auth=staff_auth, response=SettingsOut)
def delete_logo(request):
    ctx = request.auth
    require_owner(ctx)
    s = _settings(ctx.salon)
    if s.logo:
        s.logo.delete(save=False)
    s.save()
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
    return Location.objects.create(salon=ctx.salon, **data.dict())


@router.put("/locations/{int:location_id}", auth=staff_auth, response=LocationOut)
def update_location(request, location_id: int, data: LocationIn):
    ctx = request.auth
    require_owner(ctx)
    loc = salon_get(Location, ctx, location_id)
    for name, value in data.dict().items():
        setattr(loc, name, value)
    loc.save()
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
    rule = DepositRule.objects.create(salon=ctx.salon, **data.dict())
    log_activity(ctx.salon, "deposit_rule.created", f"Regola deposito: {rule.name}", actor=ctx.user)
    return rule


@router.put("/deposit-rules/{int:rule_id}", auth=staff_auth, response=DepositRuleOut)
def update_deposit_rule(request, rule_id: int, data: DepositRuleIn):
    ctx = request.auth
    require_owner(ctx)
    rule = salon_get(DepositRule, ctx, rule_id)
    for name, value in data.dict().items():
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
    if date_from and (d := parse_date(date_from)):
        qs = qs.filter(created_at__date__gte=d)
    if date_to and (d := parse_date(date_to)):
        qs = qs.filter(created_at__date__lte=d)
    return qs


# Prefissi di evento che alimentano il feed live della dashboard (aggiornamenti
# in tempo reale fra postazioni + notifiche). Esclusi di proposito team/user/
# settings: sono amministrativi e non riguardano il lavoro condiviso in sala.
LIVE_FEED_PREFIXES = (
    "appointment.", "pause.", "waitlist.", "slot.", "visit.",
    "client.", "sale.", "service.", "package.", "category.",
    "operator.", "product.", "stock.", "order.", "supplier.",
    "coupon.", "giftcard.", "loyalty.", "communication.", "automation.",
)
LIVE_FEED_LIMIT = 50


@router.get("/activity/feed", auth=staff_auth, response=ActivityFeedOut)
def activity_feed(request, after: int | None = None):
    """Feed live per il polling della dashboard.

    Senza `after` restituisce solo il cursore corrente: il client parte da lì
    e non riceve lo storico (un salone nuovo parte da 0, che è un cursore
    valido). Con `after=<id>` restituisce, in ordine cronologico, gli eventi
    con id maggiore (max LIVE_FEED_LIMIT) e il nuovo cursore. Richiede solo
    l'autenticazione staff: gli eventi sono le stesse operazioni che ogni
    membro vede accadere in agenda.
    """
    ctx = request.auth
    qs = ActivityLog.objects.filter(salon=ctx.salon)
    latest = qs.order_by("-id").values_list("id", flat=True).first() or 0
    if after is None:
        return {"cursor": latest, "events": []}

    prefix_q = Q()
    for prefix in LIVE_FEED_PREFIXES:
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


@router.post("/activity/stream-ticket", auth=staff_auth)
def activity_stream_ticket(request):
    """Ticket effimero per aprire lo stream SSE (EventSource non manda header)."""
    from .views import STREAM_TICKET_TTL, issue_stream_ticket

    ctx = request.auth
    return {"ticket": issue_stream_ticket(ctx.salon.id, ctx.user.id if ctx.user else None), "expires_in": STREAM_TICKET_TTL}


# ---- Endpoint pubblico per il boot della web app cliente --------------------


@router.get("/public/branding", response=PublicBrandingOut)
def public_branding(request, salon: str):
    try:
        s = Salon.objects.get(slug=salon)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")
    st = _settings(s)
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
    }
