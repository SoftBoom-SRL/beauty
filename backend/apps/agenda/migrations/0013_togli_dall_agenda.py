# Visite incassate tolte dall'agenda: una colonna nullable, solo additiva.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agenda", "0012_conto_unico"),
    ]

    operations = [
        migrations.AddField(
            model_name="appointment",
            name="removed_from_agenda_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
