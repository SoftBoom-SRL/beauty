"""Lo stato condiviso dai passi dell'import: salone, sorgente, riferimenti, conteggi, avvisi."""

import datetime as dt
from collections import Counter, defaultdict
from functools import cached_property

from django.contrib.contenttypes.models import ContentType
from django.utils import timezone

from apps.core.models import ExternalRef

from . import SOURCE
from .source import ROME


class ImportContext:
    """Passato a ogni passo: `run(ctx)`.

    `ref(kind, id)` → id dell'oggetto beauty collegato a quell'id di AreaBeauty
    (o None); `link(kind, id, obj)` crea o riaggancia il collegamento. I
    riferimenti di un tipo si leggono dal database la prima volta e poi restano
    in memoria: un import tocca decine di migliaia di righe.

    Tipi usati (contratto fra i passi):
      cliente (GUID) · operatore (GUID) · servizio (Id intero) ·
      servizio_mybooker (GUID IdServizioMyBooker) · categoria_servizio (Id) ·
      pacchetto (Id) · prodotto (Id) · fornitore (Id) ·
      appuntamento (GUID della riga di planning) · annullato (GUID IdAppuntamento) ·
      vendita (IdTransazione) · coupon (IdCoupon) · prepagato (IdTransazione:IdOperazione) ·
      scheda (template:IdRiga) · nota (GUID cliente:tipo) · movimento (idMovimento)
    """

    def __init__(self, salon, source, *, stdout=None, dry_run=False, today=None, purge_test_data=False, mapping=None):
        self.salon = salon
        self.source = source
        self.stdout = stdout
        self.dry_run = dry_run
        self.purge_test_data = purge_test_data
        # Corrispondenze scelte a mano quando i nomi non coincidono:
        # {"servizi": {id AreaBeauty: nome in beauty}, "operatrici": {id AreaBeauty: nome in beauty}}.
        self.mapping = mapping or {}
        # «oggi» del salone: decide che cosa è passato e che cosa è futuro
        self.today = today or timezone.localdate()
        self.tz = ROME
        self.counts: dict[str, Counter] = defaultdict(Counter)
        self.warnings: list[str] = []
        self._refs: dict[str, dict[str, int]] = {}
        self.step = ""

    # --- riferimenti --------------------------------------------------------
    def _kind(self, kind: str) -> dict[str, int]:
        if kind not in self._refs:
            self._refs[kind] = dict(
                ExternalRef.objects.filter(salon=self.salon, source=SOURCE, kind=kind).values_list(
                    "external_id", "object_id"
                )
            )
        return self._refs[kind]

    def ref(self, kind: str, external_id):
        """Id dell'oggetto beauty collegato, oppure None."""
        if external_id is None or external_id == "":
            return None
        return self._kind(kind).get(str(external_id))

    def refs(self, kind: str) -> dict[str, int]:
        """Tutti i collegamenti di un tipo: {id AreaBeauty: id beauty}."""
        return self._kind(kind)

    def link(self, kind: str, external_id, obj) -> None:
        """Collega `external_id` a `obj` (crea il riferimento o lo riaggancia)."""
        external_id = str(external_id)
        ExternalRef.objects.update_or_create(
            salon=self.salon,
            source=SOURCE,
            kind=kind,
            external_id=external_id,
            defaults={"content_type": ContentType.objects.get_for_model(type(obj)), "object_id": obj.pk},
        )
        self._kind(kind)[external_id] = obj.pk

    def link_many(self, kind: str, pairs) -> None:
        """Come `link`, a blocchi: `pairs` = [(id AreaBeauty, oggetto)], tutti dello stesso modello.

        Per gli import da migliaia di righe (appuntamenti, vendite): una query
        sola invece di una per riga. I riferimenti già presenti si aggiornano.
        """
        pairs = [(str(ext), obj) for ext, obj in pairs]
        if not pairs:
            return
        ct = ContentType.objects.get_for_model(type(pairs[0][1]))
        known = self._kind(kind)
        new = [p for p in pairs if p[0] not in known]
        old = [p for p in pairs if p[0] in known]
        ExternalRef.objects.bulk_create(
            [
                ExternalRef(salon=self.salon, source=SOURCE, kind=kind, external_id=ext, content_type=ct, object_id=obj.pk)
                for ext, obj in new
            ],
            batch_size=1000,
        )
        for ext, obj in old:
            ExternalRef.objects.filter(salon=self.salon, source=SOURCE, kind=kind, external_id=ext).update(
                content_type=ct, object_id=obj.pk
            )
        for ext, obj in pairs:
            known[ext] = obj.pk

    def unlink(self, kind: str, object_ids) -> None:
        """Toglie i riferimenti di un tipo verso questi oggetti (cancellati per essere rifatti)."""
        object_ids = set(object_ids)
        if not object_ids:
            return
        ExternalRef.objects.filter(salon=self.salon, source=SOURCE, kind=kind, object_id__in=object_ids).delete()
        known = self._kind(kind)
        for ext in [e for e, pk in known.items() if pk in object_ids]:
            del known[ext]

    @cached_property
    def location(self):
        """La sede del salone (quella predefinita), o None se il salone non ne ha."""
        from apps.core.models import Location

        return Location.objects.filter(salon=self.salon).order_by("-is_default", "id").first()

    # --- date ---------------------------------------------------------------
    @staticmethod
    def backdate(obj, **fields) -> None:
        """Riscrive campi `auto_now_add`/`auto_now` (created_at, updated_at…) con un UPDATE."""
        if fields:
            type(obj).objects.filter(pk=obj.pk).update(**fields)
            for name, value in fields.items():
                setattr(obj, name, value)

    def aware(self, value: dt.datetime) -> dt.datetime:
        """Un datetime senza fuso diventa ora del salone."""
        if value is not None and timezone.is_naive(value):
            return value.replace(tzinfo=self.tz)
        return value

    def is_future(self, when: dt.datetime) -> bool:
        return when is not None and when.astimezone(self.tz).date() >= self.today

    # --- rapporto -----------------------------------------------------------
    def count(self, key: str, n: int = 1) -> None:
        self.counts[self.step][key] += n

    def warn(self, message: str) -> None:
        """Un avviso per il rapporto: id e conteggi, MAI nomi, telefoni o note."""
        self.warnings.append(f"[{self.step}] {message}")

    def say(self, message: str) -> None:
        if self.stdout is not None:
            self.stdout.write(message)
