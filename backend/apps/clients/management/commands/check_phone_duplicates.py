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
funzione che usa il modello (`Client.save`): il comando funziona quindi anche
su un database che non ha ancora la colonna `phone_key` riempita, cioè proprio
nella situazione in cui serve. Quando la colonna c'è, la confronta con la
chiave ricalcolata: una chiave salvata con un algoritmo vecchio non ritrova la
cliente al login (18-02). Quelle le riallinea `migrate`
(clients.0008_caccia22_clienti_phone_key), tranne le schede doppione, che la
migrazione lascia com'erano: per questo i doppioni restano bloccanti.

Di ogni scheda mostra anche note, schede tecniche, punti fedeltà, lista
d'attesa, gift card e coupon: sono quello che una cancellazione porta via (o
scollega), non solo visite e vendite (06-19).

Uso: `python manage.py check_phone_duplicates [--salon SLUG] [--limit N] [--exit-zero]`
"""

from django.core.management.base import BaseCommand
from django.db import connection
from django.db.models import Count

from apps.clients.models import Client
from apps.core.models import Salon
from common.phone import phone_key as compute_phone_key


# Relazioni mostrate per ogni scheda doppione: (related_name su Client, etichetta).
RELATED = (
    ("appointments", "visite"),
    ("sales", "vendite"),
    ("notes", "note"),
    ("sheets", "schede"),
    ("loyalty_accounts", "fedeltà"),
    ("waitlist_entries", "attesa"),
    ("gift_cards_bought", "gift comprate"),
    ("gift_cards_received", "gift ricevute"),
    ("coupons", "coupon"),
)


def _has_phone_key_column() -> bool:
    with connection.cursor() as cursor:
        columns = connection.introspection.get_table_description(cursor, Client._meta.db_table)
    return any(col.name == "phone_key" for col in columns)


def _related_counts(ids) -> dict[str, dict[int, int]]:
    """{relazione: {client_id: quante}} per le sole schede indicate."""
    counts = {}
    for rel, _ in RELATED:
        counts[rel] = dict(
            Client.objects.filter(id__in=ids).annotate(n=Count(rel)).values_list("id", "n")
        )
    return counts


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

        # Campi elencati uno per uno: la colonna `phone_key` si legge solo se
        # esiste (su un database non ancora migrato può mancare). I conteggi
        # delle cose collegate si fanno dopo, sulle sole schede doppione: una
        # join per relazione su tutta l'anagrafica moltiplicava le righe.
        stored = _has_phone_key_column()
        fields = ["id", "salon_id", "first_name", "last_name", "phone", "since", "is_active"]
        if stored:
            fields.append("phone_key")
        rows = qs.values(*fields).order_by("salon_id", "id")

        groups: dict[tuple[int, str], list[dict]] = {}
        stale: list[dict] = []
        total = 0
        for row in rows.iterator(chunk_size=500):
            total += 1
            key = compute_phone_key(row["phone"])
            row["key"] = key
            row["stale"] = stored and row["phone_key"] != key
            if row["stale"]:
                stale.append(row)
            if not key:
                # Numeri non normalizzabili («n/d», «da chiedere»): il vincolo è
                # parziale e non li tocca, qui non c'è identità da proteggere.
                continue
            groups.setdefault((row["salon_id"], key), []).append(row)

        duplicates = {k: v for k, v in groups.items() if len(v) > 1}

        in_groups = {c["id"] for clients in duplicates.values() for c in clients}
        realign = [row for row in stale if row["id"] not in in_groups]
        if realign:
            self._report_stale(realign, limit)

        if not duplicates:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Nessun doppione: {total} schede controllate, "
                    "il vincolo uniq_client_salon_phone_key si applica senza errori."
                )
            )
            return

        counts = _related_counts(in_groups)
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
                collegati = "  ".join(
                    f"{label} {counts[rel].get(client['id'], 0)}" for rel, label in RELATED
                )
                riga = (
                    f"  #{client['id']:<6} {nome:<{larghezza_nome}}  "
                    f"{(client['phone'] or ''):<{larghezza_tel}}  "
                    f"cliente dal {dal:<10}  {collegati}{stato}"
                )
                self.stdout.write(riga.rstrip())
                if client["stale"]:
                    self.stdout.write(
                        f"          chiave salvata {client['phone_key'] or '(vuota)'}: "
                        "resta questa finché il doppione non è bonificato"
                    )
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
            "  · cancellare una scheda porta via con sé note, schede tecniche, punti\n"
            "    fedeltà e lista d'attesa, e scollega vendite, gift card e coupon (restano\n"
            "    senza cliente). Prima sposta sulla scheda che tieni TUTTO quello che le\n"
            "    colonne qui sopra contano, poi cancella quella svuotata; le visite sono\n"
            "    PROTECT: finché ne ha, la cancellazione viene rifiutata.\n"
            "  · finché esiste un gruppo qui sopra, `migrate` si ferma su\n"
            "    clients.0007_client_phone_key_unique (se non è ancora applicata) e\n"
            "    clients.0008 lascia quelle schede con la chiave di prima."
        )

        if options["exit_zero"]:
            return
        raise SystemExit(1)

    def _report_stale(self, rows, limit):
        """Schede con la chiave salvata diversa da quella di oggi (non doppioni)."""
        self.stdout.write(
            self.style.WARNING(
                f"{len(rows)} schede con la chiave telefono salvata diversa da quella calcolata "
                "oggi: al login non vengono ritrovate. Le riallinea `migrate` "
                "(clients.0008_caccia22_clienti_phone_key); se restano dopo la migrazione, "
                "sono state scritte senza passare da Client.save."
            )
        )
        shown = rows if limit <= 0 else rows[:limit]
        for row in shown:
            self.stdout.write(
                f"  #{row['id']:<6} salone #{row['salon_id']:<4} {row['phone'] or '':<16} "
                f"chiave salvata {row['phone_key'] or '(vuota)'} → {row['key'] or '(vuota)'}"
            )
        if len(rows) > len(shown):
            self.stdout.write(f"  … e altre {len(rows) - len(shown)} (alza --limit, oppure 0 per tutte).")
        self.stdout.write("")
