"""Inviti al team: la mail con il link, l'accettazione e il collegamento alla
scheda Staff.

Prima l'invito era un codice da copiare a mano: nessuna mail partiva (il
titolare non lo sapeva: «non arrivano le mail») e nel gestionale non c'era
nemmeno una pagina dove usarlo. Ora l'invito è un LINK (`invite_link`, la
pagina /invito/<codice> della dashboard): parte per mail se il server SMTP è
configurato (settings.EMAIL_*), altrimenti il titolare lo manda da sé.

Chi accetta può essere nuovo (sceglie nome e password) o avere già un account
con quella email: allora conferma la sua password, o entra con la sessione che
ha già aperta (chi accede con Yourang non ha una password). L'invito può
portare la scheda Staff da collegare: l'operatrice che entra nel gestionale si
ritrova legata alla sua colonna in agenda.

api/team.py controlla i permessi (chi può concedere quel ruolo) e chiama
queste funzioni.
"""

import logging

from django.conf import settings
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.mail import EmailMultiAlternatives
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.html import escape
from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity

from .models import Invitation, Membership, User, default_invitation_expiry

logger = logging.getLogger("youty.accounts")


def invite_link(invitation) -> str:
    """La pagina della dashboard dove si accetta l'invito."""
    return f"{settings.FRONTEND_ORIGIN.rstrip('/')}/invito/{invitation.token}"


def is_open(invitation) -> bool:
    """In attesa e non scaduto: si può ancora accettare."""
    return invitation.status == Invitation.Status.PENDING and invitation.expires_at > timezone.now()


# ---- la mail ---------------------------------------------------------------------

_TEXTS = {
    "it": {
        "subject": "Entra nel team di {salon}",
        "hello": "Ciao,",
        "invited": "{who} ti invita a entrare nel team di {salon} come «{role}».",
        "invited_anon": "Sei invitato a entrare nel team di {salon} come «{role}».",
        "open": "Per entrare apri questo link e scegli la tua password:",
        "button": "Entra nel team",
        "until": "Il link vale fino al {date}. Se non ti aspettavi questo invito, ignora questa mail.",
    },
    "en": {
        "subject": "Join the {salon} team",
        "hello": "Hi,",
        "invited": "{who} invites you to join the {salon} team as “{role}”.",
        "invited_anon": "You are invited to join the {salon} team as “{role}”.",
        "open": "To join, open this link and choose your password:",
        "button": "Join the team",
        "until": "The link is valid until {date}. If you were not expecting this invitation, ignore this email.",
    },
}


def _message(invitation) -> tuple[str, str, str]:
    """Oggetto, testo e HTML della mail, nella lingua del salone."""
    salon = invitation.salon
    tx = _TEXTS.get(getattr(salon, "default_lang", "it"), _TEXTS["it"])
    who = invitation.invited_by.get_full_name() if invitation.invited_by else ""
    invited = (tx["invited"] if who else tx["invited_anon"]).format(who=who, salon=salon.name, role=invitation.role.name)
    until = tx["until"].format(date=timezone.localtime(invitation.expires_at).strftime("%d/%m/%Y"))
    link = invite_link(invitation)
    text = f"{tx['hello']}\n\n{invited}\n\n{tx['open']}\n{link}\n\n{until}\n"
    html = (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">'
        f"<p>{escape(tx['hello'])}</p><p>{escape(invited)}</p>"
        f'<p><a href="{escape(link)}" style="display:inline-block;padding:11px 20px;border-radius:10px;'
        f'background:#5B5BD6;color:#ffffff;text-decoration:none;font-weight:bold">{escape(tx["button"])}</a></p>'
        f'<p style="font-size:13px;color:#6b7280">{escape(tx["open"])}<br><a href="{escape(link)}">{escape(link)}</a></p>'
        f'<p style="font-size:13px;color:#6b7280">{escape(until)}</p></div>'
    )
    return tx["subject"].format(salon=salon.name), text, html


def send_invitation_email(invitation) -> bool:
    """Manda la mail con il link; True se è partita.

    Senza server SMTP (settings.EMAIL_ENABLED) non parte nulla e si dice di no:
    il gestionale propone al titolare di mandare lui il link. Un errore del
    server si scrive in `send_error` e non ferma l'invito, per lo stesso motivo.
    """
    if not settings.EMAIL_ENABLED:
        return False
    subject, text, html = _message(invitation)
    reply_to = [invitation.invited_by.email] if invitation.invited_by and invitation.invited_by.email else None
    try:
        msg = EmailMultiAlternatives(subject, text, to=[invitation.email], reply_to=reply_to)
        msg.attach_alternative(html, "text/html")
        msg.send()
    except Exception as exc:  # SMTP giù, credenziali sbagliate, indirizzo rifiutato…
        logger.warning("Invito %s: mail non partita (%s)", invitation.id, exc)
        invitation.send_error = str(exc)[:255]
        invitation.save(update_fields=["send_error"])
        return False
    invitation.sent_at = timezone.now()
    invitation.send_error = ""
    invitation.save(update_fields=["sent_at", "send_error"])
    return True


