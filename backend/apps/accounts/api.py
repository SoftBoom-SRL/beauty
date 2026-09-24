"""Endpoint /api/auth — login staff, team & ruoli, inviti, login OTP clienti."""

import datetime as dt
import hashlib
import logging

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import emit_event, get_salon_by_slug, log_activity
from common.auth import (
    client_auth,
    create_client_tokens,
    create_staff_tokens,
    decode_token,
    staff_auth,
)
from common import ratelimit
from common.permissions import require_scope
from common.phone import canonical_phone, find_client_by_phone
from common.schemas import OkOut
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
    OTPRequestIn,
    OTPVerifyIn,
    RefreshIn,
    RoleIn,
    RoleOut,
    StaffAuthOut,
    StaffLoginIn,
)
from .services import issue_otp, verify_otp
from .sessions import find_membership, first_membership, session_payload, tv_matches
from .team import (
    can_grant,
    invitation_out,
    member_out,
    require_can_touch_role,
    require_grantable,
    validate_scopes,
)

logger = logging.getLogger(__name__)

router = Router(tags=["accounts"])


# ---- Helpers -----------------------------------------------------------------


def _active_client_by_phone(salon, phone: str):
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
        # Il consenso dato dal form o in salone si revoca dall'app
        # (POST /api/marketing/client/marketing-consent): senza leggerlo qui
        # l'app non sapeva nemmeno se c'era qualcosa da revocare (06-17).
        "marketing_consent": bool((client.consents or {}).get("marketing")),
    }


# Una segnalazione al salone per scheda archiviata al giorno: vedi
# `_notify_archived_client`.
ARCHIVED_NOTICE_WINDOW_SECONDS = 24 * 3600


def _notify_archived_client(salon, client) -> None:
    """Avvisa il salone se `client` è una scheda archiviata che prova a entrare.

    Alla cliente archiviata l'app non può dire nulla di diverso da un numero
    sconosciuto — la risposta rivelerebbe la rubrica — e il codice non le parte:
    restava fuori senza che nessuno lo sapesse. Il salone invece deve saperlo:
    la segnalazione arriva nel feed (scope clienti) con la scheda da aprire e
    riattivare, e l'app intanto le dice di contattare il salone. Non la si
    riattiva da sola: il numero potrebbe essere passato a un'altra persona, che
    entrerebbe nello storico di chi non è più cliente.
    """
    if client is None or client.is_active:
        return
    if not ratelimit.hit(
        f"archived-notice:{client.id}", 1, ARCHIVED_NOTICE_WINDOW_SECONDS
    ):
        return
    log_activity(
        salon,
        "client.reactivation_requested",
        f"{client.full_name}: scheda archiviata, ha provato ad accedere dall'app. "
        "Riattivala se vuoi che entri.",
        payload={"client_id": client.id},
    )


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
# Tentativi di cambio password con la password attuale da verificare: stessi
# tetti del login, su chiavi proprie (vedi staff_change_password).
PASSWORD_CHANGE_WINDOW_SECONDS = 15 * 60
PASSWORD_CHANGE_MAX_PER_USER = 10
PASSWORD_CHANGE_MAX_PER_IP = 50


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

    # L'email si confronta senza maiuscole, ma `User.email` è unica solo così
    # com'è scritta: «Anna@x.it» e «anna@x.it» possono esistere entrambe (le
    # creava create_salon), e `.first()` senza ordine ne prendeva una a caso —
    # su PostgreSQL non sempre la stessa (08-08). Si prova prima quella scritta
    # esattamente così, poi le altre in ordine di creazione, e vale quella di
    # cui la password è giusta.
    candidates = sorted(
        User.objects.filter(email__iexact=email, is_active=True),
        key=lambda candidate: (candidate.email != email, candidate.id),
    )
    if not candidates:
        # Hash a vuoto: senza, l'email inesistente rispondeva in un millesimo di
        # secondo e quella vera dopo il tempo di un PBKDF2. La differenza si
        # misura da fuori e dice quali caselle esistono nel gestionale — il
        # primo passo per provarci le password.
        User().set_password(data.password)
        raise HttpError(401, "Credenziali non valide")
    user = next((c for c in candidates if c.check_password(data.password)), None)
    if user is None:
        raise HttpError(401, "Credenziali non valide")
    ratelimit.reset(account_key)
    membership = first_membership(user)
    if membership is None:
        raise HttpError(403, "Nessun salone associato a questo utente")
    tokens = create_staff_tokens(user, membership.salon)
    return session_payload(membership, tokens)


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
    membership = find_membership(payload.get("sub"), payload.get("salon"))
    if membership is None:
        raise HttpError(401, "Token non valido")
    if not tv_matches(membership, payload.get("tv", 0)):
        raise HttpError(401, "Sessione non più valida: la password è stata modificata")

    jti = payload.get("jti")
    if not jti:
        # I refresh emessi prima della rotazione (18/09) non hanno `jti`. Nella
        # finestra di passaggio si accettavano per non buttare fuori nessuno al
        # deploy, ma senza una riga da revocare restavano riusabili all'infinito
        # e sopravvivevano all'uscita: un refresh legacy rubato rigenerava access
        # token fino alla sua scadenza, anche dopo il logout del titolare (10-11).
        # Chi usa la dashboard l'ha già scambiato con uno tracciato al primo
        # rinnovo; quelli rimasti sono di dispositivi fermi da allora, che rifanno
        # l'accesso una volta.
        raise HttpError(401, "Sessione non più valida: esegui di nuovo l'accesso")
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
    tokens = create_staff_tokens(membership.user, membership.salon)
    return session_payload(membership, tokens)


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
    return session_payload(request.auth.membership)


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
    # Il login ha due tetti, questo endpoint nessuno: chi aveva in mano un
    # access token (un'ora di vita) ma non la password poteva provarla qui
    # all'infinito, e la password vale anche per /admin/ e dopo la scadenza
    # del token (10-13). Si conta ogni tentativo prima di verificare, come al
    # login, e la chiave dell'utente si azzera appena la password attuale
    # risulta giusta: chi sbaglia solo le regole della nuova non paga.
    user_key = f"password-change:{user.id}"
    ip_ok = ratelimit.hit(
        f"password-change-ip:{ratelimit.client_ip(request)}",
        PASSWORD_CHANGE_MAX_PER_IP,
        PASSWORD_CHANGE_WINDOW_SECONDS,
    )
    user_ok = ratelimit.hit(user_key, PASSWORD_CHANGE_MAX_PER_USER, PASSWORD_CHANGE_WINDOW_SECONDS)
    if not (ip_ok and user_ok):
        raise HttpError(429, "Troppi tentativi: riprova tra qualche minuto")
    if not user.check_password(data.current_password):
        raise HttpError(400, "La password attuale non è corretta")
    ratelimit.reset(user_key)
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
    return session_payload(ctx.membership, create_staff_tokens(user, ctx.salon))


