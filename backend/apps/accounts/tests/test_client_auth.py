"""Accesso delle clienti dalla web app: registrazione, codici OTP, profilo.

Caccia del 22/09:
- 16-01 / 10-04: i tetti per salone di OTP e registrazione non si riempiono più
  con numeri inventati o tentativi respinti;
- 10-14 / 18-12: il doppio invio della registrazione è un 400, non un 500;
- richiesta CLIENTI: la scheda archiviata che prova a entrare non resta un
  vicolo cieco muto, e il profilo modificato dall'app avvisa la dashboard;
- 06-17 / C12: il profilo dell'app porta il consenso marketing.
"""

import datetime as dt
import json
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from apps.core.models import ActivityLog, OutboxEvent, Salon
from common import ratelimit
from common.auth import create_client_tokens
from common.testing import post_json, put_json

from ..models import ClientOTP


def _client_model():
    from apps.clients.models import Client

    return Client


class ClientOTPFlowTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _make_client(self, phone="+393331234567"):
        from apps.clients.models import Client

        return Client.objects.create(
            salon=self.salon,
            first_name="Sofia",
            last_name="Ricci",
            phone=phone,
            lang="it",
        )

    def test_flusso_otp_completo(self):
        # 1. registrazione dalla web app → cliente + client.created + primo OTP
        response = post_json(
            self.client,
            "/api/auth/client/register",
            {
                "salon_slug": "the-parlour",
                "first_name": "Sofia",
                "last_name": "Ricci",
                "phone": "+393331234567",
                "lang": "it",
            },
        )
        self.assertEqual(response.status_code, 200)
        from apps.clients.models import Client

        client_obj = Client.objects.get(salon=self.salon, phone="+393331234567")
        # F1/L15: senza `since` il KPI «nuovi clienti» del cruscotto resta a
        # zero anche con la web app piena di iscrizioni.
        self.assertEqual(client_obj.since, timezone.localdate())
        self.assertTrue(
            OutboxEvent.objects.filter(salon=self.salon, event_type="client.created").exists()
        )

        # telefono duplicato → 400
        response = post_json(
            self.client,
            "/api/auth/client/register",
            {
                "salon_slug": "the-parlour",
                "first_name": "Sofia",
                "last_name": "Ricci",
                "phone": "+393331234567",
            },
        )
        self.assertEqual(response.status_code, 400)

        # 2. richiesta OTP → nuovo codice + evento client.otp con il codice
        response = post_json(
            self.client,
            "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567"},
        )
        self.assertEqual(response.status_code, 200)
        otp = ClientOTP.objects.filter(client=client_obj).latest("created_at")
        event = OutboxEvent.objects.filter(event_type="client.otp").latest("created_at")
        self.assertEqual(event.payload["code"], otp.code)
        self.assertEqual(event.payload["phone"], "+393331234567")

        # telefono sconosciuto → 200 come tutti gli altri, ma nessun codice
        # emesso: la risposta non dice se il numero è in anagrafica
        prima = ClientOTP.objects.count()
        response = post_json(
            self.client,
            "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "+390000000000"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(ClientOTP.objects.count(), prima)

        # 3. verifica con codice sbagliato → 400
        wrong = "000000" if otp.code != "000000" else "111111"
        response = post_json(
            self.client,
            "/api/auth/client/verify-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567", "code": wrong},
        )
        self.assertEqual(response.status_code, 400)

        # 4. verifica corretta → access token + profilo breve
        response = post_json(
            self.client,
            "/api/auth/client/verify-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567", "code": otp.code},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        access = data["access"]
        self.assertEqual(data["client"]["first_name"], "Sofia")

        # il codice è monouso
        response = post_json(
            self.client,
            "/api/auth/client/verify-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567", "code": otp.code},
        )
        self.assertEqual(response.status_code, 400)

        # 5. profilo autenticato
        response = self.client.get(
            "/api/auth/client/me", HTTP_AUTHORIZATION=f"Bearer {access}"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["phone"], "+393331234567")

        # 6. aggiornamento profilo
        response = self.client.put(
            "/api/auth/client/me",
            data=json.dumps({"lang": "en", "email": "sofia@example.com"}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {access}",
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["lang"], "en")
        self.assertEqual(data["email"], "sofia@example.com")

    def test_limite_otp_attivi(self):
        """Oltre i tre codici attivi non ne parte un quarto.

        La risposta resta 200: distinguere il rifiuto dal successo direbbe a
        chiunque provi che quel numero è in anagrafica. Si guarda quindi il
        risultato vero, cioè quanti codici sono stati emessi.
        """
        client_obj = self._make_client()
        payload = {"salon_slug": "the-parlour", "phone": "+393331234567"}
        for _ in range(4):
            response = post_json(self.client, "/api/auth/client/request-otp", payload)
            self.assertEqual(response.status_code, 200)
        self.assertEqual(ClientOTP.objects.filter(client=client_obj).count(), 3)

    def test_codice_scaduto_non_vale_piu(self):
        """T13: la scadenza dell'OTP non era mai stata verificata."""
        client_obj = self._make_client()
        payload = {"salon_slug": "the-parlour", "phone": "+393331234567"}
        self.assertEqual(post_json(self.client, "/api/auth/client/request-otp", payload).status_code, 200)
        otp = ClientOTP.objects.get(client=client_obj)

        # L'orologio si sposta sul codice: dieci minuti dopo non vale più.
        ClientOTP.objects.filter(pk=otp.pk).update(
            expires_at=timezone.now() - dt.timedelta(seconds=1)
        )
        response = post_json(
            self.client,
            "/api/auth/client/verify-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567", "code": otp.code},
        )
        self.assertEqual(response.status_code, 400)
        otp.refresh_from_db()
        self.assertFalse(otp.used)  # scaduto, non consumato

        # E un codice scaduto non occupa uno dei tre posti attivi: la cliente
        # che torna il giorno dopo deve poterne chiedere un altro.
        self.assertEqual(post_json(self.client, "/api/auth/client/request-otp", payload).status_code, 200)
        self.assertEqual(
            ClientOTP.objects.filter(client=client_obj, expires_at__gt=timezone.now()).count(), 1
        )


