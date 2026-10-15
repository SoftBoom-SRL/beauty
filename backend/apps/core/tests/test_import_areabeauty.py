"""Import da AreaBeauty (`manage.py import_areabeauty`) su un piccolo export finto.

L'export vero ha la stessa forma (cartelle, involucri JSON, nomi dei campi):
qui c'è il minimo per vedere ogni regola dei passi, con nomi inventati.
"""

import datetime as dt
import json
import os
import tempfile
from decimal import Decimal
from io import StringIO

from django.core.management import call_command
from django.test import TestCase

from apps.agenda.models import Appointment
from apps.catalog.models import Package, Service, ServiceCategory
from apps.clients.models import Client, TechnicalSheet
from apps.core.models import ActivityLog, ExternalRef, Location, OutboxEvent, Salon
from apps.inventory.models import Product, StockMovement
from apps.marketing.models import GiftCard
from apps.sales.models import Payment, Sale, SaleLine
from apps.staff.models import Absence, Operator

UTC = dt.UTC


def ms(*args):
    """/Date(ms)/ di AreaBeauty per un istante UTC."""
    return f"/Date({int(dt.datetime(*args, tzinfo=UTC).timestamp() * 1000)})/"


def page(key, rows):
    return {"pagine": [{"dati": {key: rows}}]}