# ---- creare, reinviare, annullare --------------------------------------------------


def create_invitation(ctx, email: str, role, operator=None) -> tuple[Invitation, bool]:
    """Crea l'invito (sostituisce quello ancora aperto alla stessa email) e
    prova a mandare la mail. Ritorna (invito, mail partita).

    Chi invitava di nuovo la stessa persona (la prima mail non era arrivata)
    lasciava in giro due codici validi con ruoli magari diversi: ora vale
    l'ultimo, e il precedente risulta annullato.
    """
    email = email.strip().lower()
    if Membership.objects.filter(salon=ctx.salon, user__email__iexact=email).exists():
        raise HttpError(400, "Questa persona fa già parte del team")
    if operator is not None and operator.user_id is not None:
        raise HttpError(400, f"{operator.first_name} {operator.last_name} ha già un accesso collegato".strip())
    with transaction.atomic():
        Invitation.objects.filter(
            salon=ctx.salon, email__iexact=email, status=Invitation.Status.PENDING
        ).update(status=Invitation.Status.REVOKED)
        invitation = Invitation.objects.create(
            salon=ctx.salon, email=email, role=role, operator=operator, invited_by=ctx.user
        )
    sent = send_invitation_email(invitation)
    emit_event(
        ctx.salon,
        "team.invitation",
        {
            "invitation_id": invitation.id,
            "email": invitation.email,
            "role": role.name,
            "token": str(invitation.token),
            "accept_url": invite_link(invitation),
            # già spedita dal gestionale: chi consegna gli eventi non la rimanda
            "email_sent": sent,
            "expires_at": invitation.expires_at.isoformat(),
        },
    )
    log_activity(
        ctx.salon,
        "team.invitation_created",
        f"Invito {'inviato per mail' if sent else 'creato'} a {invitation.email} ({role.name})",
        actor=ctx.user,
        payload={"invitation_id": invitation.id, "role_id": role.id, "email_sent": sent},
    )
    return invitation, sent


def resend_invitation(ctx, invitation) -> bool:
    """Rimanda la mail, con la validità di nuovo piena (anche a un invito
    scaduto: è la stessa persona, con lo stesso ruolo)."""
    if invitation.status not in (Invitation.Status.PENDING, Invitation.Status.EXPIRED):
        raise HttpError(400, "Questo invito non è più valido: creane uno nuovo")
    invitation.status = Invitation.Status.PENDING
    invitation.expires_at = default_invitation_expiry()
    invitation.save(update_fields=["status", "expires_at"])
    sent = send_invitation_email(invitation)
    log_activity(
        ctx.salon,
        "team.invitation_resent",
        f"Invito {'rimandato per mail' if sent else 'rinnovato'} a {invitation.email}",
        actor=ctx.user,
        payload={"invitation_id": invitation.id, "email_sent": sent},
    )
    return sent


def revoke_invitation(ctx, invitation) -> None:
    if invitation.status != Invitation.Status.PENDING:
        raise HttpError(400, "Questo invito non è più in attesa")
    invitation.status = Invitation.Status.REVOKED
    invitation.save(update_fields=["status"])
    log_activity(
        ctx.salon,
        "team.invitation_revoked",
        f"Invito annullato: {invitation.email}",
        actor=ctx.user,
        payload={"invitation_id": invitation.id},
    )


# ---- accettare ----------------------------------------------------------------------


def open_invitation(token) -> Invitation:
    """L'invito del codice, se si può ancora accettare (404 / 400 altrimenti)."""
    try:
        invitation = Invitation.objects.select_related("salon", "role", "operator").get(token=token)
    except (Invitation.DoesNotExist, ValidationError, ValueError):
        raise HttpError(404, "Invito non trovato")
    if invitation.status == Invitation.Status.PENDING and invitation.expires_at < timezone.now():
        invitation.status = Invitation.Status.EXPIRED
        invitation.save(update_fields=["status"])
    if invitation.status == Invitation.Status.EXPIRED:
        raise HttpError(400, "Invito scaduto: chiedi a chi ti ha invitato di rimandarlo")
    if invitation.status != Invitation.Status.PENDING:
        raise HttpError(400, "Invito non più valido")
    return invitation


