# I saloni nati da «Accedi con Yourang» non ricevevano i ruoli di sistema
# Manager, Front desk e Operatrice: `integrations.login._provision_salon` li
# creava per conto suo, senza `ensure_default_roles`. In Impostazioni › Team
# l'elenco dei ruoli era vuoto, e per invitare una collega (l'invito chiede un
# ruolo) il titolare doveva prima crearne uno a mano (voce 14 dei bug sospetti
# del 24/09). Da ora passano da `create_salon_foundation` come ogni altro
# salone; questa migrazione sistema quelli già creati.
#
# Solo i saloni senza nessun ruolo di sistema: chi ne ha anche uno è nato dalla
# fondazione, e un ruolo che gli manca è stato tolto apposta. Si creano solo i
# ruoli che mancano per nome, e un ruolo che c'è già non si tocca mai, nemmeno
# uno creato a mano con lo stesso nome (resta con i suoi permessi e senza il
# segno di sistema). Rilanciata non crea niente: i saloni sistemati hanno ormai
# i loro ruoli di sistema.
#
# I ruoli sono copiati qui di proposito: una migrazione non importa il codice
# vivo (`accounts.services.DEFAULT_ROLES`), che può cambiare dopo.

from django.db import migrations

SYSTEM_ROLES = [
    ("Manager", ["agenda", "clients", "sales", "inventory", "pricing", "marketing"]),
    ("Front desk", ["agenda", "clients", "sales"]),
    ("Operatrice", ["agenda", "clients"]),
]


def forwards(apps, schema_editor):
    Salon = apps.get_model("core", "Salon")
    Role = apps.get_model("accounts", "Role")
    with_system_roles = Role.objects.filter(is_system=True).values("salon_id")
    salon_ids = list(Salon.objects.exclude(id__in=with_system_roles).values_list("id", flat=True))
    for salon_id in salon_ids:
        taken = set(Role.objects.filter(salon_id=salon_id).values_list("name", flat=True))
        # ignore_conflicts: un ruolo con lo stesso nome creato mentre la
        # migrazione gira resta com'è, invece di fermare il deploy.
        Role.objects.bulk_create(
            [
                Role(salon_id=salon_id, name=name, scopes=list(scopes), is_system=True)
                for name, scopes in SYSTEM_ROLES
                if name not in taken
            ],
            ignore_conflicts=True,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0005_sessioni_refresh_staff"),
        ("core", "0011_caccia22_core_outbox_scadenza"),
    ]

    operations = [
        # All'indietro non si toglie niente: non si sa più quali ruoli fossero
        # nati qui, e intanto il titolare può averli dati alle sue colleghe.
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
