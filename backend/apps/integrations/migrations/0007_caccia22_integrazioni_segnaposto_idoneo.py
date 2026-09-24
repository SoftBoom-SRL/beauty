# Il servizio segnaposto «Prenotazione Yourang» nasceva senza operatrici idonee:
# l'idoneità non si forza mai, quindi una prenotazione importata non si poteva
# trascinare su un'altra colonna, allungare, staccare né arricchire di servizi
# tenendo il segnaposto (11-04, 01-09). D'ora in poi il segnaposto è idoneo per
# ogni operatrice del salone (sync._yourang_service e signals.py lo mantengono);
# questa migrazione sistema i saloni che lo hanno già.
#
# Nome del segnaposto copiato qui di proposito: una migrazione non importa il
# codice vivo, che può cambiare dopo. Tutte le operatrici, anche disattivate:
# riattivata, una non idonea tornerebbe a bloccare le prenotazioni Yourang.
# INSERT ... ON CONFLICT DO NOTHING sulla tabella ponte (vincolo unico
# operator/service): le coppie già presenti restano come sono.

from django.db import migrations

PLACEHOLDER_SERVICE_NAME = "Prenotazione Yourang"


def _placeholder_for_every_operator(apps, schema_editor):
    Service = apps.get_model("catalog", "Service")
    Operator = apps.get_model("staff", "Operator")
    Through = Operator.services.through
    rows = []
    for service_id, salon_id in Service.objects.filter(
        name_it=PLACEHOLDER_SERVICE_NAME
    ).values_list("id", "salon_id"):
        for operator_id in Operator.objects.filter(salon_id=salon_id).values_list("id", flat=True):
            rows.append(Through(operator_id=operator_id, service_id=service_id))
    Through.objects.bulk_create(rows, ignore_conflicts=True, batch_size=500)


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0004_service_description"),
        ("staff", "0001_initial"),
        ("integrations", "0006_caccia22_integrazioni_eventi_remoti"),
    ]

    operations = [
        # Irreversibile nei fatti ma innocua: all'indietro non si sa quali
        # coppie esistessero prima, e lasciarle non blocca niente.
        migrations.RunPython(_placeholder_for_every_operator, migrations.RunPython.noop),
    ]
