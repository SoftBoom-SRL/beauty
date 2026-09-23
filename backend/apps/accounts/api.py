"""Endpoint /api/auth — login staff, team & ruoli, inviti, login OTP clienti."""

import datetime as dt
import hashlib
import logging

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.models import Salon
from apps.core.services import emit_event, log_activity
from common.auth import (
    client_auth,
    create_client_tokens,
    create_staff_tokens,
    decode_token,
    staff_auth,
)
from common import ratelimit
from common.permissions import SCOPES, require_scope
from common.phone import canonical_phone, find_client_by_phone
from common.utils import salon_get

from .models import Invitation, Membership, Role, StaffRefreshToken, User
from .schemas import (
    PasswordChangeIn,
    ClientAuthOut,
    ClientMeIn,
    ClientMeOut,
    ClientRegisterIn,
    InvitationAcceptIn,
    InvitationIn,
    InvitationOut,
    MemberOut,
    MemberRoleIn,
    MeOut,
    OkOut,
    OTPRequestIn,
    OTPVerifyIn,
    RefreshIn,
    RoleIn,
    RoleOut,
    StaffAuthOut,
    StaffLoginIn,
)
from .services import issue_otp, verify_otp

logger = logging.getLogger(__name__)

router = Router(tags=["accounts"])


# ---- Helpers -----------------------------------------------------------------


def _user_out(user) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.get_full_name() or user.email,
    }


def _role_out(role) -> dict | None:
    if role is None:
        return None
    return {
        "id": role.id,
        "name": role.name,
        "scopes": role.scopes or [],
        "is_system": role.is_system,
    }


def _auth_payload(membership, tokens: dict | None = None) -> dict:
    salon = membership.salon
    out = {
        "user": _user_out(membership.user),
        "salon": {"id": salon.id, "name": salon.name, "slug": salon.slug},
        "scopes": sorted(membership.role.scopes or []) if membership.role else [],
        "is_owner": membership.is_owner,
    }
    if tokens:
        out.update(tokens)
    return out


def _first_membership(user) -> Membership | None:
    """v1 mono-salone: se l'utente ha più membership prende la prima."""
    return (
        Membership.objects.select_related("user", "salon", "role")
        .filter(user=user)
        .order_by("id")
        .first()
    )


def _salon_by_slug(slug: str) -> Salon:
    try:
        return Salon.objects.get(slug=slug)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")


def _client_by_phone(salon, phone: str):
    """Cliente attivo con quel numero, comunque scritto («+39 333…», «333…», «0039…»).

    Restituisce None se non esiste: chi chiama NON deve trasformarlo in un 404,
    perché la differenza fra «numero in anagrafica» e «numero sconosciuto» è la
    rubrica clienti del salone.
    """
    return find_client_by_phone(salon, phone, active_only=True)


def _client_profile(client) -> dict:
    return {
        "id": client.id,
        "first_name": client.first_name,
        "last_name": client.last_name,
        "phone": client.phone,
        "email": client.email or "",
        "lang": client.lang,
        "whatsapp_reminders": client.whatsapp_reminders,
    }


def _validate_scopes(scopes: list[str]) -> None:
    for scope in scopes:
        if scope not in SCOPES:
            raise HttpError(400, f"Scope non valido: {scope}")


# ---- Staff: login e sessione -------------------------------------------------


# Tentativi di accesso staff. Le due chiavi servono a scopi diversi: quella per
# account ferma chi prova mille password su una casella conosciuta, quella per IP
# ferma chi prova la stessa password su mille caselle. Nessun blocco permanente:
# la finestra scade da sola, altrimenti basterebbe sbagliare apposta la password
# di una collega per tenerla fuori dal gestionale. Un accesso riuscito azzera il
# contatore dell'account, così chi conosce la propria password non paga i
# tentativi di altri.
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_PER_ACCOUNT = 10
LOGIN_MAX_PER_IP = 50
# Secondi entro cui un refresh appena ruotato è ancora accettato: vedi
# staff_refresh, serve alle schede multiple della dashboard.
REFRESH_REUSE_GRACE_SECONDS = 20