class ClientOTPSecurityTests(TestCase):
    """Login OTP: limite ai tentativi errati, limite alle richieste, numero
    riconosciuto comunque sia scritto, codice mai nei log."""

    URL_REQUEST = "/api/auth/client/request-otp"
    URL_VERIFY = "/api/auth/client/verify-otp"

    def setUp(self):
        # Niente `cache.clear()`: i contatori dei rate limit non vivono più in
        # cache ma nella tabella core.RateLimitCounter (vedi common/ratelimit),
        # e ogni test gira in una transazione che viene annullata alla fine —
        # quindi partono già azzerati. La riga di pulizia dava l'impressione
        # sbagliata che senza di lei i test si sporcassero a vicenda.
        from apps.clients.models import Client

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+39 333 1234567", lang="it"
        )

    def _request_otp(self, phone):
        return post_json(self.client, self.URL_REQUEST, {"salon_slug": "the-parlour", "phone": phone})

    def _verify(self, phone, code):
        return post_json(
            self.client, self.URL_VERIFY, {"salon_slug": "the-parlour", "phone": phone, "code": code}
        )

    def test_phone_spelling_variants_reach_the_same_client(self):
        for phone in ("3331234567", "+393331234567", "0039 333 1234567"):
            self.assertEqual(self._request_otp(phone).status_code, 200, phone)
        self.assertEqual(ClientOTP.objects.filter(client=self.client_obj).count(), 3)

    def test_wrong_codes_burn_the_otp_after_five_attempts(self):
        self.assertEqual(self._request_otp("+393331234567").status_code, 200)
        otp = ClientOTP.objects.get(client=self.client_obj)
        wrong = "000000" if otp.code != "000000" else "111111"
        statuses = [self._verify("3331234567", wrong).status_code for _ in range(5)]
        self.assertEqual(statuses, [400, 400, 400, 400, 429])
        # il codice giusto ormai non vale più: serve richiederne uno nuovo
        self.assertEqual(self._verify("3331234567", otp.code).status_code, 400)
        otp.refresh_from_db()
        self.assertTrue(otp.used)

    def test_otp_requests_are_rate_limited_per_client(self):
        # I codici vengono consumati a ogni giro per isolare il limite per finestra
        # da quello sui codici attivi contemporanei (MAX_ACTIVE_OTP).
        for _ in range(5):
            self.assertEqual(self._request_otp("+393331234567").status_code, 200)
            ClientOTP.objects.filter(client=self.client_obj).update(used=True)
        # La sesta richiesta risponde come le altre ma non emette niente: il
        # tetto per cliente non deve trapelare dalla risposta.
        self.assertEqual(self._request_otp("+393331234567").status_code, 200)
        self.assertEqual(ClientOTP.objects.filter(client=self.client_obj, used=False).count(), 0)

    def test_a_request_for_an_unknown_number_is_indistinguishable(self):
        """S4: la rubrica clienti non si ricava dalle risposte dell'endpoint."""
        conosciuto = self._request_otp("+393331234567")
        sconosciuto = self._request_otp("+393339999999")
        self.assertEqual(conosciuto.status_code, sconosciuto.status_code)
        self.assertEqual(conosciuto.content, sconosciuto.content)
        # E il codice sbagliato su un numero inesistente risponde come su uno
        # esistente: nemmeno la verifica dice chi c'è in anagrafica.
        self.assertEqual(self._verify("+393339999999", "000000").status_code, 400)

    def test_the_cap_per_address_stops_the_enumeration(self):
        """Senza tetto per IP uno script cicla i numeri finché non li trova tutti."""
        from ..api.client import OTP_MAX_PER_IP

        for n in range(OTP_MAX_PER_IP):
            self.assertEqual(self._request_otp(f"+39333444{n:04d}").status_code, 200)
        self.assertEqual(self._request_otp("+393335550000").status_code, 429)

    def test_outbox_log_never_contains_the_code(self):
        with self.assertLogs("youty.events", level="INFO") as logs:
            self.assertEqual(self._request_otp("+393331234567").status_code, 200)
        otp = ClientOTP.objects.get(client=self.client_obj)
        self.assertFalse(any(otp.code in line for line in logs.output), logs.output)


