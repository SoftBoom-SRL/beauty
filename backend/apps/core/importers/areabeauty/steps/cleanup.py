"""Passo «cleanup»: toglie i dati di prova del salone prima del primo import.

Solo con `--purge-test-data`. Si cancella soltanto ciò che NON viene da
AreaBeauty (senza un `ExternalRef` della sorgente): rilanciato dopo un import,
il passo lascia stare quello che l'import ha già portato. Restano sempre
catalogo, operatrici, impostazioni e utenti: il salone li ha configurati a mano.
"""

from django.contrib.contenttypes.models import ContentType

from apps.core.models import ExternalRef

from .. import SOURCE


def _imported_ids(ctx, model) -> set[int]:
    ct = ContentType.objects.get_for_model(model)
    return set(
        ExternalRef.objects.filter(salon=ctx.salon, source=SOURCE, content_type=ct).values_list("object_id", flat=True)
    )


def run(ctx):
    if not ctx.purge_test_data:
        ctx.count("saltato (manca --purge-test-data)")
        return
    from apps.agenda.models import Appointment, Pause, WaitlistEntry
    from apps.clients.models import Client
    from apps.marketing.models import Coupon, GiftCard
    from apps.sales.models import Sale

    # L'ordine conta: gli appuntamenti proteggono le clienti (PROTECT).
    for label, model in (
        ("appuntamenti", Appointment),
        ("vendite", Sale),
        ("gift card", GiftCard),
        ("coupon", Coupon),
        ("pause", Pause),
        ("lista d'attesa", WaitlistEntry),
        ("clienti", Client),
    ):
        keep = _imported_ids(ctx, model)
        qs = model.objects.filter(salon=ctx.salon).exclude(pk__in=keep)
        n = qs.count()
        if n:
            qs.delete()
        ctx.count(f"{label} di prova tolti", n)