def _login_account_key(email: str) -> str:
    """Chiave del contatore per account, di lunghezza sempre accettabile.

    L'email arriva dal client senza nessuna validazione e finiva tale e quale
    dentro `RateLimitCounter.key`, che è un CharField(200): bastava mandarne una
    di trecento caratteri per far esplodere l'INSERT con un DataError, cioè un
    500 su un endpoint pubblico (su PostgreSQL; su sqlite passava e basta).
    Oltre una lunghezza plausibile si usa l'impronta: la chiave resta univoca e
    corta, e il caso normale resta leggibile in tabella.
    """
    normalized = email.lower()
    if len(normalized) > 120:
        normalized = hashlib.sha256(normalized.encode("utf-8", "replace")).hexdigest()
    return f"login-account:{normalized}"


@router.post("/staff/login", response=StaffAuthOut)
def staff_login(request, data: StaffLoginIn):
    email = data.email.strip()
    account_key = _login_account_key(email)
    # Si contano tutti i tentativi, non solo quelli falliti: contare dopo aver
    # verificato la password lascerebbe una finestra fra lettura e incremento.
    ip_ok = ratelimit.hit(
        f"login-ip:{ratelimit.client_ip(request)}", LOGIN_MAX_PER_IP, LOGIN_WINDOW_SECONDS
    )
    account_ok = ratelimit.hit(account_key, LOGIN_MAX_PER_ACCOUNT, LOGIN_WINDOW_SECONDS)
    if not (ip_ok and account_ok):
        raise HttpError(429, "Troppi tentativi di accesso: riprova tra qualche minuto")

    user = User.objects.filter(email__iexact=email).first()
    if user is None or not user.is_active:
        # Hash a vuoto: senza, l'email inesistente rispondeva in un millesimo di
        # secondo e quella vera dopo il tempo di un PBKDF2. La differenza si
        # misura da fuori e dice quali caselle esistono nel gestionale — il
        # primo passo per provarci le password.
        User().set_password(data.password)
        raise HttpError(401, "Credenziali non valide")
    if not user.check_password(data.password):
        raise HttpError(401, "Credenziali non valide")
    ratelimit.reset(account_key)
    membership = _first_membership(user)
    if membership is None:
        raise HttpError(403, "Nessun salone associato a questo utente")
    tokens = create_staff_tokens(user, membership.salon)
    return _auth_payload(membership, tokens)


@router.post("/staff/refresh", response=StaffAuthOut)
def staff_refresh(request, data: RefreshIn):
    """Rinnovo con ROTAZIONE: il refresh speso viene revocato e sostituito.

    Prima il rinnovo coniava un token nuovo con TTL pieno e lasciava valido
    anche il vecchio: una copia esfiltrata restava buona per sempre, perché chi
    l'aveva se la rigenerava prima di ogni scadenza. Ora ogni refresh vale una
    volta sola: se qualcuno lo usa, la copia dell'altro non funziona più e il
    furto viene alla luce con un logout invece che con un mese di silenzio.
    """
    payload = decode_token(data.refresh)
    if not payload or payload.get("typ") != "staff_refresh":
        raise HttpError(401, "Token non valido")
    membership = (
        Membership.objects.select_related("user", "salon", "role")
        .filter(
            user_id=payload.get("sub"),
            salon_id=payload.get("salon"),
            user__is_active=True,
        )
        .first()
    )
    if membership is None:
        raise HttpError(401, "Token non valido")
    if payload.get("tv", 0) != (membership.user.token_version or 0):
        raise HttpError(401, "Sessione non più valida: la password è stata modificata")

    jti = payload.get("jti")
    if jti:
        now = timezone.now()
        sessione = StaffRefreshToken.objects.filter(
            jti=jti, user_id=membership.user_id, salon_id=membership.salon_id
        )
        # Si revoca con una sola UPDATE filtrata: due rinnovi simultanei con lo
        # stesso token non possono riuscire entrambi, perché solo uno trova la
        # riga ancora viva. Il filtro su user e salone impedisce di spendere il
        # biglietto di qualcun altro.
        spent = sessione.filter(revoked_at__isnull=True, expires_at__gt=now).update(
            revoked_at=now, rotated=True
        )
        if not spent:
            # Finestra di tolleranza: la dashboard sta aperta in più schede e
            # quando l'access token scade partono due rinnovi con lo stesso
            # refresh a pochi istanti l'uno dall'altro. Senza questa tolleranza
            # la seconda scheda si ritroverebbe buttata fuori a metà giornata.
            # Oltre i pochi secondi il token speso non vale più davvero.
            riutilizzo = sessione.filter(
                rotated=True,
                revoked_at__gte=now - dt.timedelta(seconds=REFRESH_REUSE_GRACE_SECONDS),
                expires_at__gt=now,
            ).exists()
            if not riutilizzo:
                logger.warning(
                    "Rinnovo rifiutato: refresh già speso o revocato (utente=%s)",
                    membership.user_id,
                )
                raise HttpError(401, "Sessione non più valida: esegui di nuovo l'accesso")
    # I refresh emessi prima della rotazione non hanno `jti`: si accettano una
    # volta e vengono sostituiti da uno tracciato, così nessuno viene buttato
    # fuori al deploy. Scadono comunque entro JWT_REFRESH_TTL_DAYS.
    tokens = create_staff_tokens(membership.user, membership.salon)
    return _auth_payload(membership, tokens)


