from datetime import datetime
from typing import Optional
from uuid import UUID

from ninja import Schema
from pydantic import Field


# ---- Staff auth --------------------------------------------------------------


class StaffLoginIn(Schema):
    email: str
    password: str


class PasswordChangeIn(Schema):
    current_password: str
    new_password: str


class RefreshIn(Schema):
    refresh: str


class UserBriefOut(Schema):
    id: int
    email: str
    name: str


class SalonBriefOut(Schema):
    id: int
    name: str
    slug: str


class MeOut(Schema):
    user: UserBriefOut
    salon: SalonBriefOut
    scopes: list[str]
    is_owner: bool


class StaffAuthOut(MeOut):
    access: str
    refresh: str


# ---- Ruoli e membri ----------------------------------------------------------


class RoleIn(Schema):
    name: str
    scopes: list[str] = []


class RoleOut(Schema):
    id: int
    name: str
    scopes: list[str]
    is_system: bool


class OperatorBriefOut(Schema):
    """La scheda Staff collegata a un accesso (o da collegare con un invito)."""

    id: int
    name: str


class MemberOut(Schema):
    id: int  # id della membership
    user: UserBriefOut
    role: Optional[RoleOut] = None
    is_owner: bool
    # la sua scheda Staff, se è collegata (Operator.user)
    operator: Optional[OperatorBriefOut] = None


class MemberRoleIn(Schema):
    role_id: Optional[int] = None  # None = rimuove il ruolo


# ---- Inviti ------------------------------------------------------------------


class InvitationIn(Schema):
    email: str = Field(max_length=254)
    role_id: int
    # la scheda Staff da collegare a chi accetta (facoltativa)
    operator_id: Optional[int] = None


class InvitationOut(Schema):
    id: int
    email: str
    role: RoleOut
    operator: Optional[OperatorBriefOut] = None
    # None per chi non potrebbe concedere il ruolo dell'invito (e per gli inviti
    # non più accettabili): il codice È l'account, vedi `list_invitations`.
    token: Optional[UUID] = None
    # La pagina dove si accetta (/invito/<codice>), con la stessa regola del codice.
    link: Optional[str] = None
    status: str
    expires_at: datetime
    created_at: datetime
    sent_at: Optional[datetime] = Field(None, description="Quando è partita l'ultima mail")
    send_error: str = Field("", description="Perché l'ultima mail non è partita")
    # Il server può mandare mail? Senza, il link lo manda il titolare.
    can_email: bool = False
    # Solo nella risposta di creazione e reinvio: la mail è partita adesso?
    email_sent: Optional[bool] = None


class InvitationAcceptIn(Schema):
    """Account nuovo: nome, cognome e password scelti qui. Account già
    esistente con l'email dell'invito: la sua password (nome e cognome si
    ignorano)."""

    token: str
    password: str
    first_name: str = Field("", max_length=150)
    last_name: str = Field("", max_length=150)


class InvitationTokenIn(Schema):
    token: str


class InvitationPreviewOut(Schema):
    """La pagina dell'invito, prima di accettare."""

    email: str
    salon_name: str
    role_name: str
    invited_by: str = ""
    status: str
    expires_at: datetime
    # c'è già un account con questa email (allora si accetta con la sua password)
    has_account: bool
    # …e ha una password (chi entra con Yourang no: accetta con la sessione)
    has_password: bool


# ---- Cliente (web app) -------------------------------------------------------


class ClientRegisterIn(Schema):
    salon_slug: str
    first_name: str
    last_name: str
    phone: str
    email: str = ""
    lang: str = "it"


class OTPRequestIn(Schema):
    salon_slug: str
    phone: str


class OTPVerifyIn(Schema):
    salon_slug: str
    phone: str
    code: str


class ClientBriefOut(Schema):
    id: int
    first_name: str
    lang: str


class ClientAuthOut(Schema):
    access: str
    client: ClientBriefOut


class ClientMeOut(Schema):
    id: int
    first_name: str
    last_name: str
    phone: str
    email: str
    lang: str
    whatsapp_reminders: bool
    # Lo si cambia con POST /api/marketing/client/marketing-consent {accepted}.
    marketing_consent: bool = False


class ClientMeIn(Schema):
    lang: Optional[str] = None
    email: Optional[str] = None
    whatsapp_reminders: Optional[bool] = None
