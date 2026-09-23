"""Login con Yourang: da un'identità Yourang a una sessione staff beauty.

L'identità arriva dal proxy (riscatto del link code), non più da uno scambio
OAuth locale: il portale non vede mai un token Yourang. La logica di
risoluzione qui sotto è invariata — risolve o provisiona Salone + Utente +
Membership a partire da `org` e dai claim identità, poi conia i token staff e
(best-effort) sincronizza.

Precedenza (il SALONE si risolve dall'org, l'UTENTE sempre dall'identità Yourang):
  A. `org` già mappata su un salone (login precedente / connect) → entra lì come
     membro (owner solo se il salone non ha ancora nessuno). La connessione non
     si tocca: chi accede non la ridefinisce.
  B. utente noto per email VERIFICATA, con saloni senza connessione:
     - è TITOLARE di uno solo di essi → lo adotta e lo collega all'org;
     - altrimenti (non titolare, o titolare di più d'uno) → entra nel primo
       SENZA collegarlo: il collegamento si fa dalle Impostazioni, dal titolare.
  C. altrimenti → provisiona utente (se serve) + salone nuovo, collegato.
"""

import logging

from django.db import IntegrityError, transaction
from django.utils.text import slugify

from apps.accounts.models import Membership, User
from apps.core.models import Location, Salon, SalonSettings
from common.auth import create_staff_tokens

from . import client as yc
from .connection import OrgConflict, link_org
from .models import YourangConnection
from .sync import _split_name, schedule_initial_sync

logger = logging.getLogger("youty.integrations")

def _unique_salon_slug(seed: str) -> str:
    base = slugify(seed)[:40] or "salone"
    slug, i = base, 1
    while Salon.objects.filter(slug=slug).exists():
        i += 1
        slug = f"{base}-{i}"[:50]
    return slug


def _get_or_create_user(email: str, name: str, email_verified: bool) -> User:
    user = User.objects.filter(email__iexact=email).first()
    if user:
        # Anti account-takeover (come food): colleghiamo un account beauty già
        # esistente solo se Yourang certifica l'email come verificata.
        if not email_verified:
            raise ValueError("Email Yourang non verificata: account già esistente")
        return user
    first, last = _split_name(name)
    # password=None → set_unusable_password: l'accesso avviene solo via Yourang.
    return User.objects.create_user(email=email, password=None, first_name=first, last_name=last)


def _membership_for(salon: Salon, user: User) -> Membership | None:
    return (
        Membership.objects.select_related("user", "salon", "role")
        .filter(salon=salon, user=user)
        .first()
    )


@transaction.atomic
def _provision_salon(user: User, display_name: str) -> Salon:
    salon = Salon.objects.create(name=display_name, slug=_unique_salon_slug(display_name))
    SalonSettings.objects.get_or_create(salon=salon)
    Location.objects.create(salon=salon, name=display_name, is_default=True)
    Membership.objects.create(user=user, salon=salon, is_owner=True)
    return salon


def _session_payload(membership: Membership, tokens: dict) -> dict:
    salon, user = membership.salon, membership.user
    return {
        "user": {"id": user.id, "email": user.email, "name": user.get_full_name() or user.email},
        "salon": {"id": salon.id, "name": salon.name, "slug": salon.slug},
        "scopes": sorted(membership.role.scopes or []) if membership.role else [],
        "is_owner": membership.is_owner,
        **tokens,
    }


def _unlinked_memberships(user: User) -> list[Membership]:
    """Membership dell'utente in saloni senza connessione Yourang, titolari prima."""
    memberships = (
        Membership.objects.filter(user=user, salon__yourang_connection__isnull=True)
        .select_related("salon")
        .order_by("id")
    )
    return sorted(memberships, key=lambda m: not m.is_owner)  # stabile: poi per id


def _adoptable_salon(user: User) -> Salon | None:
    """Il salone che «Accedi con Yourang» può collegare da solo, se c'è.

    Solo uno di cui l'utente è TITOLARE, e solo se è l'unico senza connessione.
    Prima si adottava il primo salone senza connessione in cui l'utente era
    membro: un'operatrice con una sua org Yourang collegava il salone di un
    altro alla propria org (anagrafica spinta lì, webhook del salone suoi), e il
    titolare di «Centro» e «Mare» che accedeva con l'org di Mare collegava Centro.
    """
    owned = [m.salon for m in _unlinked_memberships(user) if m.is_owner]
    return owned[0] if len(owned) == 1 else None