@router.post("/staff/logout", auth=staff_auth, response=OkOut)
def staff_logout(request):
    """Uscita lato server: i refresh non valgono più, non si aspetta la scadenza.

    Prima il logout esisteva solo nel browser (si cancellava localStorage): il
    refresh restava valido trenta giorni, quindi chi ne aveva una copia entrava
    lo stesso. Qui si chiudono TUTTE le sessioni dell'utente su questo salone,
    ed è di proposito: chi «disconnette» il telefono smarrito non ha in mano il
    token di quel dispositivo, e chi esce dal computer della reception si
    aspetta di essere uscito davvero.

    Nessun corpo nella richiesta: un POST vuoto deve bastare, altrimenti il
    client che non manda JSON riceve un 400 e resta dentro senza accorgersene.
    """
    ctx = request.auth
    # Si toccano tutte le righe, comprese quelle già ruotate: una appena
    # sostituita resta spendibile per qualche secondo (vedi staff_refresh) e
    # un'uscita che lasciasse aperta quella finestra non sarebbe un'uscita.
    StaffRefreshToken.objects.filter(user=ctx.user, salon=ctx.salon).update(
        revoked_at=timezone.now(), rotated=False
    )
    return OkOut()


@router.get("/me", auth=staff_auth, response=MeOut)
def me(request):
    return _auth_payload(request.auth.membership)


@router.post("/staff/password", auth=staff_auth, response=StaffAuthOut)
def staff_change_password(request, data: PasswordChangeIn):
    """Cambio password volontario del membro staff.

    `User.set_password` incrementa `token_version`, quindi invalida TUTTE le
    sessioni esistenti dell'utente — i JWT sono stateless e il refresh vive 30
    giorni, perciò senza quel passaggio cambiare la password non caccerebbe
    fuori chi ha ancora la vecchia, cioè non servirebbe a niente nel caso che
    motiva la funzione. Le righe di sessione vanno revocate a parte: il loro
    `jti` non dipende dalla password.

    Al chiamante restituiamo token nuovi: ha appena invalidato anche i propri.
    """
    ctx = request.auth
    user = ctx.user
    if not user.check_password(data.current_password):
        raise HttpError(400, "La password attuale non è corretta")
    if data.new_password == data.current_password:
        raise HttpError(400, "La nuova password deve essere diversa da quella attuale")
    try:
        validate_password(data.new_password, user)
    except ValidationError as exc:
        raise HttpError(400, " ".join(exc.messages))

    user.set_password(data.new_password)
    user.save(update_fields=["password", "token_version"])
    StaffRefreshToken.objects.filter(user=user).update(
        revoked_at=timezone.now(), rotated=False
    )
    log_activity(
        ctx.salon, "user.password_changed", f"Password modificata: {user.email}", actor=user
    )
    return _auth_payload(ctx.membership, create_staff_tokens(user, ctx.salon))


# ---- Staff: membri del team ----------------------------------------------------


