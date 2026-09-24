"""Fondazione di un salone nuovo: il minimo senza cui non è utilizzabile.

Salone, sede predefinita, impostazioni e ruoli di sistema. I comandi
`create_salon` (onboarding di un salone vero) e `seed_demo` (la demo The
Parlour) li creavano ciascuno per conto proprio, nello stesso ordine: un
oggetto aggiunto alla fondazione di un salone andava ricordato in due posti.

Il titolare e la sua membership restano a chi chiama, che li tratta in modo
diverso (utente senza password utilizzabile, account demo con password
stampata, identità Yourang). Passa di qui anche l'accesso con Yourang
(`integrations.login._provision_salon`): prima creava il salone per conto suo,
e il salone nasceva senza ruoli di sistema.
"""

from apps.core.models import Location, Salon, SalonSettings

from .services import ensure_default_roles


def create_salon_foundation(name, slug, *, location_name, address="", phone="", is_demo=False):
    """Crea salone, sede predefinita, impostazioni e ruoli di sistema; ritorna (salone, sede).

    Nessuna transazione qui: la decide chi chiama (create_salon lavora tutto
    dentro una sola, seed_demo no).
    """
    salon = Salon.objects.create(name=name, slug=slug, is_demo=is_demo)
    location = Location.objects.create(
        salon=salon,
        name=location_name,
        address=address,
        phone=phone,
        is_default=True,
    )
    SalonSettings.objects.create(salon=salon)
    ensure_default_roles(salon)
    return salon, location
