"""Riempie `Client.phone_key` per le schede già in archivio.

Senza questo passaggio le clienti esistenti resterebbero invisibili alla ricerca
per numero, che ora usa la colonna indicizzata invece di scorrere l'anagrafica.
"""

from django.db import migrations


def fill(apps, schema_editor):
    from common.phone import phone_key

    Client = apps.get_model("clients", "Client")
    batch = []
    for client in Client.objects.all().only("id", "phone", "phone_key").iterator():
        key = phone_key(client.phone)
        if key != client.phone_key:
            client.phone_key = key
            batch.append(client)
        if len(batch) >= 500:
            Client.objects.bulk_update(batch, ["phone_key"])
            batch = []
    if batch:
        Client.objects.bulk_update(batch, ["phone_key"])


def unfill(apps, schema_editor):
    apps.get_model("clients", "Client").objects.update(phone_key="")


class Migration(migrations.Migration):
    dependencies = [("clients", "0005_client_phone_key")]
    operations = [migrations.RunPython(fill, unfill)]