def _member_out(membership) -> dict:
    return {
        "id": membership.id,
        "user": _user_out(membership.user),
        "role": _role_out(membership.role),
        "is_owner": membership.is_owner,
    }


def _require_grantable(ctx, scopes) -> None:
    """Nessuno regala permessi che non ha.

    Lo scope `team` serve a gestire il personale, non a diventare titolari: chi
    l'aveva poteva creare un ruolo con tutti e nove i permessi e assegnarselo,
    ottenendo al primo rinnovo incassi, listino, magazzino e analisi che il
    titolare gli aveva negato. Il titolare resta esente: i permessi sono suoi
    per definizione.
    """
    if ctx.is_owner:
        return
    missing = sorted(s for s in (scopes or []) if s not in ctx.scopes)
    if missing:
        raise HttpError(
            403,
            "Non puoi assegnare permessi che non hai: " + ", ".join(missing),
        )


def _require_can_touch_role(ctx, role) -> None:
    """Un ruolo si modifica o si elimina solo se non è più potente di chi lo tocca.

    Senza questo, chi ha il solo `team` poteva riscrivere il ruolo del collega
    responsabile magazzino: non gli dava permessi nuovi, ma gli lasciava
    togliere a chiunque quelli che aveva.
    """
    _require_grantable(ctx, role.scopes or [])


@router.get("/members", auth=staff_auth, response=list[MemberOut])
def list_members(request):
    ctx = request.auth
    require_scope(ctx, "team")
    memberships = (
        Membership.objects.filter(salon=ctx.salon)
        .select_related("user", "role")
        .order_by("id")
    )
    return [_member_out(m) for m in memberships]


@router.post("/members/{int:member_id}/role", auth=staff_auth, response=MemberOut)
def set_member_role(request, member_id: int, data: MemberRoleIn):
    ctx = request.auth
    require_scope(ctx, "team")
    membership = salon_get(Membership, ctx, member_id)
    role = salon_get(Role, ctx, data.role_id) if data.role_id is not None else None
    if not ctx.is_owner:
        # Auto-promozione: è la strada più corta per scavalcare i propri limiti.
        if membership.user_id == ctx.user.id:
            raise HttpError(403, "Non puoi modificare i tuoi permessi")
        # Il titolare lo tocca solo il titolare.
        if membership.is_owner:
            raise HttpError(403, "Solo il titolare può modificare il proprio ruolo")
    if role is not None:
        _require_grantable(ctx, role.scopes or [])
    membership.role = role
    membership.save(update_fields=["role"])
    log_activity(
        ctx.salon,
        "team.role_assigned",
        f"Ruolo di {membership.user.get_full_name() or membership.user.email}: "
        f"{role.name if role else 'nessuno'}",
        actor=ctx.user,
        payload={"membership_id": membership.id, "role_id": role.id if role else None},
    )
    return _member_out(membership)


@router.delete("/members/{int:member_id}", auth=staff_auth, response=OkOut)
def remove_member(request, member_id: int):
    ctx = request.auth
    require_scope(ctx, "team")
    membership = salon_get(Membership, ctx, member_id)
    if membership.is_owner:
        raise HttpError(400, "Impossibile rimuovere il titolare")
    # Chi non è titolare non fa piazza pulita dei colleghi con più permessi di
    # lui: toglierebbe al salone accessi che non era autorizzato a concedere.
    if membership.role is not None:
        _require_can_touch_role(ctx, membership.role)
    email = membership.user.email
    membership.delete()
    log_activity(
        ctx.salon,
        "team.member_removed",
        f"Membro rimosso dal team: {email}",
        actor=ctx.user,
        payload={"email": email},
    )
    return OkOut()


# ---- Staff: ruoli ---------------------------------------------------------------


@router.get("/roles", auth=staff_auth, response=list[RoleOut])
def list_roles(request):
    ctx = request.auth
    require_scope(ctx, "team")
    return Role.objects.filter(salon=ctx.salon).order_by("id")


