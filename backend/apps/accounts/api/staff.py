"""Endpoint /api/auth dello staff: accesso, rinnovo con rotazione, uscita, cambio password.

Le regole di validità della sessione stanno in accounts.sessions; qui ci sono
i tetti ai tentativi e la rotazione del refresh.
"""

import datetime as dt
import hashlib
import logging

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import log_activity
from common import ratelimit
from common.auth import create_staff_tokens, decode_token, staff_auth
from common.schemas import OkOut

from ..models import StaffRefreshToken, User
from ..schemas import MeOut, PasswordChangeIn, RefreshIn, StaffAuthOut, StaffLoginIn
from ..sessions import find_membership, first_membership, session_payload, tv_matches

# Sotto «youty», come gli altri logger del progetto: la configurazione
# (LOGGING) stampa gli INFO solo lì. Col nome di prima, «apps.accounts.api», le
# righe passavano dalla radice, che è a WARNING, e gli INFO (per esempio
# «codice non inviato») non comparivano mai.
logger = logging.getLogger("youty.accounts")

router = Router()


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
