"""Endpoint /api/auth del team: membri, ruoli e inviti (scope `team`), accettazione dell'invito.

Le regole su chi può concedere che cosa stanno in accounts.team.
"""

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity
from common.auth import create_staff_tokens, staff_auth
from common.permissions import require_scope
from common.schemas import OkOut
from common.utils import salon_get

from ..models import Invitation, Membership, Role, User
from ..schemas import (
    InvitationAcceptIn,
    InvitationIn,
    InvitationOut,
    MemberOut,
    MemberRoleIn,
    RoleIn,
    RoleOut,
    StaffAuthOut,
)
from ..sessions import session_payload
from ..team import (
    can_grant,
    invitation_out,
    member_out,
    require_can_touch_role,
    require_grantable,
    validate_scopes,
)

router = Router()


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
