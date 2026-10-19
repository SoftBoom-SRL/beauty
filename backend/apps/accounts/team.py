"""Team e ruoli: chi può concedere quali permessi, e come si presentano membri, ruoli e inviti.

Le regole di concessione stavano in mezzo agli endpoint di accounts/api.py:
qui sono tutte insieme, perché valgono allo stesso modo per i ruoli, per i
membri e per gli inviti (un invito è un account con un ruolo). Il titolare ne
è esente: i permessi sono suoi per definizione.
"""

from django.conf import settings
from django.db import transaction
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


def operator_brief(operator) -> dict | None:
    if operator is None:
        return None
    return {"id": operator.id, "name": f"{operator.first_name} {operator.last_name}".strip()}


def member_out(membership, operator=None) -> dict:
    """`operator` = la sua scheda Staff, se collegata (Operator.user)."""
    return {
        "id": membership.id,
        "user": user_out(membership.user),
        "role": role_out(membership.role),
        "is_owner": membership.is_owner,
        "operator": operator_brief(operator),
    }


def invitation_out(invitation, *, with_token: bool, email_sent: bool | None = None) -> dict:
    from .invitations import invite_link  # gli inviti usano queste regole

    return {
        "id": invitation.id,
        "email": invitation.email,
        "role": role_out(invitation.role),
        "operator": operator_brief(invitation.operator),
        "token": invitation.token if with_token else None,
        # il link è il codice: stessa regola
        "link": invite_link(invitation) if with_token else None,
        "status": invitation.status,
        "expires_at": invitation.expires_at,
        "created_at": invitation.created_at,
        "sent_at": invitation.sent_at,
        "send_error": invitation.send_error,
        "can_email": settings.EMAIL_ENABLED,
        "email_sent": email_sent,
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


class NotOwner(Exception):
    """Chi doveva cedere la titolarità non è (più) il titolare."""


@transaction.atomic
def make_owner(target, *, from_membership=None) -> None:
    """Rende `target` l'unico titolare del suo salone.

    La usano la cessione dalla dashboard e «Accedi con Yourang» (il titolare
    dell'org Yourang diventa titolare del salone). I titolari attuali vengono
    letti sotto lock: due passaggi simultanei non lasciano due titolari. Chi
    smette di esserlo resta nel team; se non aveva un ruolo riceve «Manager»,
    così non si ritrova chiuso fuori. Con `from_membership` si cede solo se
    quella membership è ancora titolare (altrimenti NotOwner).
    """
    from .models import Membership, Role

    owners = list(
        Membership.objects.select_for_update().filter(salon_id=target.salon_id, is_owner=True)
    )
    if from_membership is not None and from_membership.pk not in {m.pk for m in owners}:
        raise NotOwner
    manager = None
    for m in owners:
        if m.pk == target.pk:
            continue
        m.is_owner = False
        if m.role_id is None:
            manager = manager or Role.objects.filter(
                salon_id=target.salon_id, name="Manager", is_system=True
            ).first()
            m.role = manager
        m.save(update_fields=["is_owner", "role"])
    if not target.is_owner:
        target.is_owner = True
        target.save(update_fields=["is_owner"])
