"""Endpoint /api/auth del team: membri, ruoli e inviti (scope `team`), accettazione dell'invito.

Le regole su chi può concedere che cosa stanno in accounts.team; la mail, il
link e l'accettazione degli inviti in accounts.invitations.
"""

from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import log_activity
from common import ratelimit
from common.auth import create_staff_tokens, staff_auth
from common.permissions import require_scope
from common.schemas import OkOut
from common.utils import salon_get

from .. import invitations as inv
from ..models import Invitation, Membership, Role
from ..schemas import (
    InvitationAcceptIn,
    InvitationIn,
    InvitationOut,
    InvitationPreviewOut,
    InvitationTokenIn,
    MemberOut,
    MemberRoleIn,
    RoleIn,
    RoleOut,
    StaffAuthOut,
)
from ..sessions import session_payload
from ..team import (
    NotOwner,
    can_grant,
    invitation_out,
    make_owner,
    member_out,
    require_can_touch_role,
    require_grantable,
    validate_scopes,
)

router = Router()

# Pagina dell'invito e accettazione sono senza login: tetto per IP, contro chi
# prova codici o password a raffica.
INVITE_PUBLIC_MAX_PER_WINDOW = 30
INVITE_PUBLIC_WINDOW_SECONDS = 600


def _limit_public(request, bucket: str) -> None:
    ratelimit.enforce(
        f"invite-{bucket}:{ratelimit.client_ip(request)}",
        INVITE_PUBLIC_MAX_PER_WINDOW,
        INVITE_PUBLIC_WINDOW_SECONDS,
        "Troppi tentativi: riprova tra qualche minuto",
    )


def _operators_by_user(salon) -> dict:
    """Le schede Staff collegate a un account, per id dell'utente."""
    from apps.staff.models import Operator  # lazy: lo staff dipende dagli account

    return {o.user_id: o for o in Operator.objects.filter(salon=salon, user__isnull=False)}


def _member(membership) -> dict:
    return member_out(membership, _operators_by_user(membership.salon).get(membership.user_id))


# ---- Staff: membri del team ----------------------------------------------------


@router.get("/members", auth=staff_auth, response=list[MemberOut])
def list_members(request):
    """Membri del team, ognuno con la sua scheda Staff se è collegata."""
    ctx = request.auth
    require_scope(ctx, "team")
    memberships = (
        Membership.objects.filter(salon=ctx.salon)
        .select_related("user", "role")
        .order_by("id")
    )
    operators = _operators_by_user(ctx.salon)
    return [member_out(m, operators.get(m.user_id)) for m in memberships]


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
    return _member(membership)


@router.post("/members/{int:member_id}/transfer-ownership", auth=staff_auth, response=MemberOut)
def transfer_ownership(request, member_id: int):
    """Il titolare passa la titolarità del salone a un membro del team.

    Il primo che entra con «Accedi con Yourang» diventa titolare: se il salone
    lo attiva qualcuno di Yourang per conto del cliente, il titolare restava lui
    e non c'era modo di cederlo senza mettere mano al database. Le regole del
    passaggio stanno in `make_owner`.
    """
    ctx = request.auth
    if not ctx.is_owner:
        raise HttpError(403, "Solo il titolare può cedere la titolarità")
    target = salon_get(Membership, ctx, member_id)
    if target.id == ctx.membership.id:
        raise HttpError(400, "Sei già il titolare")
    try:
        make_owner(target, from_membership=ctx.membership)
    except NotOwner:
        raise HttpError(403, "Solo il titolare può cedere la titolarità")
    log_activity(
        ctx.salon,
        "team.ownership_transferred",
        f"Titolarità ceduta a {target.user.get_full_name() or target.user.email}",
        actor=ctx.user,
        payload={"from_membership_id": ctx.membership.id, "to_membership_id": target.id},
    )
    return _member(target)


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
    # Fuori dal team, la sua scheda Staff non resta legata a un accesso che
    # non c'è più (la scheda rimane: turni e storico sono del salone).
    from apps.staff.models import Operator  # lazy: lo staff dipende dagli account

    Operator.objects.filter(salon=ctx.salon, user=membership.user).update(user=None)
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


def _invitation_of(ctx, invitation_id: int) -> Invitation:
    """L'invito del salone che chi chiama può gestire (chi può concedere il suo ruolo)."""
    invitation = salon_get(Invitation, ctx, invitation_id)
    if not can_grant(ctx, invitation.role):
        raise HttpError(403, "Questo invito dà permessi che tu non hai: può gestirlo il titolare")
    return invitation