@router.post("/roles", auth=staff_auth, response=RoleOut)
def create_role(request, data: RoleIn):
    ctx = request.auth
    require_scope(ctx, "team")
    _validate_scopes(data.scopes)
    _require_grantable(ctx, data.scopes)
    if Role.objects.filter(salon=ctx.salon, name=data.name).exists():
        raise HttpError(400, "Esiste già un ruolo con questo nome")
    role = Role.objects.create(salon=ctx.salon, name=data.name, scopes=data.scopes)
    log_activity(
        ctx.salon,
        "team.role_created",
        f"Nuovo ruolo: {role.name}",
        actor=ctx.user,
        payload={"role_id": role.id, "scopes": role.scopes},
    )
    return role


@router.put("/roles/{int:role_id}", auth=staff_auth, response=RoleOut)
def update_role(request, role_id: int, data: RoleIn):
    ctx = request.auth
    require_scope(ctx, "team")
    _validate_scopes(data.scopes)
    role = salon_get(Role, ctx, role_id)
    _require_can_touch_role(ctx, role)
    _require_grantable(ctx, data.scopes)
    if Role.objects.filter(salon=ctx.salon, name=data.name).exclude(id=role.id).exists():
        raise HttpError(400, "Esiste già un ruolo con questo nome")
    role.name = data.name
    role.scopes = data.scopes
    role.save(update_fields=["name", "scopes"])
    log_activity(
        ctx.salon,
        "team.role_updated",
        f"Ruolo aggiornato: {role.name}",
        actor=ctx.user,
        payload={"role_id": role.id, "scopes": role.scopes},
    )
    return role


@router.delete("/roles/{int:role_id}", auth=staff_auth, response=OkOut)
def delete_role(request, role_id: int):
    ctx = request.auth
    require_scope(ctx, "team")
    role = salon_get(Role, ctx, role_id)
    _require_can_touch_role(ctx, role)
    if role.is_system:
        raise HttpError(400, "I ruoli di sistema non sono eliminabili")
    name = role.name
    role.delete()
    log_activity(ctx.salon, "team.role_deleted", f"Ruolo eliminato: {name}", actor=ctx.user)
    return OkOut()


# ---- Staff: inviti ---------------------------------------------------------------


@router.get("/invitations", auth=staff_auth, response=list[InvitationOut])
def list_invitations(request):
    ctx = request.auth
    require_scope(ctx, "team")
    return Invitation.objects.filter(salon=ctx.salon).select_related("role")


@router.post("/invitations", auth=staff_auth, response=InvitationOut)
def create_invitation(request, data: InvitationIn):
    ctx = request.auth
    require_scope(ctx, "team")
    role = salon_get(Role, ctx, data.role_id)
    # L'invito è l'altra strada per fabbricarsi permessi: chi invita sceglie
    # l'email, quindi l'account che nasce è suo a tutti gli effetti.
    _require_grantable(ctx, role.scopes or [])
    email = data.email.strip().lower()
    if Membership.objects.filter(salon=ctx.salon, user__email__iexact=email).exists():
        raise HttpError(400, "L'utente fa già parte del team")
    invitation = Invitation.objects.create(salon=ctx.salon, email=email, role=role)
    emit_event(
        ctx.salon,
        "team.invitation",
        {
            "invitation_id": invitation.id,
            "email": invitation.email,
            "role": role.name,
            "token": str(invitation.token),
            "expires_at": invitation.expires_at.isoformat(),
        },
    )
    log_activity(
        ctx.salon,
        "team.invitation_created",
        f"Invito inviato a {invitation.email} ({role.name})",
        actor=ctx.user,
        payload={"invitation_id": invitation.id, "role_id": role.id},
    )
    return invitation