# ---- Staff: membri del team ----------------------------------------------------


@router.get("/members", auth=staff_auth, response=list[MemberOut])
def list_members(request):
    ctx = request.auth
    require_scope(ctx, "team")
    memberships = (
        Membership.objects.filter(salon=ctx.salon)
        .select_related("user", "role")
        .order_by("id")
    )
    return [member_out(m) for m in memberships]


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
        # Come in `remove_member`: chi ha il solo `team` non toglie i permessi a
        # una collega più potente di lui. Controllando soltanto il ruolo NUOVO,
        # «Nessun ruolo» o un ruolo più stretto passavano sulla Manager, che
        # perdeva cassa, magazzino e listino — mentre rimuoverla dal team era
        # già vietato (10-05, 15-02).
        if membership.role is not None:
            require_can_touch_role(ctx, membership.role)
    if role is not None:
        require_grantable(ctx, role.scopes or [])
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
    return member_out(membership)


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
        require_can_touch_role(ctx, membership.role)
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
    validate_scopes(data.scopes)
    require_grantable(ctx, data.scopes)
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
    validate_scopes(data.scopes)
    role = salon_get(Role, ctx, role_id)
    require_can_touch_role(ctx, role)
    # La dashboard li presenta come «permessi non modificabili» a tutti, il
    # titolare compreso, ma l'API li riscriveva: con una chiamata diretta chi
    # aveva team+agenda+clienti toglieva l'agenda al ruolo «Operatrice» e a
    # tutte le operatrici insieme (15-10). Come per l'eliminazione, qui no.
    if role.is_system:
        raise HttpError(400, "I ruoli di sistema non sono modificabili")
    require_grantable(ctx, data.scopes)
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
    require_can_touch_role(ctx, role)
    if role.is_system:
        raise HttpError(400, "I ruoli di sistema non sono eliminabili")
    name = role.name
    role.delete()
    log_activity(ctx.salon, "team.role_deleted", f"Ruolo eliminato: {name}", actor=ctx.user)
    return OkOut()


# ---- Staff: inviti ---------------------------------------------------------------