class ClientRegisterRateLimitTests(TestCase):
    """La registrazione è pubblica e ogni successo accoda un messaggio a spese
    del salone: senza tetto uno script crea schede e manda codici a raffica."""

    def setUp(self):
        # I contatori stanno su tabella e la transazione del test li annulla:
        # non serve svuotare nessuna cache (vedi ClientOTPSecurityTests.setUp).
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _register(self, phone, ip="203.0.113.7"):
        return post_json(
            self.client,
            "/api/auth/client/register",
            {
                "salon_slug": "the-parlour",
                "first_name": "Sofia",
                "last_name": "Ricci",
                "phone": phone,
            },
            REMOTE_ADDR=ip,
        )

    def test_the_sixth_registration_from_one_address_is_refused(self):
        statuses = [self._register(f"+39333111{n:04d}").status_code for n in range(6)]
        self.assertEqual(statuses, [200, 200, 200, 200, 200, 429])
        # nessuna scheda creata per la richiesta rifiutata
        from apps.clients.models import Client

        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 5)

    def test_a_different_address_is_counted_separately(self):
        for n in range(5):
            self.assertEqual(self._register(f"+39333222{n:04d}").status_code, 200)
        self.assertEqual(self._register("+393339999999", ip="198.51.100.4").status_code, 200)

    def test_the_last_proxy_hop_is_what_counts(self):
        """X-Forwarded-For è scrivibile dal client: se contasse il primo elemento
        basterebbe cambiare un header a ogni richiesta per aggirare il tetto."""
        for n in range(5):
            res = self.client.post(
                "/api/auth/client/register",
                data=json.dumps({
                    "salon_slug": "the-parlour", "first_name": "Sofia",
                    "last_name": "Ricci", "phone": f"+39333333{n:04d}",
                }),
                content_type="application/json",
                HTTP_X_FORWARDED_FOR=f"10.0.0.{n}, 203.0.113.9",
            )
            self.assertEqual(res.status_code, 200, res.content)
        res = self.client.post(
            "/api/auth/client/register",
            data=json.dumps({
                "salon_slug": "the-parlour", "first_name": "Sofia",
                "last_name": "Ricci", "phone": "+393334440000",
            }),
            content_type="application/json",
            HTTP_X_FORWARDED_FOR="10.0.0.99, 203.0.113.9",
        )
        self.assertEqual(res.status_code, 429)