@router.post("/invitations/accept", response=StaffAuthOut)
def accept_invitation(request, data: InvitationAcceptIn):
    try:
        invitation = Invitation.objects.select_related("salon", "role").get(token=data.token)
    except (Invitation.DoesNotExist, ValidationError, ValueError):
        raise HttpError(404, "Invito non trovato")
    if invitation.status != Invitation.Status.PENDING:
        raise HttpError(400, "Invito non più valido")
    if invitation.expires_at < timezone.now():
        invitation.status = Invitation.Status.EXPIRED
        invitation.save(update_fields=["status"])
        raise HttpError(400, "Invito scaduto")
    if User.objects.filter(email__iexact=invitation.email).exists():
        raise HttpError(400, "Esiste già un utente con questa email")
    # Le stesse regole del cambio password: senza questo controllo l'invito
    # creava account con password vuota, che poi funzionava al login. Si valida
    # prima di toccare qualsiasi cosa, così un rifiuto lascia l'invito
    # utilizzabile.
    candidate = User(
        email=invitation.email, first_name=data.first_name, last_name=data.last_name
    )
    try:
        validate_password(data.password, candidate)
    except ValidationError as exc:
        raise HttpError(400, " ".join(exc.messages))

    with transaction.atomic():
        user = User.objects.create_user(
            email=invitation.email,
            password=data.password,
            first_name=data.first_name,
            last_name=data.last_name,
        )
        membership = Membership.objects.create(
            user=user, salon=invitation.salon, role=invitation.role
        )
        invitation.status = Invitation.Status.ACCEPTED
        invitation.save(update_fields=["status"])
        log_activity(
            invitation.salon,
            "team.invitation_accepted",
            f"{user.get_full_name() or user.email} è entrato nel team",
            actor=user,
            payload={"invitation_id": invitation.id},
        )
    tokens = create_staff_tokens(user, invitation.salon)
    return _auth_payload(membership, tokens)


# ---- Cliente (web app): registrazione e login OTP --------------------------------

# Registrazioni accettate per finestra. Sono numeri generosi per una persona
# vera (che si registra una volta) e stretti per uno script.
REGISTER_WINDOW_SECONDS = 3600
REGISTER_MAX_PER_IP = 5
REGISTER_MAX_PER_SALON = 60



@router.post("/client/register", response=OkOut)
def client_register(request, data: ClientRegisterIn):
    salon = _salon_by_slug(data.salon_slug)
    from apps.clients.models import Client  # lazy: evita cicli in fase di load

    phone = canonical_phone(data.phone)
    if not phone:
        raise HttpError(400, "Il numero di telefono è obbligatorio")

    # L'endpoint è pubblico e ogni chiamata riuscita accoda un messaggio a spese
    # del salone: senza tetto uno script crea schede a raffica e fa partire un
    # SMS verso qualunque numero. Due limiti perché nessuno dei due basta da
    # solo: quello per IP ferma il singolo chiamante, quello per salone ferma
    # la botnet che li distribuisce.
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit(f"register-ip:{ip}", REGISTER_MAX_PER_IP, REGISTER_WINDOW_SECONDS):
        logger.warning("register: tetto per IP superato (salone=%s, ip=%s)", salon.slug, ip)
        raise HttpError(429, "Troppe registrazioni: riprova tra qualche minuto")
    if not ratelimit.hit(
        f"register-salon:{salon.id}", REGISTER_MAX_PER_SALON, REGISTER_WINDOW_SECONDS
    ):
        logger.warning("register: tetto per salone superato (salone=%s)", salon.slug)
        raise HttpError(429, "Troppe registrazioni: riprova tra qualche minuto")
    if find_client_by_phone(salon, phone) is not None:
        raise HttpError(400, "Numero di telefono già registrato")

    client = Client.objects.create(
        salon=salon,
        first_name=data.first_name.strip(),
        last_name=data.last_name.strip(),
        phone=phone,
        email=(data.email or "").strip(),
        lang=data.lang if data.lang in ("it", "en") else "it",
        # Data di prima iscrizione: è l'unico campo su cui si appoggia il KPI
        # «nuovi clienti» del cruscotto, e nessuno lo valorizzava — il numero
        # restava zero per sempre, anche con la web app piena di iscrizioni.
        since=timezone.localdate(),
    )
    emit_event(
        salon,
        "client.created",
        {
            "client_id": client.id,
            "name": f"{client.first_name} {client.last_name}".strip(),
            "phone": client.phone,
            "lang": client.lang,
        },
    )
    log_activity(
        salon,
        "client.created",
        f"Nuovo cliente dalla web app: {client.first_name} {client.last_name}",
        payload={"client_id": client.id},
    )
    issue_otp(client)
    return OkOut()


