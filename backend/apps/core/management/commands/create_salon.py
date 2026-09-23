"""Onboarding di un salone reale: crea la fondazione minima e nient'altro.

    python manage.py create_salon \
        --name "Bellezza Mia" --slug bellezza-mia \
        --owner-email titolare@bellezzamia.it --owner-name "Anna Rossi" \
        --location "Milano" --address "Via Roma 1, Milano"

Crea i sei oggetti senza i quali il salone non è utilizzabile: Salon, Location
predefinita, SalonSettings, ruoli di sistema, utente titolare e Membership.
I ruoli non sono creabili a mano da admin senza ricopiare gli scope: è la ragione
principale per cui questo comando esiste.

Tutto il resto (branding, orari, operatrici, servizi) si fa dalla dashboard, che è
il posto giusto: sono cose che il salone cambia da solo.

Idempotente sullo slug: se il salone esiste il comando si ferma senza toccare nulla.
La password del titolare NON si passa da riga di comando (finirebbe nella cronologia
della shell): l'utente nasce senza password utilizzabile e la si imposta da
/admin/ oppure con `manage.py changepassword <email>`.

Il login dello staff è mono-salone (entra nella PRIMA membership dell'utente):
un titolare che lavora già in un altro salone non potrebbe mai aprire quello
nuovo, quindi il comando si rifiuta invece di crearlo «con successo».
"""

import re

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.db import transaction

from apps.accounts.models import Membership, User
from apps.accounts.services import ensure_default_roles
from apps.core.models import Location, Salon, SalonSettings

# Lo slug è il primo segmento dell'URL dell'app cliente, che riconosce solo
# /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (packages/shared/src/salon.js): con spazi o
# accenti il salone veniva creato ma la sua app non si apriva. 50 = max_length
# di Salon.slug.
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,49}")


class Command(BaseCommand):
    help = "Crea un salone con la configurazione minima per essere operativo"

    def add_arguments(self, parser):
        parser.add_argument("--name", required=True, help="Nome del salone")
        parser.add_argument("--slug", required=True, help="Slug: è l'URL dell'app cliente")
        parser.add_argument("--owner-email", required=True, help="Email di accesso del titolare")
        parser.add_argument("--owner-name", default="", help='Nome e cognome, es. "Anna Rossi"')
        parser.add_argument("--location", default="Sede principale", help="Nome della sede")
        parser.add_argument("--address", default="", help="Indirizzo della sede")
        parser.add_argument("--phone", default="", help="Telefono della sede")

    @transaction.atomic
    def handle(self, *args, **o):
        slug = o["slug"].strip().lower()
        if not SLUG_RE.fullmatch(slug):
            raise CommandError(
                f"Slug non valido: '{slug}'. Usa lettere minuscole senza accenti, cifre, "
                "- e _ (inizia con una lettera o una cifra, max 50 caratteri)."
            )
        if Salon.objects.filter(slug=slug).exists():
            raise CommandError(f"Esiste già un salone con slug '{slug}'.")
        email = o["owner_email"].strip().lower()
        try:
            validate_email(email)
        except ValidationError:
            raise CommandError(f"Email del titolare non valida: '{o['owner_email']}'.")
        # Il login cerca l'email senza badare alle maiuscole: «Anna@x.it» e
        # «anna@x.it» sono la stessa persona, e `get_or_create(email=…)` ne
        # creava una seconda che non poteva entrare.
        owner = User.objects.filter(email__iexact=email).first()
        if owner is not None:
            other = owner.memberships.select_related("salon").first()
            if other is not None:
                raise CommandError(
                    f"{owner.email} fa già parte del salone «{other.salon.name}»: il login "
                    "entra in un salone solo e il nuovo non sarebbe raggiungibile. "
                    "Usa un'altra email per il titolare."
                )
            if not owner.is_active:
                raise CommandError(
                    f"L'utente {owner.email} è disattivato: riattivalo da /admin/ prima di "
                    "dargli un salone."
                )

        salon = Salon.objects.create(name=o["name"], slug=slug)
        Location.objects.create(
            salon=salon,
            name=o["location"],
            address=o["address"],
            phone=o["phone"],
            is_default=True,
        )
        SalonSettings.objects.create(salon=salon)
        ensure_default_roles(salon)

        created = owner is None
        if created:
            first, _, last = o["owner_name"].partition(" ")
            # password=None: l'utente nasce senza password utilizzabile.
            owner = User.objects.create_user(
                email=email, password=None, first_name=first, last_name=last
            )

        Membership.objects.get_or_create(
            user=owner, salon=salon, defaults={"is_owner": True}
        )

        self.stdout.write(self.style.SUCCESS(f"Salone creato: {salon.name} ({salon.slug})"))
        self.stdout.write(f"  App cliente:  /{salon.slug}")
        self.stdout.write(f"  Titolare:     {owner.email}")
        if created:
            self.stdout.write(
                self.style.WARNING(
                    f"  Password non impostata → manage.py changepassword {owner.email}"
                )
            )
        else:
            self.stdout.write("  Utente già esistente: password invariata")
