"""Il segnaposto «Prenotazione Yourang» resta idoneo per ogni operatrice.

Le prenotazioni importate portano il servizio segnaposto, e l'agenda non forza
mai l'idoneità: un'operatrice senza il segnaposto fra i suoi servizi non può
ricevere, allungare o staccare una prenotazione Yourang (11-04, 01-09). La
scheda «nuova operatrice» manda solo i servizi del listino, e ogni salvataggio
dei servizi di un'operatrice riscrive l'intera relazione (`services.set`):
senza questi due ricevitori il segnaposto sparirebbe alla prima modifica.
L'agenda non sa niente di Yourang, ed è giusto così: la regola vive qui.
"""

from django.db.models.signals import m2m_changed, post_save
from django.dispatch import receiver

from apps.catalog.models import Service
from apps.staff.models import Operator

from .constants import PLACEHOLDER_SERVICE_NAME


def _placeholder_ids(salon_id) -> list[int]:
    return list(
        Service.objects.filter(salon_id=salon_id, name_it=PLACEHOLDER_SERVICE_NAME).values_list(
            "id", flat=True
        )
    )


@receiver(post_save, sender=Operator, dispatch_uid="integrations-yourang-placeholder-new-operator")
def placeholder_for_new_operator(sender, instance, created, raw=False, **kwargs):
    if raw or not created:
        return
    ids = _placeholder_ids(instance.salon_id)
    if ids:
        instance.services.add(*ids)


@receiver(
    m2m_changed,
    sender=Operator.services.through,
    dispatch_uid="integrations-yourang-placeholder-kept",
)
def placeholder_stays(sender, instance, action, reverse, pk_set, **kwargs):
    if action not in ("post_remove", "post_clear"):
        return
    if reverse:
        # Dal lato del servizio: operatrici tolte dal segnaposto.
        if instance.name_it != PLACEHOLDER_SERVICE_NAME:
            return
        operators = Operator.objects.filter(salon_id=instance.salon_id)
        if action == "post_remove":
            operators = operators.filter(pk__in=pk_set or ())
        instance.operators.add(*operators)
        return
    ids = _placeholder_ids(instance.salon_id)
    if action == "post_remove":
        ids = [pk for pk in ids if pk in (pk_set or ())]
    if ids:
        instance.services.add(*ids)
