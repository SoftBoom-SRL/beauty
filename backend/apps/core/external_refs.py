"""Riferimenti agli id di un altro gestionale (`ExternalRef`): leggere e scrivere.

Gli import (comandi di gestione, script) chiamano `link` dopo aver creato un
record e `resolve` prima di crearne uno: così un import rifatto aggiorna o
salta invece di duplicare, e i record del vecchio gestionale che si citano tra
loro (la vendita che punta all'appuntamento) si ritrovano.
"""

from django.contrib.contenttypes.models import ContentType

from .models import ExternalRef


def resolve(salon, source: str, kind: str, external_id, model=None):
    """Il record di beauty collegato a `external_id`, oppure None.

    Con `model` si controlla anche il tipo: un riferimento che punta a un
    modello diverso, o a un record cancellato, vale come assente.
    """
    ref = (
        ExternalRef.objects.filter(
            salon=salon, source=source, kind=kind, external_id=str(external_id)
        )
        .select_related("content_type")
        .first()
    )
    if ref is None:
        return None
    model_class = ref.content_type.model_class()
    if model_class is None or (model is not None and model_class is not model):
        return None
    return model_class._default_manager.filter(pk=ref.object_id).first()


def link(salon, source: str, kind: str, external_id, obj) -> ExternalRef:
    """Collega `external_id` a `obj` (crea o riaggancia il riferimento)."""
    ref, _ = ExternalRef.objects.update_or_create(
        salon=salon,
        source=source,
        kind=kind,
        external_id=str(external_id),
        defaults={
            "content_type": ContentType.objects.get_for_model(type(obj)),
            "object_id": obj.pk,
        },
    )
    return ref


def ids_for(salon, source: str, kind: str) -> dict[str, int]:
    """{external_id: object_id} di un tipo, per gli import che lavorano a blocchi."""
    return dict(
        ExternalRef.objects.filter(salon=salon, source=source, kind=kind).values_list(
            "external_id", "object_id"
        )
    )
