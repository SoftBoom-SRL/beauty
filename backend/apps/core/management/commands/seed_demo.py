"""Seed demo: The Parlour (Firenze) con i dati del prototipo (data.jsx).

    python manage.py seed_demo [--reset]

Crea: salone+sede, titolare (sole@theparlour.it / theparlour), ruoli default,
etichette clienti, 9 operatrici con turni, 14 servizi, 10 clienti, appuntamenti
di oggi, fornitori/prodotti, regola deposito, programma fedeltà, automazione.
"""

import datetime as dt
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import Membership, User
from apps.accounts.services import ensure_default_roles
from apps.agenda.models import Appointment, AppointmentService, Pause, WaitlistEntry
from apps.automations.models import Automation
from apps.catalog.models import Package, Service, ServiceCategory
from apps.clients.models import Client, ClientCategory
from apps.core.models import DepositRule, Location, Salon, SalonSettings
from apps.inventory.models import (
    Product,
    ProductCategory,
    PurchaseOrder,
    StockMovement,
    Supplier,
)
from apps.marketing.models import Communication, Coupon, GiftCard, LoyaltyProgram
from apps.sales.models import Sale
from apps.staff.models import Operator, WeeklyShift


def _teardown(salon):
    """Elimina il salone e tutti i suoi dati.

    Le FK verso Salon sono CASCADE, ma le relazioni *interne* (es. Appointment→
    Operator, SaleLine→Service, Product→Supplier) sono PROTECT: la cascata dal
    salone si bloccherebbe. Qui cancelliamo gli "hub" nell'ordine di dipendenza
    corretto — i figli CASCADE spariscono con loro — poi il salone porta via il
    resto (sedi, ruoli, membership, impostazioni, log, outbox, automazioni…).
    """
    with transaction.atomic():
        Sale.objects.filter(salon=salon).delete()          # → SaleLine, Payment
        Appointment.objects.filter(salon=salon).delete()   # → AppointmentService
        Pause.objects.filter(salon=salon).delete()
        WaitlistEntry.objects.filter(salon=salon).delete()
        Coupon.objects.filter(salon=salon).delete()
        GiftCard.objects.filter(salon=salon).delete()
        Communication.objects.filter(salon=salon).delete()
        LoyaltyProgram.objects.filter(salon=salon).delete()  # → LoyaltyAccount
        StockMovement.objects.filter(salon=salon).delete()
        PurchaseOrder.objects.filter(salon=salon).delete()  # → PurchaseOrderLine
        Product.objects.filter(salon=salon).delete()
        ProductCategory.objects.filter(salon=salon).delete()
        Supplier.objects.filter(salon=salon).delete()
        Client.objects.filter(salon=salon).delete()         # → ClientNote, TechnicalSheet
        ClientCategory.objects.filter(salon=salon).delete()
        Package.objects.filter(salon=salon).delete()        # → PackageItem
        Service.objects.filter(salon=salon).delete()
        ServiceCategory.objects.filter(salon=salon).delete()
        Operator.objects.filter(salon=salon).delete()       # → WeeklyShift, Absence
        salon.delete()

OPS = [
    ("sole", "Sole", "Caputo", "#6366F1", "Titolare · Nail artist", ["nail"]),
    ("mara", "Mara", "Rizzo", "#F59E0B", "Hair stylist", ["hair"]),
    ("lina", "Lina", "Bianchi", "#10B981", "Estetista viso", ["viso"]),
    ("giulia", "Giulia", "Valli", "#EC4899", "Nail artist", ["nail"]),
    ("asia", "Asia", "Kane", "#8B5CF6", "Colorist", ["hair"]),
    ("noor", "Noor", "Fadil", "#14B8A6", "Massaggiatrice", ["viso"]),
    ("vera", "Vera", "Tosi", "#F43F5E", "Make-up artist", ["extra"]),
    ("ines", "Inés", "Marin", "#0EA5E9", "Lash & brow", ["viso"]),
    ("dafne", "Dafne", "Pozzi", "#A3E635", "Nail artist junior", ["nail"]),
]

CATS = [
    ("nail", "Unghie", "Nails", "#FDE2E4"),
    ("hair", "Capelli", "Hair", "#DBEAFE"),
    ("viso", "Viso", "Face", "#DCFCE7"),
    ("extra", "Extra", "Extra", "#FEF3C7"),
]

