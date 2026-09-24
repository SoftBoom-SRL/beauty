"""Tessere «A timbri» salvate con l'accumulo «per euro» (caccia del 22/09, 07-01).

La dashboard creava i programmi a timbri con `earn_metric="per_euro"` (il
modello vuoto) e nascondeva il selettore: ogni euro valeva un timbro, e ogni
scontrino emetteva più premi. Qui:

- il programma passa a un timbro per visita (`per_visit`, rapporto 1);
- i saldi arrivati alla soglia o oltre (un colore da 150 € su una tessera da 10
  lasciava 50 «timbri» dopo i dieci premi del tetto per vendita) scendono a
  soglia − 1: senza, alla visita successiva la cassa avrebbe continuato a
  emettere fino a dieci premi mai guadagnati. I saldi sotto la soglia restano:
  il conto giusto non è ricostruibile e togliere timbri visibili alla cliente
  sarebbe peggio del regalo;
- i premi già emessi (coupon e gift card con origine fedeltà) NON si toccano:
  sono nei portafogli delle clienti, spesso già annunciati per messaggio o
  spesi in cassa. Chi vuole ritirarne qualcuno lo fa a mano da Promozioni;
- per le altre tessere a timbri il rapporto torna a 1, che è quello che la
  cassa applica ormai comunque (`loyalty._points_earned`).

Una riga nel registro attività del salone dice cosa è cambiato e perché.
"""

from django.db import migrations

MAX_SUMMARY = 255  # colonna ActivityLog.summary


def forwards(apps, schema_editor):
    LoyaltyProgram = apps.get_model("marketing", "LoyaltyProgram")
    LoyaltyAccount = apps.get_model("marketing", "LoyaltyAccount")
    ActivityLog = apps.get_model("core", "ActivityLog")

    for program in LoyaltyProgram.objects.filter(type="stamps", earn_metric="per_euro"):
        capped = 0
        cap = max(int(program.threshold or 0) - 1, 0)
        if program.threshold:
            capped = LoyaltyAccount.objects.filter(
                program_id=program.pk, points__gt=cap
            ).update(points=cap)
        LoyaltyProgram.objects.filter(pk=program.pk).update(
            earn_metric="per_visit", earn_ratio=1
        )
        summary = (
            f"Programma fedeltà «{program.name}»: ora un timbro per visita "
            "(prima ne dava uno per euro speso)"
        )
        if capped:
            summary += f"; {capped} saldi oltre la soglia riportati a {cap} timbri"
        ActivityLog.objects.create(
            salon_id=program.salon_id,
            type="loyalty_program.updated",
            summary=summary[:MAX_SUMMARY],
            payload={
                "program_id": program.pk,
                "earn_metric": {"from": "per_euro", "to": "per_visit"},
                "capped_accounts": capped,
                "capped_to": cap,
            },
        )

    LoyaltyProgram.objects.filter(type="stamps").exclude(earn_ratio=1).update(earn_ratio=1)


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0009_outboxevent_coalesce_key_and_more"),
        ("marketing", "0003_giftcard_gift_service"),
    ]

    operations = [
        # Irreversibile nei dati: all'indietro non si sa più quali programmi
        # erano «per euro», e il vecchio conteggio era il difetto.
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