@router.get("/invitations", auth=staff_auth, response=list[InvitationOut])
def list_invitations(request):
    """Inviti del salone; il codice solo a chi potrebbe concedere quel ruolo.

    Il codice di un invito vale un account: chi lo presenta a
    `accept_invitation` crea l'utente con la password che sceglie e riceve il
    ruolo dell'invito. Consegnato a chiunque avesse `team`, il front-desk
    copiava il codice dell'invito «Manager» destinato alla nuova assunta e
    diventava Manager lui (10-01). A chi può assegnare quel ruolo invece non
    toglie nulla vederlo: un invito per sé potrebbe crearlo comunque. Oggi
    l'invio automatico non c'è ancora e il codice si condivide a mano da qui,
    per questo non sparisce del tutto dalla lista.
    """
    ctx = request.auth
    require_scope(ctx, "team")
    now = timezone.now()
    return [
        invitation_out(
            invitation,
            with_token=(
                invitation.status == Invitation.Status.PENDING
                and invitation.expires_at > now
                and can_grant(ctx, invitation.role)
            ),
        )
        for invitation in Invitation.objects.filter(salon=ctx.salon).select_related("role")
    ]


@router.post("/invitations", auth=staff_auth, response=InvitationOut)
def create_invitation(request, data: InvitationIn):
    ctx = request.auth
    require_scope(ctx, "team")
    role = salon_get(Role, ctx, data.role_id)
    # L'invito è l'altra strada per fabbricarsi permessi: chi invita sceglie
    # l'email, quindi l'account che nasce è suo a tutti gli effetti.
    require_grantable(ctx, role.scopes or [])
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
    # Chi l'ha appena creato ha superato `require_grantable`: il codice è suo.
    return invitation_out(invitation, with_token=True)


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
        # Un invito vale una volta sola: lo stato si ricontrolla sulla riga
        # bloccata e riletta. Letto a inizio richiesta, due accettazioni
        # simultanee dello stesso codice passavano entrambe e la seconda
        # moriva sull'email già presa con un 500.
        locked = (
            Invitation.objects.select_for_update()
            .filter(pk=invitation.pk, status=Invitation.Status.PENDING)
            .first()
        )
        if locked is None:
            raise HttpError(400, "Invito non più valido")
        try:
            with transaction.atomic():
                user = User.objects.create_user(
                    email=invitation.email,
                    password=data.password,
                    first_name=data.first_name,
                    last_name=data.last_name,
                )
        except IntegrityError:
            raise HttpError(400, "Esiste già un utente con questa email")
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
    return session_payload(membership, tokens)


# ---- Cliente (web app): registrazione e login OTP --------------------------------

# Registrazioni accettate per finestra. Sono numeri generosi per una persona
# vera (che si registra una volta) e stretti per uno script. Il tetto per
# salone conta solo le schede create davvero: vedi client_register.
REGISTER_WINDOW_SECONDS = 3600
REGISTER_MAX_PER_IP = 5
REGISTER_MAX_PER_SALON = 120