# (cat, it, en, durata, prezzo, operatrici abilitate)
SERVICES = [
    ("nail", "Semipermanente", "Gel polish", 60, 35, ["sole", "giulia"]),
    ("nail", "Ricostruzione gel", "Gel extensions", 105, 65, ["sole", "giulia"]),
    ("nail", "Nail art", "Nail art", 30, 20, ["sole", "giulia"]),
    ("nail", "Pedicure estetico", "Spa pedicure", 50, 40, ["giulia"]),
    ("hair", "Piega", "Blow-dry", 40, 28, ["mara"]),
    ("hair", "Taglio", "Cut", 45, 32, ["mara"]),
    ("hair", "Colore", "Colour", 120, 78, ["asia"]),
    ("hair", "Balayage", "Balayage", 180, 145, ["asia"]),
    ("hair", "Trattamento ristrutturante", "Repair treatment", 30, 25, ["mara", "asia"]),
    ("viso", "Pulizia viso", "Facial cleanse", 60, 55, ["lina"]),
    ("viso", "Trattamento idratante", "Hydra facial", 75, 80, ["lina"]),
    ("viso", "Laminazione ciglia", "Lash lift", 50, 45, ["lina", "ines"]),
    ("extra", "Manicure express", "Express manicure", 25, 18, ["sole", "giulia", "dafne"]),
    ("extra", "Consulenza", "Consultation", 20, 0, ["sole", "lina", "asia"]),
]

# (nome, telefono, segment, lang, noshow, latecancel, origin, since, marketing)
CLIENTS = [
    ("Sofia Ricci", "+39 348 221 0094", "vip", "it", 0, 1, "Instagram", 2022, True),
    ("Giada Bellini", "+39 333 884 1120", "fedele", "it", 0, 0, "Passaparola", 2021, True),
    ("Noor Haddad", "+39 327 551 9981", "nuovo", "en", 2, 1, "Google", 2025, False),
    ("Elena Conti", "+39 340 112 7765", "fedele", "it", 0, 2, "Instagram", 2023, True),
    ("Marta Vinci", "+39 351 770 3321", "dormiente", "it", 1, 0, "Passaparola", 2022, True),
    ("Aisha Diallo", "+39 366 209 4410", "fedele", "en", 0, 0, "Instagram", 2024, True),
    ("Chiara Greco", "+39 339 556 1208", "nuovo", "it", 0, 0, "Sito web", 2025, True),
    ("Valentina Russo", "+39 320 447 9932", "vip", "it", 0, 0, "Passaparola", 2020, True),
    ("Bianca Lombardi", "+39 347 882 1190", "dormiente", "it", 0, 1, "Instagram", 2023, True),
    ("Federica Mancini", "+39 333 119 2284", "fedele", "it", 0, 0, "Google", 2022, True),
]

# (cliente idx, operatrice, [servizi idx], ora inizio hh:mm, status, deposito)
APPTS = [
    (0, "sole", [1, 2], "09:30", "checked_in", "paid"),
    (7, "asia", [7], "09:30", "in_progress", "paid"),
    (3, "lina", [10], "10:00", "confirmed", "none"),
    (9, "giulia", [0], "10:30", "confirmed", "none"),
    (1, "mara", [5, 4], "11:00", "confirmed", "none"),
    (2, "sole", [0], "12:00", "confirmed", "required"),
    (5, "giulia", [3], "14:00", "confirmed", "none"),
    (4, "asia", [6], "15:30", "confirmed", "none"),
]

SEGMENT_LABEL = {"vip": "VIP", "fedele": "Local", "nuovo": "Standard", "dormiente": "Standard"}
CLIENT_LABELS = [
    ("Local", "#DBEAFE"), ("Expat", "#DCFCE7"), ("Study abroad", "#FEF3C7"),
    ("Tourist", "#FCE7F3"), ("VIP", "#EDE9FE"), ("Standard", "#F1F5F9"),
]


