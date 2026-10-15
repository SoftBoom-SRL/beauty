"""Import dei dati di un salone da AreaBeauty (Infolan).

    python manage.py import_areabeauty --salon the-parlour --dir /percorso/raw --dry-run
    python manage.py import_areabeauty --salon the-parlour --dir /percorso/raw --purge-test-data

`--dir` è la cartella dell'export grezzo (le risposte JSON di AreaBeauty). I
passi e le loro regole sono in `apps/core/importers/areabeauty/`: niente eventi
verso Yourang o WhatsApp, date storiche conservate, rifacibile senza doppioni.

Tutto gira in una transazione sola: se un passo fallisce non resta niente a
metà. Con `--dry-run` si fa tutto e alla fine si annulla: serve a leggere il
rapporto (conteggi e avvisi) prima di scrivere davvero.
"""

import datetime as dt
import importlib
import json
import time

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.core.importers.areabeauty import STEPS
from apps.core.importers.areabeauty.context import ImportContext
from apps.core.importers.areabeauty.source import RawSource
from apps.core.models import Salon


MAX_WARNINGS_SHOWN = 80


class _DryRun(Exception):
    """Annulla la transazione alla fine di una prova."""


class Command(BaseCommand):
    help = "Importa in un salone i dati esportati da AreaBeauty"

    def add_arguments(self, parser):
        parser.add_argument("--salon", required=True, help="slug del salone di destinazione")
        parser.add_argument("--dir", required=True, help="cartella dell'export grezzo di AreaBeauty")
        parser.add_argument("--steps", default="", help=f"solo questi passi, separati da virgola ({', '.join(STEPS)})")
        parser.add_argument("--dry-run", action="store_true", help="fa tutto e poi annulla")
        parser.add_argument(
            "--purge-test-data",
            action="store_true",
            help="prima toglie clienti, vendite, gift card e pause del salone che non vengono da AreaBeauty",
        )
        parser.add_argument("--today", default="", help="«oggi» del salone (AAAA-MM-GG), per le prove")
        parser.add_argument(
            "--map",
            default="",
            help='JSON con le corrispondenze scelte a mano: {"servizi": {id AreaBeauty: nome in beauty}, '
            '"categorie": {id AreaBeauty: nome in beauty}, "operatrici": {id AreaBeauty: nome o id in beauty}, '
            '"servizi_nome_areabeauty": true per dare ai servizi collegati a mano il nome di AreaBeauty}',
        )

    def handle(self, *args, **opts):
        salon = Salon.objects.filter(slug=opts["salon"]).first()
        if salon is None:
            raise CommandError(f"Salone «{opts['salon']}» non trovato")
        steps = [s.strip() for s in opts["steps"].split(",") if s.strip()] or list(STEPS)
        unknown = [s for s in steps if s not in STEPS]
        if unknown:
            raise CommandError(f"Passi sconosciuti: {', '.join(unknown)}")
        try:
            source = RawSource(opts["dir"])
        except FileNotFoundError as exc:
            raise CommandError(str(exc)) from exc
        today = dt.date.fromisoformat(opts["today"]) if opts["today"] else None
        mapping = {}
        if opts["map"]:
            try:
                with open(opts["map"], encoding="utf-8") as fh:
                    mapping = json.load(fh)
            except (OSError, ValueError) as exc:
                raise CommandError(f"File delle corrispondenze illeggibile: {exc}") from exc
            # Le chiavi delle tabelle sono id di AreaBeauty: sempre testo.
            mapping = {k: ({str(a): b for a, b in v.items()} if isinstance(v, dict) else v) for k, v in mapping.items()}
        ctx = ImportContext(
            salon, source, stdout=self.stdout, dry_run=opts["dry_run"], today=today,
            purge_test_data=opts["purge_test_data"], mapping=mapping,
        )

        self.stdout.write(f"Import AreaBeauty → {salon.name} ({salon.slug}){' — PROVA, niente viene salvato' if ctx.dry_run else ''}")
        try:
            with transaction.atomic():
                for name in STEPS:
                    if name not in steps:
                        continue
                    ctx.step = name
                    started = time.monotonic()
                    module = importlib.import_module(f"apps.core.importers.areabeauty.steps.{name}")
                    module.run(ctx)
                    self._report_step(ctx, name, time.monotonic() - started)
                if ctx.dry_run:
                    raise _DryRun
        except _DryRun:
            self.stdout.write(self.style.WARNING("Prova finita: tutto annullato."))
        self._report_warnings(ctx)
        if not ctx.dry_run:
            self.stdout.write(self.style.SUCCESS("Import completato."))

    def _report_step(self, ctx, name, seconds):
        counts = ctx.counts.get(name) or {}
        detail = ", ".join(f"{k} {v}" for k, v in counts.items()) or "niente da fare"
        self.stdout.write(f"  {name:<10} {seconds:6.1f}s  {detail}")

    def _report_warnings(self, ctx):
        if not ctx.warnings:
            return
        self.stdout.write(self.style.WARNING(f"Avvisi: {len(ctx.warnings)}"))
        for message in ctx.warnings[:MAX_WARNINGS_SHOWN]:
            self.stdout.write(f"  - {message}")
        if len(ctx.warnings) > MAX_WARNINGS_SHOWN:
            self.stdout.write(f"  … e altri {len(ctx.warnings) - MAX_WARNINGS_SHOWN}")