@router.get("/invitations", auth=staff_auth, response=list[InvitationOut])
def list_invitations(request):
    """Inviti del salone; codice e link solo a chi potrebbe concedere quel ruolo.

    Il codice di un invito vale un account: chi lo presenta a
    `accept_invitation` crea l'utente con la password che sceglie e riceve il
    ruolo dell'invito. Consegnato a chiunque avesse `team`, il front-desk
    copiava il codice dell'invito «Manager» destinato alla nuova assunta e
    diventava Manager lui (10-01). A chi può assegnare quel ruolo invece non
    toglie nulla vederlo: un invito per sé potrebbe crearlo comunque. Il link
    serve quando la mail non parte (server SMTP non configurato): lo manda il
    titolare.
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
        for invitation in Invitation.objects.filter(salon=ctx.salon).select_related("role", "operator")
    ]


@router.post("/invitations", auth=staff_auth, response=InvitationOut)
def create_invitation(request, data: InvitationIn):
    """Invita una persona: le arriva una mail col link (se il server SMTP è
    configurato) e chi invita riceve il link da mandare a mano. Con
    `operator_id` chi accetta si ritrova collegata a quella scheda Staff. Un
    invito ancora aperto alla stessa email viene sostituito."""
    ctx = request.auth
    require_scope(ctx, "team")
    role = salon_get(Role, ctx, data.role_id)
    # L'invito è l'altra strada per fabbricarsi permessi: chi invita sceglie
    # l'email, quindi l'account che nasce è suo a tutti gli effetti.
    require_grantable(ctx, role.scopes or [])
    operator = None
    if data.operator_id is not None:
        from apps.staff.models import Operator  # lazy: lo staff dipende dagli account

        operator = salon_get(Operator, ctx, data.operator_id)
    invitation, sent = inv.create_invitation(ctx, data.email, role, operator)
    # Chi l'ha appena creato ha superato `require_grantable`: il codice è suo.
    return invitation_out(invitation, with_token=True, email_sent=sent)


@router.post("/invitations/{int:invitation_id}/resend", auth=staff_auth, response=InvitationOut)
def resend_invitation(request, invitation_id: int):
    """Rimanda la mail dell'invito, con la validità di nuovo piena (anche se
    era scaduto)."""
    ctx = request.auth
    require_scope(ctx, "team")
    invitation = _invitation_of(ctx, invitation_id)
    sent = inv.resend_invitation(ctx, invitation)
    return invitation_out(invitation, with_token=True, email_sent=sent)


@router.delete("/invitations/{int:invitation_id}", auth=staff_auth, response=OkOut)
def revoke_invitation(request, invitation_id: int):
    """Annulla un invito in attesa: il suo link non apre più niente."""
    ctx = request.auth
    require_scope(ctx, "team")
    inv.revoke_invitation(ctx, _invitation_of(ctx, invitation_id))
    return OkOut()


@router.get("/invitations/preview", response=InvitationPreviewOut)
def preview_invitation(request, token: str):
    """La pagina dell'invito (senza login): salone, ruolo, email, se è ancora
    valido e se c'è già un account con quell'email."""
    _limit_public(request, "preview")
    return inv.preview(token)


@router.post("/invitations/accept", response=StaffAuthOut)
def accept_invitation(request, data: InvitationAcceptIn):
    """Accetta l'invito ed entra (senza login). Account nuovo: nome, cognome e
    password; account già esistente con l'email dell'invito: la sua password."""
    _limit_public(request, "accept")
    membership = inv.accept_invitation(
        data.token, password=data.password, first_name=data.first_name, last_name=data.last_name
    )
    tokens = create_staff_tokens(membership.user, membership.salon)
    return session_payload(membership, tokens)


@router.post("/invitations/accept-session", auth=staff_auth, response=StaffAuthOut)
def accept_invitation_with_session(request, data: InvitationTokenIn):
    """Accetta con la sessione già aperta (chi entra con Yourang non ha una
    password): l'email dell'account deve essere quella dell'invito. Risponde
    con la sessione del salone dell'invito."""
    membership = inv.accept_with_session(data.token, request.auth.user)
    tokens = create_staff_tokens(membership.user, membership.salon)
    return session_payload(membership, tokens)
