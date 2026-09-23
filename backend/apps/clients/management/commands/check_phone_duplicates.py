"""Controllo pre-deploy: schede cliente che condividono lo stesso numero.

La migrazione `clients.0007_client_phone_key_unique` aggiunge il vincolo
`uniq_client_salon_phone_key` su (salone, chiave telefono normalizzata). Su un
database vuoto passa sempre; su un database vero **fallisce** se due schede
dello stesso salone hanno lo stesso numero scritto in modi diversi — «348 221
0094» e «+39 348 2210094» superavano il vecchio vincolo su (salone, telefono)
letterale ma sono la stessa persona, ed erano esattamente i doppioni che i
difetti corretti producevano. Il deploy si ferma a metà migrazione.

Questo comando li trova PRIMA, e mostra di ogni scheda quello che serve per
decidere quale tenere (visite e vendite collegate). È di **sola lettura**: non
scrive, non unisce, non disattiva niente. Esce con codice 1 se trova doppioni,
così si può usare come controllo bloccante prima dell'aggiornamento:

    python manage.py check_phone_duplicates && python manage.py migrate

La chiave viene ricalcolata in Python con `common.phone.phone_key`, la stessa
funzione che usano il modello (`Client.save`) e la migrazione di backfill
`0006`: il comando funziona quindi anche su un database che non ha ancora la
colonna `phone_key` riempita, cioè proprio nella situazione in cui serve.

Uso: `python manage.py check_phone_duplicates [--salon SLUG] [--limit N] [--exit-zero]`
"""

from django.core.management.base import BaseCommand
from django.db.models import Count

from apps.clients.models import Client
from apps.core.models import Salon
from common.phone import phone_key as compute_phone_key


class Command(BaseCommand):
    help = (
        "Elenca le schede cliente che condividono lo stesso numero normalizzato "
        "(bloccano la migrazione del vincolo unico). Sola lettura; esce 1 se ne trova."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--salon",
            dest="salon_slug",
            help="limita il controllo a uno slug di salone (default: tutti)",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=50,
            help="gruppi da stampare per esteso (0 = tutti, default 50)",
        )
        parser.add_argument(
            "--exit-zero",
            action="store_true",
            help="esci sempre con 0, anche con doppioni (per l'uso informativo)",
        )

    def handle(self, *args, **options):
        limit = options["limit"]
        salon_slug = options["salon_slug"]

        qs = Client.objects.all()
        if salon_slug:
            if not Salon.objects.filter(slug=salon_slug).exists():
                self.stderr.write(self.style.ERROR(f"Nessun salone con slug «{salon_slug}»."))
                raise SystemExit(2)
            qs = qs.filter(salon__slug=salon_slug)

        # Campi elencati uno per uno: nessuna lettura della colonna `phone_key`,
        # che su un database non ancora migrato può non esistere. Count distinct
        # perché le due join insieme moltiplicherebbero le righe.
        rows = (
            qs.values("id", "salon_id", "first_name", "last_name", "phone", "since", "is_active")
            .annotate(visite=Count("appointments", distinct=True), vendite=Count("sales", distinct=True))
            .order_by("salon_id", "id")
        )

        groups: dict[tuple[int, str], list[dict]] = {}
        total = 0
        for row in rows.iterator(chunk_size=500):
            total += 1
            key = compute_phone_key(row["phone"])
            if not key:
                # Numeri non normalizzabili («n/d», «da chiedere»): il vincolo è
                # parziale e non li tocca, qui non c'è identità da proteggere.
                continue
            groups.setdefault((row["salon_id"], key), []).append(row)

        duplicates = {k: v for k, v in groups.items() if len(v) > 1}

        if not duplicates:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Nessun doppione: {total} schede controllate, "
                    "il vincolo uniq_client_salon_phone_key si applica senza errori."
                )
            )
            return

        salons = {
            s["id"]: s
            for s in Salon.objects.filter(id__in={sid for sid, _ in duplicates}).values(
                "id", "name", "slug"
            )
        }
        schede = sum(len(v) for v in duplicates.values())
        gruppi = (
            "1 gruppo di doppioni" if len(duplicates) == 1 else f"{len(duplicates)} gruppi di doppioni"
        )
        self.stdout.write(
            self.style.WARNING(
                f"{gruppi}, {schede} schede coinvolte (su {total} controllate)."
            )
        )
        self.stdout.write("")

        shown = sorted(duplicates.items(), key=lambda item: (item[0][0], item[0][1]))
        hidden = 0
        if limit > 0 and len(shown) > limit:
            hidden = len(shown) - limit
            shown = shown[:limit]

        for (salon_id, key), clients in shown:
            salon = salons.get(salon_id, {})
            nome_salone = salon.get("name") or f"salone #{salon_id}"
            slug = salon.get("slug") or "?"
            self.stdout.write(
                self.style.MIGRATE_HEADING(
                    f"Salone «{nome_salone}» ({slug}) · chiave +{key} · {len(clients)} schede"
                )
            )
            nomi = [(f"{c['first_name']} {c['last_name']}".strip() or "—") for c in clients]
            larghezza_nome = max(len(n) for n in nomi)
            larghezza_tel = max(len(c["phone"] or "") for c in clients)
            for client, nome in zip(clients, nomi):
                dal = client["since"].strftime("%d/%m/%Y") if client["since"] else "—"
                stato = "" if client["is_active"] else "  [disattivata]"
                riga = (
                    f"  #{client['id']:<6} {nome:<{larghezza_nome}}  "
                    f"{(client['phone'] or ''):<{larghezza_tel}}  "
                    f"cliente dal {dal:<10}  "
                    f"visite {client['visite']:<4} vendite {client['vendite']:<4}{stato}"
                )
                self.stdout.write(riga.rstrip())
            self.stdout.write("")

        if hidden:
            altri = (
                "un altro gruppo non stampato"
                if hidden == 1
                else f"altri {hidden} gruppi non stampati"
            )
            self.stdout.write(f"… e {altri} (alza --limit, oppure 0 per tutti).\n")

        self.stdout.write(
            "Da sapere per la bonifica:\n"
            "  · «cliente dal» è il campo `since` della scheda, non una data di creazione:\n"
            "    la scheda non ne registra una, quindi a parità di informazioni la più\n"
            "    vecchia è quella con l'identificativo più basso.\n"
            "  · le schede disattivate contano lo stesso: il vincolo non guarda `is_active`.\n"
            "  · tieni la scheda con visite e vendite, sposta su quella le eventuali visite\n"
            "    dell'altra, poi cancella la scheda svuotata (le visite sono PROTECT: finché\n"
            "    ne ha, la cancellazione viene rifiutata).\n"
            "  · finché esiste un gruppo qui sopra, `migrate` si ferma su\n"
            "    clients.0007_client_phone_key_unique e il deploy resta a metà."
        )

        if options["exit_zero"]:
            return
        raise SystemExit(1)