class Command(BaseCommand):
    help = "Popola il database con il salone demo The Parlour"

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true", help="Elimina il salone demo e lo ricrea")

    def handle(self, *args, **options):
        existing = Salon.objects.filter(slug="the-parlour").first()
        if existing:
            if not options["reset"]:
                self.stdout.write(self.style.WARNING("Salone demo già presente. Usa --reset per ricrearlo."))
                return
            _teardown(existing)

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        location = Location.objects.create(salon=salon, name="Firenze", address="Via dei Servi 12, Firenze", is_default=True)
        SalonSettings.objects.create(salon=salon)
        ensure_default_roles(salon)

        owner, created = User.objects.get_or_create(
            email="sole@theparlour.it",
            defaults={"first_name": "Sole", "last_name": "Caputo", "is_staff": True, "is_superuser": True},
        )
        if created:
            owner.set_password("theparlour")
            owner.save()
        Membership.objects.get_or_create(user=owner, salon=salon, defaults={"is_owner": True})

        # Etichette clienti
        labels = {
            name: ClientCategory.objects.create(salon=salon, name=name, color=color, order=i)
            for i, (name, color) in enumerate(CLIENT_LABELS)
        }

        # Operatrici + turni (lun–sab 9–19, pausa 13–14)
        operators = {}
        for i, (key, first, last, color, role, _cats) in enumerate(OPS):
            op = Operator.objects.create(
                salon=salon, location=location, first_name=first, last_name=last,
                color=color, role_title=role, hourly_cost=Decimal("18.00"), order=i,
            )
            operators[key] = op
            for weekday in range(6):
                WeeklyShift.objects.create(
                    operator=op, week_index=0, weekday=weekday,
                    start_min=9 * 60, end_min=19 * 60,
                    break_start_min=13 * 60, break_end_min=14 * 60,
                )

        # Categorie e servizi
        categories = {}
        for i, (key, it, en, color) in enumerate(CATS):
            categories[key] = ServiceCategory.objects.create(
                salon=salon, name_it=it, name_en=en, color=color, order=i
            )
        services = []
        for i, (cat, it, en, dur, price, ops) in enumerate(SERVICES):
            svc = Service.objects.create(
                salon=salon, category=categories[cat], name_it=it, name_en=en,
                duration_min=dur, price=Decimal(price), product_cost=Decimal(price) * Decimal("0.08"),
                order=i,
            )
            svc.operators.set([operators[o] for o in ops])
            services.append(svc)

        # Clienti
        clients = []
        for name, phone, segment, lang, noshow, latecancel, origin, since, marketing in CLIENTS:
            first, _, last = name.rpartition(" ")
            client = Client.objects.create(
                salon=salon, first_name=first, last_name=last, phone=phone,
                lang=lang, origin=origin, since=dt.date(since, 1, 1),
                reliability=max(40, 100 - noshow * 25 - latecancel * 10),
                consents={"privacy": True, "marketing": marketing, "card_charge": False},
                deposit_always=noshow >= 2,
            )
            client.categories.add(labels[SEGMENT_LABEL[segment]])
            clients.append(client)

        # Appuntamenti di oggi
        today = timezone.localdate()
        tz = timezone.get_current_timezone()
        for client_idx, op_key, svc_idxs, hhmm, status, deposit in APPTS:
            hh, mm = map(int, hhmm.split(":"))
            start = dt.datetime.combine(today, dt.time(hh, mm), tzinfo=tz)
            total = sum(services[i].price for i in svc_idxs)
            appt = Appointment.objects.create(
                salon=salon, location=location, client=clients[client_idx],
                operator=operators[op_key], start=start, status=status,
                deposit_status=deposit,
                deposit_amount=(total * Decimal("0.3")).quantize(Decimal("0.01")) if deposit != "none" else 0,
            )
            for order, i in enumerate(svc_idxs):
                AppointmentService.objects.create(
                    appointment=appt, service=services[i], operator=operators[op_key],
                    duration_min=services[i].duration_min, price=services[i].price, order=order,
                )

        # Magazzino
        opi = Supplier.objects.create(salon=salon, name="OPI Italia", email="ordini@opi.it", order_method="email")
        davines = Supplier.objects.create(salon=salon, name="Davines", email="b2b@davines.it", order_method="email")
        smalti = ProductCategory.objects.create(salon=salon, name="Smalti", order=0)
        capelli = ProductCategory.objects.create(salon=salon, name="Cura capelli", order=1)
        for name, cat, supplier, usage, purchase, sale, stock, threshold in [
            ("Smalto gel Rosso Firenze", smalti, opi, "mixed", "6.50", "14.00", 12, 5),
            ("Base coat OPI", smalti, opi, "internal", "5.00", "0", 3, 4),
            ("Shampoo ristrutturante 250ml", capelli, davines, "retail", "9.00", "22.00", 8, 3),
            ("Maschera nutriente 150ml", capelli, davines, "mixed", "11.00", "26.00", 2, 3),
        ]:
            Product.objects.create(
                salon=salon, name=name, category=cat, supplier=supplier, usage=usage,
                purchase_price=Decimal(purchase), sale_price=Decimal(sale),
                stock_qty=stock, min_threshold=threshold, reorder_qty=10,
            )

        # Regola deposito, fedeltà, automazione
        DepositRule.objects.create(
            salon=salon, name="Affidabilità bassa",
            conditions={"op": "and", "rules": [{"field": "reliability", "cmp": "lt", "value": 60}]},
            amount_type="pct", amount=Decimal("30.00"), priority=0,
        )
        LoyaltyProgram.objects.create(
            salon=salon, name="The Parlour Club", type="points", earn_metric="per_euro",
            earn_ratio=Decimal("1"), reward_type="coupon_amount", reward_value=Decimal("10.00"),
            threshold=100, color="#6366F1",
        )
        Automation.objects.create(
            salon=salon, name="Promemoria appuntamento", event="appointment_upcoming",
            offset_direction="before", offset_value=24, offset_unit="hours",
        )

        self.stdout.write(self.style.SUCCESS(
            "Seed completato: The Parlour (the-parlour)\n"
            "  Dashboard/admin: sole@theparlour.it · password: theparlour\n"
            f"  {Operator.objects.filter(salon=salon).count()} operatrici · "
            f"{Service.objects.filter(salon=salon).count()} servizi · "
            f"{Client.objects.filter(salon=salon).count()} clienti · "
            f"{Appointment.objects.filter(salon=salon).count()} appuntamenti oggi"
        ))