def _resolve_salon(org: str, email: str, email_verified: bool) -> tuple[Salon | None, User | None]:
    # A. org già collegata a un salone → si entra lì, ma con l'identità di CHI
    # sta accedendo (non con quella del titolare): il collega che apre la stessa
    # org su Yourang deve diventare un membro, non impersonare il proprietario.
    if org:
        conn = YourangConnection.objects.select_related("salon").filter(yourang_org_id=org).first()
        if conn:
            return conn.salon, None
    # B. utente noto (email verificata) → un suo salone senza connessione: quello
    # adottabile se c'è (vedi _adoptable_salon), altrimenti il primo, in cui
    # entra senza collegarlo.
    if email_verified:
        user = User.objects.filter(email__iexact=email).first()
        if user:
            free = _unlinked_memberships(user)
            adoptable = _adoptable_salon(user)
            if adoptable is not None:
                return adoptable, user
            if free:
                return free[0].salon, user
            return None, user  # ha solo saloni già collegati → provisiona un nuovo salone
    return None, None


def _enter(org: str, email: str, email_verified: bool, name: str):
    """Risolve (o provisiona) salone, utente e membership; collega l'org se tocca.

    Ritorna (membership, connessione collegata ORA oppure None).
    """
    salon, user = _resolve_salon(org, email, email_verified)
    link = False
    if salon is None:
        user = user or _get_or_create_user(email, name, email_verified)
        salon = _provision_salon(user, name)
        link = True
    elif user is None:
        # Caso A: org già collegata a questo salone, niente da ricollegare.
        user = _get_or_create_user(email, name, email_verified)
    else:
        adoptable = _adoptable_salon(user)
        link = adoptable is not None and adoptable.pk == salon.pk

    if _membership_for(salon, user) is None:
        Membership.objects.create(
            user=user, salon=salon,
            is_owner=not Membership.objects.filter(salon=salon).exists(),
        )

    # Nessun token da salvare: li custodisce il proxy. Nessuna registrazione
    # webhook: il consenso provisiona l'endpoint (client+org) verso /hooks/<slug>.
    conn = link_org(salon, org, user) if link else None
    return _membership_for(salon, user), conn


def login_with_link_code(code: str) -> dict:
    identity = yc.redeem_link_code(code)
    org = str(identity.get("org_id") or "")
    if not org:
        # Stesso controllo che fa già il connect (api.py): senza organizzazione
        # non c'è nulla da collegare, e proseguire significava provisionare un
        # salone nuovo e vuoto a OGNI accesso — più la riga di connessione
        # riscritta con yourang_org_id="", che spegne il routing dei webhook.
        raise ValueError("Identità Yourang senza organizzazione")
    email = (identity.get("email") or "").strip()
    if not email:
        raise ValueError("Email non disponibile dall'identità Yourang")
    email_verified = bool(identity.get("email_verified"))
    name = (identity.get("name") or "").strip() or email.split("@")[0]

    # Tutto il primo accesso in una transazione. Due accessi simultanei della
    # stessa org (doppio clic, due dispositivi) correvano su slug del salone,
    # email dell'utente e vincolo unico dell'org: chi perdeva usciva con un
    # IntegrityError non gestito (500) lasciando a metà salone e membership.
    # Ora chi perde torna indietro per intero e riprova una volta: a quel punto
    # l'org (o l'utente) del vincitore è visibile e si entra lì.
    for attempt in (1, 2):
        try:
            with transaction.atomic():
                membership, conn = _enter(org, email, email_verified, name)
            break
        except (IntegrityError, OrgConflict):
            if attempt == 2:
                raise
            logger.info("Yourang login: accesso concorrente della stessa org, si riprova")

    if conn is not None:
        # La prima sync (migliaia di chiamate su un salone grande) parte fuori
        # dalla richiesta; il suo esito finisce su last_sync_at / last_error.
        schedule_initial_sync(conn)
    tokens = create_staff_tokens(membership.user, membership.salon)
    return _session_payload(membership, tokens)
