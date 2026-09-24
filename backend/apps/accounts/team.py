"""Team e ruoli: chi può concedere quali permessi, e come si presentano membri, ruoli e inviti.

Le regole di concessione stavano in mezzo agli endpoint di accounts/api.py:
qui sono tutte insieme, perché valgono allo stesso modo per i ruoli, per i
membri e per gli inviti (un invito è un account con un ruolo). Il titolare ne
è esente: i permessi sono suoi per definizione.
"""

from ninja.errors import HttpError

from common.permissions import SCOPES

from .sessions import user_out


def role_out(role) -> dict | None:
    if role is None:
        return None
    return {
        "id": role.id,
        "name": role.name,
        "scopes": role.scopes or [],
        "is_system": role.is_system,
    }


def member_out(membership) -> dict:
    return {
        "id": membership.id,
        "user": user_out(membership.user),
        "role": role_out(membership.role),
        "is_owner": membership.is_owner,
    }


def invitation_out(invitation, *, with_token: bool) -> dict:
    return {
        "id": invitation.id,
        "email": invitation.email,
        "role": role_out(invitation.role),
        "token": invitation.token if with_token else None,
        "status": invitation.status,
        "expires_at": invitation.expires_at,
        "created_at": invitation.created_at,
    }


def validate_scopes(scopes: list[str]) -> None:
    for scope in scopes:
        if scope not in SCOPES:
            raise HttpError(400, f"Scope non valido: {scope}")


def require_grantable(ctx, scopes) -> None:
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


def require_can_touch_role(ctx, role) -> None:
    """Un ruolo si modifica o si elimina solo se non è più potente di chi lo tocca.

    Senza questo, chi ha il solo `team` poteva riscrivere il ruolo del collega
    responsabile magazzino: non gli dava permessi nuovi, ma gli lasciava
    togliere a chiunque quelli che aveva.
    """
    require_grantable(ctx, role.scopes or [])


def can_grant(ctx, role) -> bool:
    """Vero se chi chiama potrebbe assegnare `role` (stessa regola di `require_grantable`)."""
    return ctx.is_owner or all(s in ctx.scopes for s in (role.scopes or []))
