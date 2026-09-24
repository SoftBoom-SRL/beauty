"""Sessione staff: quando vale, con quali permessi, che cosa ne riceve la dashboard.

Le stesse regole erano scritte a mano in quattro posti — l'autenticazione di
ogni richiesta (`common.auth.StaffAuth`), il rinnovo del refresh, lo stream
live (`core.views.stream_access`) e l'accesso con Yourang — e bastava
cambiarne uno per avere una sessione valida per l'API e non per lo stream, o
un payload di login diverso dall'altro. Qui ci sono una volta sola; ciascun
chiamante decide cosa rispondere quando la sessione non vale (None, un 401 con
il suo messaggio, lo stream che si chiude) e come legge i claim del token.
"""

from django.db.models import Case, IntegerField, Value, When

from .models import Membership


def find_membership(user_id, salon_id, *, related=("user", "salon", "role")) -> Membership | None:
    """Membership dell'utente nel salone, se l'utente è ancora attivo; None altrimenti.

    Una sessione vale finché la persona fa parte del salone e il suo account
    non è stato disattivato: tolta dal team o disattivata da /admin/, i suoi
    token smettono di valere alla richiesta successiva. `related` sono le
    relazioni lette insieme (lo stream non ha bisogno del salone).
    """
    return (
        Membership.objects.select_related(*related)
        .filter(
            user_id=user_id,
            salon_id=salon_id,
            user__is_active=True,
        )
        .first()
    )


def tv_matches(membership, claimed_tv) -> bool:
    """Vero se il token porta la versione della password attuale dell'utente.

    `User.set_password` incrementa `token_version`: un token emesso prima di un
    cambio password non vale più. Chi chiama legge il claim con il suo default
    (`payload.get("tv", 0)`): i token emessi prima dell'introduzione di "tv"
    valgono 0, come il default sull'utente, e restano validi finché la
    password non cambia.
    """
    return claimed_tv == (membership.user.token_version or 0)


def membership_scopes(membership) -> list:
    """Permessi della membership: quelli del suo ruolo, nessuno senza ruolo.

    La lista del ruolo così com'è: chi la usa ne fa un insieme (StaffContext)
    o la ordina (payload di sessione, stream), e non la modifica.
    """
    return (membership.role.scopes or []) if membership.role else []


def user_out(user) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.get_full_name() or user.email,
    }


def session_payload(membership, tokens: dict | None = None) -> dict:
    """Chi è entrato e dove: la risposta di login, rinnovo, /me e accesso con Yourang.

    Con `tokens` (access e refresh appena coniati) diventa la risposta di un
    accesso; senza, è quella di /me.
    """
    salon = membership.salon
    out = {
        "user": user_out(membership.user),
        "salon": {"id": salon.id, "name": salon.name, "slug": salon.slug},
        "scopes": sorted(membership_scopes(membership)),
        "is_owner": membership.is_owner,
    }
    if tokens:
        out.update(tokens)
    return out


def first_membership(user) -> Membership | None:
    """Il salone in cui entra chi fa login (v1: un salone per sessione, niente selettore).

    Con più membership prendeva la più vecchia e basta: la ex collaboratrice
    che apre il suo salone con la stessa email (create_salon) entrava sempre
    in quello di prima, dove magari non ha più nemmeno un ruolo, e il suo non
    lo raggiungeva mai (08-08). Ora l'ordine è: dove è titolare, poi dove ha
    un ruolo (una membership senza ruolo non apre nulla), poi la più vecchia.
    A parità di dati la scelta è sempre la stessa; per il titolare di due
    saloni resta il primo, come prima: il secondo richiede un selettore.
    """
    return (
        Membership.objects.select_related("user", "salon", "role")
        .filter(user=user)
        .annotate(
            senza_ruolo=Case(
                When(role__isnull=True, then=Value(1)), default=Value(0), output_field=IntegerField()
            )
        )
        .order_by("-is_owner", "senza_ruolo", "id")
        .first()
    )