class OtpSalonCapTests(TestCase):
    """16-01: il tetto per salone si riempiva con numeri inventati."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sofia = _client_model().objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567"
        )

    def _otp(self, phone, ip):
        return post_json(
            self.client,
            "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": phone},
            REMOTE_ADDR=ip,
        )

    def test_invented_numbers_from_a_few_addresses_do_not_lock_the_real_client_out(self):
        # Cento richieste su numeri inesistenti da cinque reti, venti ciascuna
        # (sotto il tetto per IP): nessun codice parte.
        for i in range(100):
            self.assertEqual(self._otp(f"+39333{i:07d}", f"203.0.113.{i % 5 + 1}").status_code, 200)
        # La cliente vera, da casa sua, riceve il codice.
        res = self._otp("+393331234567", "198.51.100.7")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(ClientOTP.objects.filter(client=self.sofia).count(), 1)

    def test_many_requests_are_still_reported(self):
        from ..api.client import OTP_ALERT_PER_SALON

        with self.assertLogs("apps.accounts.api", level="WARNING") as logs:
            for i in range(OTP_ALERT_PER_SALON + 1):
                self._otp(f"+39333{i:07d}", f"203.0.113.{i % 5 + 1}")
        self.assertTrue(any("molte richieste" in line for line in logs.output), logs.output)

    def test_the_cap_on_issued_codes_answers_the_same_for_every_number(self):
        """Pieno di codici veri, il salone si ferma per tutti allo stesso modo."""
        with mock.patch("apps.accounts.api.client.OTP_MAX_ISSUED_PER_SALON", 1):
            self.assertEqual(self._otp("+393331234567", "198.51.100.7").status_code, 200)
            known = self._otp("+393331234567", "198.51.100.8")
            unknown = self._otp("+393339999999", "198.51.100.9")
        self.assertEqual(known.status_code, 429)
        self.assertEqual((known.status_code, known.content), (unknown.status_code, unknown.content))
        self.assertEqual(ClientOTP.objects.filter(client=self.sofia).count(), 1)

    def test_codes_withheld_by_the_client_cap_do_not_count(self):
        # Il sesto codice della stessa cliente non parte (tetto per cliente):
        # non deve consumare il budget del salone.
        for _ in range(6):
            self._otp("+393331234567", "198.51.100.7")
            ClientOTP.objects.filter(client=self.sofia).update(used=True)
        self.assertEqual(ratelimit.peek(f"otp-issued-salon:{self.salon.id}"), 5)


class RegisterSalonCapTests(TestCase):
    """10-04: il tetto per salone della registrazione contava anche i rifiuti."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        _client_model().objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567"
        )

    def _register(self, phone, ip):
        return post_json(
            self.client,
            "/api/auth/client/register",
            {"salon_slug": "the-parlour", "first_name": "Nuova", "last_name": "Cliente", "phone": phone},
            REMOTE_ADDR=ip,
        )

    def test_refused_attempts_do_not_fill_the_salon_cap(self):
        with mock.patch("apps.accounts.api.client.REGISTER_MAX_PER_SALON", 2):
            for n in range(4):
                self.assertEqual(self._register("+393331234567", f"203.0.113.{n + 1}").status_code, 400)
            res = self._register("+393335550001", "198.51.100.7")
        self.assertEqual(res.status_code, 200, res.content)

    def test_created_profiles_are_still_capped(self):
        with mock.patch("apps.accounts.api.client.REGISTER_MAX_PER_SALON", 2):
            statuses = [
                self._register(f"+39333555000{n}", f"203.0.113.{n + 1}").status_code for n in range(3)
            ]
        self.assertEqual(statuses, [200, 200, 429])
        self.assertEqual(_client_model().objects.filter(salon=self.salon).count(), 3)