# Richieste di codice accettate per finestra. Gli stessi due tetti della
# registrazione, e per lo stesso motivo: ogni richiesta riuscita fa partire un
# WhatsApp a spese del salone. Sono generosi per una persona che entra nella
# web app e stretti per uno script che cicla i numeri.
OTP_WINDOW_SECONDS = 15 * 60
OTP_MAX_PER_IP = 20
OTP_MAX_PER_SALON = 60
OTP_VERIFY_MAX_PER_IP = 30


@router.post("/client/request-otp", response=OkOut)
def client_request_otp(request, data: OTPRequestIn):
    """Chiede il codice di accesso. Risponde SEMPRE allo stesso modo.

    Rispondere 404 sui numeri sconosciuti e 200 su quelli in anagrafica
    trasformava l'endpoint in un interrogatorio: uno script che cicla i numeri
    italiani si ricavava l'intera rubrica del salone, e sui numeri validi
    faceva partire cinque WhatsApp ogni quarto d'ora a spese del titolare,
    saturando per giunta i tre codici attivi e tenendo fuori la cliente vera.
    Ora il risultato non dipende dal numero: nemmeno il tetto per cliente
    trapela fuori, altrimenti basterebbe contare i 429 per sapere chi esiste.
    """
    salon = _salon_by_slug(data.salon_slug)
    # I tetti si applicano PRIMA della ricerca: valgono anche per i numeri che
    # non esistono, che sono quelli che interessano a chi sta enumerando.
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit(f"otp-ip:{ip}", OTP_MAX_PER_IP, OTP_WINDOW_SECONDS):
        logger.warning("request-otp: tetto per IP superato (salone=%s, ip=%s)", salon.slug, ip)
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")
    if not ratelimit.hit(f"otp-salon:{salon.id}", OTP_MAX_PER_SALON, OTP_WINDOW_SECONDS):
        logger.warning("request-otp: tetto per salone superato (salone=%s)", salon.slug)
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")

    client = _client_by_phone(salon, data.phone)
    if client is not None:
        try:
            issue_otp(client)
        except HttpError as exc:
            # Il tetto per cliente ha fatto il suo lavoro: nessun codice parte,
            # ma la risposta resta identica a quella di un numero sconosciuto.
            logger.info("request-otp: codice non inviato (cliente=%s): %s", client.id, exc)
    return OkOut()


@router.post("/client/verify-otp", response=ClientAuthOut)
def client_verify_otp(request, data: OTPVerifyIn):
    salon = _salon_by_slug(data.salon_slug)
    # Anche qui un tetto per indirizzo: il numero sconosciuto non ha un cliente
    # su cui contare i tentativi, quindi senza questo l'endpoint resterebbe
    # l'unico punto senza limiti del flusso di accesso.
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit(f"otp-verify-ip:{ip}", OTP_VERIFY_MAX_PER_IP, OTP_WINDOW_SECONDS):
        raise HttpError(429, "Troppi tentativi: riprova tra qualche minuto")
    client = _client_by_phone(salon, data.phone)
    if client is None:
        # Stessa risposta del codice sbagliato: il numero inesistente non si
        # distingue da quello esistente con il codice errato.
        raise HttpError(400, "Codice non valido o scaduto")
    verify_otp(client, data.code.strip())
    tokens = create_client_tokens(client)
    return {
        "access": tokens["access"],
        "client": {"id": client.id, "first_name": client.first_name, "lang": client.lang},
    }


@router.get("/client/me", auth=client_auth, response=ClientMeOut)
def client_me(request):
    return _client_profile(request.auth.client)


@router.put("/client/me", auth=client_auth, response=ClientMeOut)
def client_update_me(request, data: ClientMeIn):
    client = request.auth.client
    updates = data.dict(exclude_unset=True)
    if "lang" in updates:
        if updates["lang"] not in ("it", "en"):
            raise HttpError(400, "Lingua non valida")
        client.lang = updates["lang"]
    if "email" in updates:
        client.email = (updates["email"] or "").strip()
    if "whatsapp_reminders" in updates:
        client.whatsapp_reminders = bool(updates["whatsapp_reminders"])
    client.save()
    return _client_profile(client)