def _link_operator(invitation, user) -> None:
    """Lega l'account alla scheda Staff dell'invito, se è ancora libera e
    l'account non è già legato a un'altra scheda di questo salone."""
    operator = invitation.operator
    if operator is None or operator.salon_id != invitation.salon_id or operator.user_id is not None:
        return
    from apps.staff.models import Operator  # lazy: lo staff dipende dagli account

    if Operator.objects.filter(user=user).exists():
        return
    operator.user = user
    operator.save(update_fields=["user"])


def _join(invitation, user) -> Membership:
    """Entra nel salone con il ruolo dell'invito, una volta sola.

    Lo stato si ricontrolla sulla riga bloccata e riletta: letto a inizio
    richiesta, due accettazioni simultanee dello stesso codice passavano
    entrambe (10-01).
    """
    locked = (
        Invitation.objects.select_for_update()
        .filter(pk=invitation.pk, status=Invitation.Status.PENDING)
        .first()
    )
    if locked is None:
        raise HttpError(400, "Invito non più valido")
    membership = Membership.objects.filter(salon=invitation.salon, user=user).first()
    if membership is None:
        membership = Membership.objects.create(user=user, salon=invitation.salon, role=invitation.role)
    elif membership.role_id is None and not membership.is_owner:
        # Entrata con «Accedi con Yourang» senza ruolo: l'invito gliene dà uno
        membership.role = invitation.role
        membership.save(update_fields=["role"])
    _link_operator(invitation, user)
    invitation.status = Invitation.Status.ACCEPTED
    invitation.save(update_fields=["status"])
    log_activity(
        invitation.salon,
        "team.invitation_accepted",
        f"{user.get_full_name() or user.email} è entrato nel team",
        actor=user,
        payload={"invitation_id": invitation.id, "operator_id": invitation.operator_id},
    )
    return membership


def accept_invitation(token, *, password: str, first_name: str = "", last_name: str = "") -> Membership:
    """Accetta con le credenziali: account nuovo (nome e password scelti qui)
    o già esistente con quella email (la sua password, per provare che è suo).

    Prima un account esistente era un vicolo cieco («Esiste già un utente con
    questa email»): chi lavora in due saloni non poteva entrare nel secondo.
    """
    invitation = open_invitation(token)
    existing = User.objects.filter(email__iexact=invitation.email).first()
    if existing is not None:
        if not existing.has_usable_password():
            raise HttpError(400, "Il tuo account entra con Yourang: accedi con Yourang e poi riapri questo link")
        if not existing.check_password(password):
            raise HttpError(400, "Password non corretta per questo account")
        with transaction.atomic():
            return _join(invitation, existing)
    if not first_name.strip():
        raise HttpError(400, "Scrivi il tuo nome")
    # Le stesse regole del cambio password: senza questo controllo l'invito
    # creava account con password vuota, che poi funzionava al login. Si valida
    # prima di toccare qualsiasi cosa, così un rifiuto lascia l'invito usabile.
    candidate = User(email=invitation.email, first_name=first_name, last_name=last_name)
    try:
        validate_password(password, candidate)
    except ValidationError as exc:
        raise HttpError(400, " ".join(exc.messages))
    with transaction.atomic():
        try:
            with transaction.atomic():
                user = User.objects.create_user(
                    email=invitation.email, password=password,
                    first_name=first_name.strip(), last_name=last_name.strip(),
                )
        except IntegrityError:
            raise HttpError(400, "Esiste già un utente con questa email: riapri il link e usa la tua password")
        return _join(invitation, user)


def accept_with_session(token, user) -> Membership:
    """Accetta con la sessione già aperta in questo browser (chi entra con
    Yourang non ha una password da confermare). L'email deve essere quella
    dell'invito: il link inoltrato a un collega non gli apre il salone."""
    invitation = open_invitation(token)
    if (user.email or "").lower() != invitation.email.lower():
        raise HttpError(403, f"Questo invito è per {invitation.email}: entra con quell'account")
    with transaction.atomic():
        return _join(invitation, user)


def preview(token) -> dict:
    """Che cosa mostra la pagina dell'invito prima di accettare."""
    try:
        invitation = Invitation.objects.select_related("salon", "role", "invited_by").get(token=token)
    except (Invitation.DoesNotExist, ValidationError, ValueError):
        raise HttpError(404, "Invito non trovato")
    status = invitation.status
    if status == Invitation.Status.PENDING and invitation.expires_at < timezone.now():
        status = Invitation.Status.EXPIRED
    user = User.objects.filter(email__iexact=invitation.email).first()
    return {
        "email": invitation.email,
        "salon_name": invitation.salon.name,
        "role_name": invitation.role.name,
        "invited_by": invitation.invited_by.get_full_name() if invitation.invited_by else "",
        "status": status,
        "expires_at": invitation.expires_at,
        "has_account": user is not None,
        "has_password": bool(user and user.has_usable_password()),
    }