class RegisterDoubleSubmitTests(TestCase):
    """10-14 + 18-12: doppio tocco su «Registrati»."""

    def test_the_second_request_of_a_double_tap_is_a_400(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        Client = _client_model()
        # La prima richiesta ha appena inserito la scheda; la seconda aveva già
        # superato il controllo sul numero quando la prima non era ancora visibile.
        Client.objects.create(salon=salon, first_name="Sofia", last_name="Ricci", phone="+393331234567")
        self.client.raise_request_exception = False
        with mock.patch("apps.accounts.api.client.find_client_by_phone", return_value=None):
            res = post_json(
                self.client,
                "/api/auth/client/register",
                {"salon_slug": "the-parlour", "first_name": "Sofia", "last_name": "Ricci",
                 "phone": "+393331234567"},
            )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(Client.objects.filter(salon=salon).count(), 1)
        self.assertFalse(ClientOTP.objects.exists())


class ArchivedClientAccessTests(TestCase):
    """Richiesta CLIENTI: la scheda archiviata che prova a entrare dall'app."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.archived = _client_model().objects.create(
            salon=self.salon, first_name="Xenia", last_name="Rossi", phone="+393331112233",
            is_active=False,
        )

    def _notices(self):
        return ActivityLog.objects.filter(salon=self.salon, type="client.reactivation_requested")

    def test_the_salon_is_told_and_the_answer_does_not_reveal_anything(self):
        archived = post_json(
            self.client, "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "333 111 2233"},
        )
        unknown = post_json(
            self.client, "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "+393339998877"},
        )
        self.assertEqual((archived.status_code, archived.content), (unknown.status_code, unknown.content))
        # Nessun codice alla scheda archiviata, e la scheda resta archiviata…
        self.assertFalse(ClientOTP.objects.filter(client=self.archived).exists())
        self.archived.refresh_from_db()
        self.assertFalse(self.archived.is_active)
        # …ma il salone lo sa, con la scheda da aprire.
        notice = self._notices().get()
        self.assertEqual(notice.payload["client_id"], self.archived.id)

    def test_one_notice_a_day_per_profile(self):
        for _ in range(3):
            post_json(
                self.client, "/api/auth/client/request-otp",
                {"salon_slug": "the-parlour", "phone": "+393331112233"},
            )
        res = post_json(
            self.client, "/api/auth/client/register",
            {"salon_slug": "the-parlour", "first_name": "Xenia", "last_name": "Rossi",
             "phone": "+393331112233"},
        )
        # La registrazione risponde come per una scheda attiva: l'app mostra la
        # schermata «numero già registrato» con «Chiama il salone».
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(self._notices().count(), 1)

    def test_an_active_client_raises_no_notice(self):
        _client_model().objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393334445566"
        )
        post_json(
            self.client, "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "+393334445566"},
        )
        self.assertFalse(self._notices().exists())


class ClientProfileTests(TestCase):
    """C12 + 18-07 + richiesta CLIENTI: profilo della cliente nell'app."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sofia = _client_model().objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567",
            consents={"privacy": True, "marketing": True, "card_charge": False},
        )
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.sofia)['access']}"}

    def _put(self, body):
        return put_json(self.client, "/api/auth/client/me", body, **self.auth)

    def test_the_profile_carries_the_marketing_consent(self):
        res = self.client.get("/api/auth/client/me", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIs(res.json()["marketing_consent"], True)
        self.sofia.consents = {"privacy": True, "marketing": False}
        self.sofia.save(update_fields=["consents"])
        self.assertIs(self.client.get("/api/auth/client/me", **self.auth).json()["marketing_consent"], False)

    def test_saving_from_the_app_does_not_overwrite_what_the_salon_changed_meanwhile(self):
        """La scheda è letta all'autenticazione; il salone la modifica prima del salvataggio."""
        from common.auth import ClientAuth

        original = ClientAuth.authenticate

        def authenticate_then_salon_edits(auth, request, token):
            ctx = original(auth, request, token)
            type(ctx.client).objects.filter(pk=ctx.client.pk).update(
                first_name="Sofia Maria", consents={"privacy": True, "marketing": False}
            )
            return ctx

        with mock.patch.object(ClientAuth, "authenticate", authenticate_then_salon_edits):
            res = self._put({"lang": "en"})
        self.assertEqual(res.status_code, 200, res.content)
        self.sofia.refresh_from_db()
        self.assertEqual(self.sofia.lang, "en")
        self.assertEqual(self.sofia.first_name, "Sofia Maria")
        self.assertIs(self.sofia.consents["marketing"], False)

    def test_a_change_from_the_app_reaches_the_open_dashboard_card(self):
        self.assertEqual(self._put({"email": "sofia@example.com"}).status_code, 200)
        event = ActivityLog.objects.get(salon=self.salon, type="client.updated")
        self.assertEqual(event.payload["client_id"], self.sofia.id)
        # Rimandare gli stessi valori non è una modifica: nessun nuovo evento.
        self.assertEqual(self._put({"email": "sofia@example.com"}).status_code, 200)
        self.assertEqual(ActivityLog.objects.filter(type="client.updated").count(), 1)