def write(root, path, data):
    full = os.path.join(root, *path.split("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as fh:
        json.dump(data, fh)


def service_line(id_servizio, amount, *, appt=None, op="op-1", stato=11, coupon=None, operazione=1):
    return {
        "IdServizio": id_servizio, "Prezzo": amount, "PrezzoScontato": amount, "TotaleScontato": amount, "Qta": 1,
        "Sconto": 0, "Stato": stato, "StatoDesc": "Eseguito" if stato == 11 else "Prenotato",
        "IdAppuntamento": appt, "IdCoupon": coupon, "IdOperazione": operazione, "IdPacchetto": 0,
        "Assistenti": [{"Azione": 1, "Id": op}, {"Azione": 2, "Id": "cassa"}],
    }


def payment(sale, tipo, amount, when, *, own=True, origin=None):
    p = {"IdVendita": sale if own else origin, "Tipo": tipo, "Importo": amount, "DataPagamento": when, "Dettagli": [], "Sospesi": []}
    if own:
        p["Dettagli"] = [{"Importo": amount}]
    else:
        p["Sospesi"] = [{"Importo": amount, "IdTransazione": origin}]
    return p


def sale(tx, client, day, hour, *, servizi=(), prodotti=(), coupons=(), pagamenti=(), totale=0, saldato=0):
    return {"IdTransazione": tx, "dati": {
        "IdCliente": client, "DataTransazione": day, "OraTransazione": hour, "Servizi": list(servizi),
        "Prodotti": list(prodotti), "Coupons": list(coupons), "Pagamenti": list(pagamenti),
        "Importi": {"TotaleVendita": totale, "Saldato": saldato, "DaSaldare": max(0, totale - saldato)},
    }}


def planning_row(guid, client, op, articolo, day, start, end, *, eseguito=True, tx="", paid=None, unit=11):
    return {
        "id_appuntamentoGuid": guid, "id_appuntamento": 1, "id_cliente": client, "id_operatore": op,
        "id_articolo": articolo, "start_date": f"{day} {start}", "end_date": f"{day} {end}",
        "end_date_customer": f"{day} {end}", "eseguito": eseguito, "id_transazione": tx, "importo_pagato": paid,
        "unit": [unit], "eventType": 0, "dataCreazione": ms(2026, 9, 1, 8), "dataModifica": ms(2026, 9, 2, 8),
    }


def build_export(root):
    write(root, "catalogo/categorie_articoli.json", page("categorie", [
        {"Id": "5", "Descrizione": "HAND TREATMENTS", "TipoEntita": "Servizi"},
        {"Id": "9", "Descrizione": "Prodotti Unghie", "TipoEntita": "Prodotti"},
    ]))
    write(root, "catalogo/servizi.json", page("servizi", [
        {"Id": 4, "Descrizione1": "CLASSIC MANICURE", "IdCategoria": "5", "Minuti": 45, "MinutiCliente": 45, "Prezzo": 45, "IdServizioMyBooker": "svc-4"},
        {"Id": 582, "Descrizione1": "ADD FOOT SCRUB", "IdCategoria": "5", "Minuti": 15, "MinutiCliente": 15, "Prezzo": 20, "IdServizioMyBooker": "svc-582"},
        {"Id": 16, "Descrizione1": "CLASSIC PEDICURE", "IdCategoria": "5", "Minuti": 60, "MinutiCliente": 70, "Prezzo": 70, "IdServizioMyBooker": "svc-16"},
        {"Id": 781, "Descrizione1": "DEPOSIT", "IdCategoria": "5", "Minuti": 0, "Prezzo": 0, "IdServizioMyBooker": "svc-781"},
    ]))
    write(root, "catalogo/pacchetti_dettaglio.json", {"dettagli": [{"dati": {"pacchetto": {
        "Id": 25, "Nome": "12 MANICURE", "Prezzo": 540, "TotaleScontato": 480, "GiorniValidita": 90,
        "Componenti": [{"IdArticoloComponente": 4, "Qta": 12}],
    }}}]})
    write(root, "catalogo/prodotti.json", page("prodotti", [
        {"Id": 500, "Descrizione1": "Smalto rosso", "IdCategoria": "9", "UsoInterno": False, "Prezzo": 20, "PrezzoAcquisto": 8, "Iva": {"Aliquota": 22}},
    ]))
    write(root, "configurazione/operatori.json", page("operatori", [
        {"Id": "op-1", "Nome": "Giulia", "Cognome": "Bianchi", "Colore": "#00FF00", "VisibileInPlanning": True},
        {"Id": "op-2", "Nome": "Marta", "Cognome": "Neri", "VisibileInPlanning": False},
    ]))
    write(root, "clienti/elenco/0001.json", {"data": [
        {"Id": "c-1", "Name": "Anna", "Surname": "Rossi", "Phone": "+39 333 1112233", "Sesso": 1, "RegistrationDateStr": "2023-05-01T10:00:00", "DataNascitaStr": "13/05/1990"},
        {"Id": "c-2", "Name": "Bea", "Surname": "Rossi", "Phone": "3331112233", "Sesso": 1, "RegistrationDateStr": "2024-01-01T10:00:00"},
        {"Id": "c-3", "Name": "Carl", "Surname": "Smith", "Phone": "12125551234", "Sesso": 2, "RegistrationDateStr": "2024-02-01T10:00:00", "DataNascitaStr": "05/03/1900"},
        {"Id": "c-4", "Name": "Dora", "Surname": "Gialli", "Phone": None, "Sesso": 1, "RegistrationDateStr": "2024-03-01T10:00:00"},
    ]})
    write(root, "clienti/gruppi.json", {"dati": [{"Id": "g-1", "Descrizione": "Holiday Voucher"}]})
    write(root, "clienti/dettaglio/0001.json", [{
        "id": "c-1",
        "customer": {"IdGruppo": "g-1", "Customer": {"Nome": "Anna", "Note": "Allergica al lattice", "Contatti": []}},
        "riepilogo": {"dati": {"appAnnullati": [{
            "IdAppuntamento": "ann-1", "ClienteId": "c-1", "ServizioId": "svc-4", "OperatoreId": "",
            "DataOraInizio": ms(2026, 9, 1, 8), "DataOraFine": ms(2026, 9, 1, 8, 45), "Prezzo": 45,
            "Motivazione": {"Id": 3, "Descrizione": "IL CLIENTE NON SI E' PRESENTATO"},
            "DataCreazione": ms(2026, 8, 20, 9), "DataAnnullamento": ms(2026, 9, 1, 12),
        }]}},
        "schede": {"1": {"TabellaCampiMultipli": [{"Righe": [{
            "IdRiga": 10, "Data": "2026-10-01T00:00:00",
            "Valori": [
                {"Campo": {"Nome": "COLORE"}, "Valore": "Rosso 12"},
                {"Campo": {"Nome": "NOTE"}, "Valore": "Tutto bene"},
                {"Campo": {"Nome": "STATO UNGHIE"}, "Valore": "fragili"},
                {"Campo": {"Nome": "FOTO"}, "Valore": ""},
            ],
        }, {"IdRiga": 11, "Data": "2026-09-01T00:00:00", "Valori": [{"Campo": {"Nome": "COLORE"}, "Valore": ""}]}]}]}},
    }])
    write(root, "appuntamenti/planning/2026-09-28.json", [{"dati": {
        "Appuntamenti": [
            # Anna, 1/10: manicure con scrub dentro, poi pedicure con una collega dopo mezz'ora.
            planning_row("r-1", "c-1", "op-1", "4", "01.10.2026", "10:00", "10:45", tx="100", paid=45),
            planning_row("r-2", "c-1", "op-1", "582", "01.10.2026", "10:15", "10:30", tx="100", paid=20),
            planning_row("r-3", "c-1", "op-2", "16", "01.10.2026", "11:15", "12:15", tx="100", paid=70),
            # La caparra di Anna non è un trattamento.
            planning_row("r-4", "c-1", "op-1", "781", "20.09.2026", "09:00", "09:00", tx="99", paid=0),
            # Bea ha già pagato la manicure del 20/10.
            planning_row("r-5", "c-2", "op-1", "4", "20.10.2026", "10:00", "10:45", eseguito=False, tx="101", paid=45),
            # Carl: passato, mai fatto né pagato → annullato.
            planning_row("r-6", "c-3", "op-1", "4", "10.09.2026", "10:00", "10:45", eseguito=False),
            # Dora: passato, pagato e mai venuta → no-show, l'incasso resta.
            planning_row("r-7", "c-4", "op-1", "4", "11.09.2026", "10:00", "10:45", eseguito=False, tx="102", paid=45),
            {"eventType": 1, "id_appuntamentoGuid": None, "text": "lista d'attesa"},
        ],
        "Presenze": [{"reason": "Ferie", "unit": 11, "isAllDay": True, "start_date": "20.10.2026 00:00", "end_date": "22.10.2026 00:00"}],
    }}])
    write(root, "vendite/dettaglio/0001.json", [
        # Solo caparra: il denaro va sul conto del 1/10.
        sale(99, "c-1", "2026-09-20", "09:00", servizi=[service_line(781, 0, appt="r-4")],
             pagamenti=[payment(99, 4, 50, ms(2026, 9, 20, 7), own=False, origin=99) | {"Sospesi": []}]),
        sale(100, "c-1", "2026-10-01", "12:30", totale=155, saldato=135,
             servizi=[service_line(4, 45, appt="r-1", operazione=1001), service_line(582, 20, appt="r-2", operazione=1002),
                      service_line(16, 70, appt="r-3", op="op-2", operazione=1003)],
             prodotti=[{"IdProdotto": 500, "Costo": 20, "PrezzoScontato": 20, "TotaleScontato": 20, "Qta": 1, "Sconto": 0, "Assistenti": []}],
             pagamenti=[payment(100, 4, 50, ms(2026, 9, 20, 7), own=False, origin=99), payment(100, 3, 85, ms(2026, 10, 1, 10, 30))]),
        sale(101, "c-2", "2026-10-05", "11:00", totale=45, saldato=45,
             servizi=[service_line(4, 45, appt="r-5", stato=12, operazione=1011)], pagamenti=[payment(101, 1, 45, ms(2026, 10, 5, 9))]),
        sale(102, "c-4", "2026-09-05", "11:00", totale=45, saldato=45,
             servizi=[service_line(4, 45, appt="r-7", stato=12, operazione=1021)], pagamenti=[payment(102, 3, 45, ms(2026, 9, 5, 9))]),
        sale(103, "c-1", "2026-06-01", "11:00", totale=45, saldato=45,
             coupons=[{"IdCoupon": 7, "Prezzo": 45, "TotaleScontato": 45, "Sconto": 0, "Qta": 1, "Assistenti": []}],
             pagamenti=[payment(103, 3, 45, ms(2026, 6, 1, 9))]),
        sale(104, "c-3", "2026-09-15", "11:00", totale=0, saldato=0, servizi=[service_line(4, 45, coupon=7, operazione=1041)]),
        sale(105, "c-3", "2026-09-16", "11:00", totale=70, saldato=70,
             servizi=[service_line(16, 70, stato=12, operazione=1051)], pagamenti=[payment(105, 1, 70, ms(2026, 9, 16, 9))]),
    ])
    write(root, "coupon/emessi_stato_null.json", page("coupons", [
        {"IdCoupon": 7, "CodiceShort": "AB12", "IdArticoloGiftbox": 4, "TotaleListinoVendita": 45, "IdClienteVendita": "c-1",
         "IdCliente": "c-3", "NominativoCliente": "Carl Smith", "DataCreazione": ms(2026, 6, 1, 9), "ValidoAl": ms(2026, 12, 1),
         "NrUtilizzi": 1, "FlagAnnullato": False},
        {"IdCoupon": 8, "CodiceShort": "AB13", "IdArticoloGiftbox": 4, "TotaleListinoVendita": 45, "IdClienteVendita": "c-1",
         "IdCliente": "c-2", "DataCreazione": ms(2026, 7, 1, 9), "ValidoAl": ms(2027, 1, 1), "NrUtilizzi": 0, "FlagAnnullato": False},
    ]))
    write(root, "coupon/utilizzi.json", {"dettagli": [{"id": 7, "dati": {"utilizzi": [
        {"IdTransazione": 104, "TotaleIncassatoCoupon": 45, "Data": ms(2026, 9, 15, 9)},
    ]}}]})
    write(root, "magazzino/giacenze.json", page("giacenze", [
        {"ArticoloId": 500, "QuantitaGiacenza": -1, "GiacenzaMinima": 1, "FornitorePredefinitoId": 3},
    ]))
    write(root, "magazzino/giacenze_con_cancellati.json", page("giacenze", [
        {"ArticoloId": 500, "QuantitaGiacenza": -1},
        {"ArticoloId": 501, "ArticoloDescrizione": "Vecchio olio", "QuantitaGiacenza": 2},
    ]))
    write(root, "magazzino/movimenti.json", page("movimenti", [
        {"idMovimento": 1, "idArticolo": "500", "idCausale": "Carico", "causale": "Carico", "quantita": 1,
         "dataMovimento": "01/06/2026", "idOperatore": "op-1", "idTransazione": 0, "descrizione": "DDT 5"},
        {"idMovimento": 2, "idArticolo": "500", "idCausale": "Scarico", "causale": "Scarico da punto vendita", "quantita": 2,
         "dataMovimento": "01/10/2026", "idOperatore": "op-1", "idTransazione": 100, "descrizione": "Vendita"},
    ]))
    write(root, "magazzino/fornitori.json", page("Fornitori", [{"IdFornitore": 3, "Denominazione": "Bio Sculpture Italia"}]))


class ImportAreaBeautyTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        build_export(self.tmp.name)
        self.salon = Salon.objects.create(name="Salone", slug="salone")
        self.location = Location.objects.create(salon=self.salon, name="Sede", is_default=True)
        hands = ServiceCategory.objects.create(salon=self.salon, name_it="Mani")
        addons = ServiceCategory.objects.create(salon=self.salon, name_it="ADD ON")
        self.manicure = Service.objects.create(salon=self.salon, category=hands, name_it="CLASSIC MANICURE", duration_min=45, price=45)
        self.scrub = Service.objects.create(salon=self.salon, category=addons, name_it="FOOT SCRUB", duration_min=10, price=20)
        self.giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="")
        # Dati di prova del salone: spariscono con --purge-test-data.
        self.fake = Client.objects.create(salon=self.salon, first_name="Prova", phone="+393339999999")

    def run_import(self, *extra):
        out = StringIO()
        call_command(
            "import_areabeauty", "--salon", "salone", "--dir", self.tmp.name, "--today", "2026-10-15", *extra, stdout=out
        )
        return out.getvalue()

    def client_of(self, ext):
        ref = ExternalRef.objects.get(salon=self.salon, kind="cliente", external_id=ext)
        return Client.objects.get(pk=ref.object_id)

    def test_full_import(self):
        self.run_import("--purge-test-data")

        self.assertFalse(Client.objects.filter(pk=self.fake.pk).exists())
        # Catalogo: collegati per nome (anche senza il prefisso ADD), gli altri disattivati.
        self.assertEqual(Service.objects.filter(salon=self.salon).count(), 4)
        self.scrub.refresh_from_db()
        self.assertTrue(self.scrub.is_addon)
        pedicure = Service.objects.get(salon=self.salon, name_it="CLASSIC PEDICURE")
        self.assertFalse(pedicure.active)
        self.assertEqual((pedicure.duration_min, pedicure.soak_min), (60, 10))
        self.assertFalse(Package.objects.get(salon=self.salon).active)
        # Operatrici: Giulia collegata, Marta creata disattivata.
        self.assertEqual(Operator.objects.filter(salon=self.salon, active=True).count(), 1)
        marta = Operator.objects.get(salon=self.salon, first_name="Marta")
        self.assertFalse(marta.active)
        self.assertEqual(Absence.objects.get(operator=self.giulia).date_to, dt.date(2026, 10, 21))

        # Clienti: numero condiviso, prefisso +1, anno 1900, consensi.
        anna, bea, carl, dora = (self.client_of(x) for x in ("c-1", "c-2", "c-3", "c-4"))
        self.assertEqual(anna.phone, "+393331112233")
        self.assertEqual((bea.phone, bea.contact_client_id), ("", anna.pk))
        self.assertEqual((carl.phone, carl.lang), ("+12125551234", "en"))
        self.assertEqual((carl.birthday, carl.birthday_year_known), (dt.date(1904, 3, 5), False))
        self.assertEqual(dora.phone, "")
        self.assertEqual(anna.consents, {"privacy": True, "marketing": False, "card_charge": False})
        self.assertEqual(anna.categories.get().name, "Holiday Voucher")
        self.assertEqual(anna.notes.get().text, "Allergica al lattice")

        # Agenda: una catena con aggiuntivo a durata 0 e attesa di mezz'ora.
        visit = Appointment.objects.get(client=anna, status=Appointment.Status.CLOSED)
        items = list(visit.items.order_by("order"))
        self.assertEqual(
            [(i.service_id, i.duration_min, i.soak_min, i.price) for i in items],
            [(self.manicure.pk, 45, 30, Decimal("45")), (self.scrub.pk, 0, 0, Decimal("20")), (pedicure.pk, 60, 0, Decimal("70"))],
        )
        self.assertEqual(visit.operator_id, self.giulia.pk)
        self.assertEqual(items[2].operator_id, marta.pk)
        self.assertEqual(visit.start, dt.datetime(2026, 10, 1, 8, 0, tzinfo=UTC))
        self.assertEqual(Appointment.objects.get(client=bea).status, Appointment.Status.CONFIRMED)
        self.assertEqual(Appointment.objects.get(client=carl).status, Appointment.Status.CANCELLED)
        self.assertEqual(Appointment.objects.get(client=dora).status, Appointment.Status.NO_SHOW)
        cancelled = Appointment.objects.get(client=anna, status=Appointment.Status.NO_SHOW)
        self.assertIn("NON SI E' PRESENTATO", cancelled.cancel_reason)
        self.assertEqual(cancelled.operator.last_name, "non indicata")

        # Scheda tecnica agganciata alla visita del giorno.
        sheet = TechnicalSheet.objects.get(client=anna)
        self.assertEqual(sheet.appointment_id, visit.pk)
        self.assertEqual((sheet.products, sheet.protocol, sheet.params), ("Rosso 12", "Tutto bene", {"stato unghie": "fragili"}))
        self.assertEqual(sheet.created_at, visit.start)

        # Vendite: caparra del 20/9 sul conto del 1/10, resto da saldare.
        bill = Sale.objects.get(appointment=visit)
        self.assertEqual((bill.total, bill.deposit_deducted, bill.amount_due), (Decimal("155"), Decimal("50"), Decimal("20")))
        self.assertEqual(list(bill.payments.values_list("method", "amount")), [("card", Decimal("85.00"))])
        deposit = Sale.objects.get(deposit_appointment=visit)
        self.assertEqual(deposit.payments.get().method, Payment.Method.TRANSFER)
        self.assertEqual(deposit.created_at.date(), dt.date(2026, 9, 20))
        visit.refresh_from_db()
        self.assertEqual(visit.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(bill.lines.get(line_type=SaleLine.LineType.SERVICE, service=pedicure).operator_id, marta.pk)
        self.assertFalse(Sale.objects.filter(salon=self.salon, total=0, lines__isnull=True).exists())
        # Il no-show resta incassato e agganciato alla visita mancata; il prepagato futuro no.
        self.assertEqual(Sale.objects.get(appointment__client=dora).total, Decimal("45"))
        self.assertFalse(Sale.objects.filter(appointment__client=bea).exists())

        # Gift box: stesso codice, usata come pagamento.
        used = GiftCard.objects.get(salon=self.salon, code="AB12")
        self.assertEqual((used.status, used.balance, used.gift_service_id), ("redeemed", Decimal("0"), self.manicure.pk))
        redemption = Sale.objects.get(client=carl, total=Decimal("45"))
        self.assertEqual(redemption.payments.get().gift_card_id, used.pk)
        self.assertEqual(redemption.amount_due, 0)
        self.assertEqual(SaleLine.objects.get(line_type=SaleLine.LineType.GIFT_CARD).gift_card_id, used.pk)
        self.assertEqual(GiftCard.objects.get(salon=self.salon, code="AB13").status, "active")
        # Già pagati: la manicure futura di Bea e la pedicure mai prenotata di Carl.
        prepaid = GiftCard.objects.filter(salon=self.salon, kind=GiftCard.Kind.PREPAID)
        self.assertEqual(
            sorted((c.recipient_client_id, c.gift_service_id, c.balance) for c in prepaid),
            sorted([(bea.pk, self.manicure.pk, Decimal("45")), (carl.pk, pedicure.pk, Decimal("70"))]),
        )

        # Magazzino: storia e giacenza (anche negativa) come in AreaBeauty.
        smalto = Product.objects.get(salon=self.salon, name="Smalto rosso")
        self.assertEqual(smalto.stock_qty, Decimal("-1"))
        self.assertEqual(smalto.supplier.name, "Bio Sculpture Italia")
        self.assertEqual(StockMovement.objects.get(product=smalto, kind="sale").sale_id, bill.pk)
        olio = Product.objects.get(salon=self.salon, name="Vecchio olio")
        self.assertEqual((olio.active, olio.stock_qty), (False, Decimal("2")))
        self.assertEqual(olio.movements.get().qty, Decimal("2"))

        # Niente eventi verso Yourang/WhatsApp, niente registro attività.
        self.assertFalse(OutboxEvent.objects.exists())
        self.assertFalse(ActivityLog.objects.filter(salon=self.salon).exists())

    def test_rerun_adds_nothing_and_redoes_open_appointments(self):
        self.run_import("--purge-test-data")
        models = (Client, Appointment, Sale, Payment, SaleLine, GiftCard, TechnicalSheet, StockMovement, ExternalRef)
        before = {m: m.objects.count() for m in models}
        future = Appointment.objects.get(status=Appointment.Status.CONFIRMED).pk
        out = self.run_import()
        self.assertEqual({m: m.objects.count() for m in models}, before)
        self.assertIn("appuntamenti aperti rifatti dall'export nuovo 1", out)
        self.assertNotEqual(Appointment.objects.get(status=Appointment.Status.CONFIRMED).pk, future)

    def test_rerun_after_a_settled_debt_adds_the_payment(self):
        self.run_import("--purge-test-data")
        path = os.path.join(self.tmp.name, "vendite", "dettaglio", "0001.json")
        with open(path, encoding="utf-8") as fh:
            sales = json.load(fh)
        bill = next(s for s in sales if s["IdTransazione"] == 100)
        bill["dati"]["Pagamenti"].append(payment(100, 1, 20, ms(2026, 10, 10, 9)))
        bill["dati"]["Importi"]["Saldato"] = 155
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(sales, fh)
        self.run_import()
        sale = Sale.objects.get(appointment__client=self.client_of("c-1"), appointment__status="closed")
        self.assertEqual(sale.amount_due, 0)
        self.assertEqual(sale.payments.get(method="cash").created_at, dt.datetime(2026, 10, 10, 9, tzinfo=UTC))

    def test_dry_run_saves_nothing(self):
        out = self.run_import("--dry-run", "--purge-test-data")
        self.assertIn("PROVA", out)
        self.assertTrue(Client.objects.filter(pk=self.fake.pk).exists())
        self.assertFalse(ExternalRef.objects.exists())
        self.assertFalse(Appointment.objects.exists())

    def test_existing_client_with_the_same_number_is_linked(self):
        anna = Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331112233")
        self.run_import()
        self.assertEqual(self.client_of("c-1").pk, anna.pk)
        self.assertEqual(Client.objects.filter(salon=self.salon, phone_key="393331112233").count(), 1)

    def test_manual_mapping(self):
        mapping = os.path.join(self.tmp.name, "map.json")
        with open(mapping, "w", encoding="utf-8") as fh:
            json.dump({
                "servizi": {"16": "CLASSIC MANICURE"},
                "servizi_nome_areabeauty": True,
                "operatrici": {"op-2": self.giulia.pk},
            }, fh)
        self.run_import("--map", mapping, "--steps", "catalog,staff")
        ref = ExternalRef.objects.get(salon=self.salon, kind="servizio", external_id="16")
        self.assertEqual(ref.object_id, self.manicure.pk)
        # Collegato a mano: prende il nome di AreaBeauty. Quelli con lo stesso nome non cambiano.
        self.manicure.refresh_from_db()
        self.assertEqual(self.manicure.name_it, "CLASSIC PEDICURE")
        self.scrub.refresh_from_db()
        self.assertEqual(self.scrub.name_it, "FOOT SCRUB")
        self.assertEqual(ExternalRef.objects.get(salon=self.salon, kind="operatore", external_id="op-2").object_id, self.giulia.pk)