@router.post("/client/register", response=OkOut)
def client_register(request, data: ClientRegisterIn):
    salon = get_salon_by_slug(data.salon_slug)
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
    existing = find_client_by_phone(salon, phone)
    if existing is not None:
        # Stessa risposta per la scheda attiva e per quella archiviata: l'app
        # mostra la schermata che spiega entrambi i casi e offre di chiamare.
        _notify_archived_client(salon, existing)
        raise HttpError(400, "Numero di telefono già registrato")
    # Il tetto per salone si conta DOPO il controllo sul numero: contato prima,
    # lo riempivano anche i tentativi respinti (numeri già in rubrica, che non
    # costano nulla) e da poche reti si bloccava per un'ora l'iscrizione di
    # tutte le clienti nuove del salone (10-04). Ora lo consuma solo chi crea
    # una scheda davvero, e il valore è più largo di un picco di campagna.
    if not ratelimit.hit(
        f"register-salon:{salon.id}", REGISTER_MAX_PER_SALON, REGISTER_WINDOW_SECONDS
    ):
        logger.warning("register: tetto per salone superato (salone=%s)", salon.slug)
        raise HttpError(429, "Troppe registrazioni: riprova tra qualche minuto")

    try:
        # Il controllo qui sopra e l'inserimento non sono atomici: il doppio
        # tocco su «Registrati» (o un ritentativo di rete) li superava entrambi
        # e il secondo moriva sul vincolo unico del telefono con un 500 — dopo
        # che il primo aveva già emesso il codice (10-14, 18-12).
        with transaction.atomic():
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
    except IntegrityError:
        raise HttpError(400, "Numero di telefono già registrato")
    emit_event(
        salon,
        "client.created",
        {
            "client_id": client.id,
            "name": client.full_name,
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


# Richieste di codice accettate per finestra. Ogni codice emesso fa partire un
# WhatsApp a spese del salone. Il tetto per IP vale per ogni richiesta ed è
# generoso per una persona che entra nella web app e stretto per uno script che
# cicla i numeri. Quello per salone conta solo i codici EMESSI davvero (vedi
# client_request_otp); le richieste nel loro insieme sono solo un segnale.
OTP_WINDOW_SECONDS = 15 * 60
OTP_MAX_PER_IP = 20
OTP_MAX_ISSUED_PER_SALON = 200
OTP_ALERT_PER_SALON = 60
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
    salon = get_salon_by_slug(data.salon_slug)
    # Il tetto per IP si applica PRIMA della ricerca: vale anche per i numeri
    # che non esistono, che sono quelli che interessano a chi sta enumerando.
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit(f"otp-ip:{ip}", OTP_MAX_PER_IP, OTP_WINDOW_SECONDS):
        logger.warning("request-otp: tetto per IP superato (salone=%s, ip=%s)", salon.slug, ip)
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")
    # Il tetto per salone contava ogni richiesta, anche sui numeri inventati:
    # da tre reti, venti richieste ciascuna, si teneva fuori dall'app ogni
    # cliente del salone per quindici minuti alla volta, e bastava una
    # campagna «prenota dall'app» per chiuderlo senza nessun attacco (16-01,
    # 10-04). Contate tutte, le richieste restano solo un segnale nei log.
    if not ratelimit.hit(f"otp-salon:{salon.id}", OTP_ALERT_PER_SALON, OTP_WINDOW_SECONDS):
        logger.warning("request-otp: molte richieste per il salone (salone=%s)", salon.slug)
    # Il blocco vero conta solo i codici partiti, cioè il costo: i numeri
    # inventati non lo toccano, e riempirlo richiede decine di numeri veri
    # (ognuno ha il suo tetto di cinque). Una volta pieno vale per tutti allo
    # stesso modo, così la risposta non dice nulla del numero.
    issued_key = f"otp-issued-salon:{salon.id}"
    if ratelimit.peek(issued_key) >= OTP_MAX_ISSUED_PER_SALON:
        logger.warning("request-otp: tetto dei codici emessi per salone (salone=%s)", salon.slug)
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")

    client = _active_client_by_phone(salon, data.phone)
    if client is not None:
        try:
            issue_otp(client)
        except HttpError as exc:
            # Il tetto per cliente ha fatto il suo lavoro: nessun codice parte,
            # ma la risposta resta identica a quella di un numero sconosciuto.
            logger.info("request-otp: codice non inviato (cliente=%s): %s", client.id, exc)
        else:
            ratelimit.hit(issued_key, OTP_MAX_ISSUED_PER_SALON, OTP_WINDOW_SECONDS)
    else:
        _notify_archived_client(salon, find_client_by_phone(salon, data.phone))
    return OkOut()


@router.post("/client/verify-otp", response=ClientAuthOut)
def client_verify_otp(request, data: OTPVerifyIn):
    salon = get_salon_by_slug(data.salon_slug)
    # Anche qui un tetto per indirizzo: il numero sconosciuto non ha un cliente
    # su cui contare i tentativi, quindi senza questo l'endpoint resterebbe
    # l'unico punto senza limiti del flusso di accesso.
    ip = ratelimit.client_ip(request)
    ratelimit.enforce(
        f"otp-verify-ip:{ip}", OTP_VERIFY_MAX_PER_IP, OTP_WINDOW_SECONDS,
        "Troppi tentativi: riprova tra qualche minuto",
    )
    client = _active_client_by_phone(salon, data.phone)
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
    values = {}
    if "lang" in updates:
        if updates["lang"] not in ("it", "en"):
            raise HttpError(400, "Lingua non valida")
        values["lang"] = updates["lang"]
    if "email" in updates:
        values["email"] = (updates["email"] or "").strip()
    if "whatsapp_reminders" in updates:
        values["whatsapp_reminders"] = bool(updates["whatsapp_reminders"])
    changed = [name for name, value in values.items() if getattr(client, name) != value]
    for name in changed:
        setattr(client, name, values[name])
    if not changed:
        return _client_profile(client)
    # Solo le colonne toccate: il save() completo riscriveva la scheda letta
    # all'autenticazione, cioè riportava indietro nome, consensi, etichette o
    # dati Stripe cambiati nel frattempo dal salone o dal webhook (18-07).
    client.save(update_fields=changed)
    # La scheda aperta in dashboard si ricarica su `client.updated` con il suo
    # id: senza, la reception continuava a vedere lingua ed email di prima.
    log_activity(
        request.auth.salon,
        "client.updated",
        f"{client.full_name} ha aggiornato il profilo dall'app",
        payload={"client_id": client.id, "fields": changed},
    )
    return _client_profile(client)
