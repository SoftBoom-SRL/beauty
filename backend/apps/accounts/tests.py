"""Test essenziali accounts: login staff, refresh, flusso OTP completo, ruoli default.

Nota: i test HTTP passano dalla NinjaAPI montata in config/api.py, quindi
richiedono che tutte le app di dominio siano presenti (post-integrazione).
"""

import datetime as dt
import json

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.utils import timezone

from apps.core.models import OutboxEvent, Salon
from common.permissions import SCOPES

from .models import ClientOTP, Membership, Role, StaffRefreshToken, User
from .services import ensure_default_roles


def post_json(client, url, data, **extra):
    return client.post(url, data=json.dumps(data), content_type="application/json", **extra)


class DefaultRolesTests(TestCase):
    def test_ensure_default_roles_idempotente(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        ensure_default_roles(salon)
        ensure_default_roles(salon)  # seconda chiamata: nessun duplicato
        roles = Role.objects.filter(salon=salon, is_system=True)
        self.assertEqual(roles.count(), 3)
        self.assertEqual(
            roles.get(name="Manager").scopes,
            ["agenda", "clients", "sales", "inventory", "pricing", "marketing"],
        )
        self.assertEqual(roles.get(name="Front desk").scopes, ["agenda", "clients", "sales"])
        self.assertEqual(roles.get(name="Operatrice").scopes, ["agenda", "clients"])


class StaffAuthTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(
            email="anna@parlour.it",
            password="segretissima",
            first_name="Anna",
            last_name="Bianchi",
        )
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)

    def _login(self):
        return post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "anna@parlour.it", "password": "segretissima"},
        )

    def test_login_ok(self):
        response = self._login()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("access", data)
        self.assertIn("refresh", data)
        self.assertTrue(data["is_owner"])
        self.assertEqual(data["user"]["email"], "anna@parlour.it")
        self.assertEqual(data["salon"]["slug"], "the-parlour")

    def test_login_credenziali_errate(self):
        response = post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "anna@parlour.it", "password": "sbagliata"},
        )
        self.assertEqual(response.status_code, 401)

    def test_refresh(self):
        tokens = self._login().json()
        response = post_json(self.client, "/api/auth/staff/refresh", {"refresh": tokens["refresh"]})
        self.assertEqual(response.status_code, 200)
        self.assertIn("access", response.json())
        # un access token non è un refresh token valido
        response = post_json(self.client, "/api/auth/staff/refresh", {"refresh": tokens["access"]})
        self.assertEqual(response.status_code, 401)

    def test_me(self):
        access = self._login().json()["access"]
        response = self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {access}")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["user"]["email"], "anna@parlour.it")
        self.assertTrue(data["is_owner"])


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
        from .api import OTP_MAX_PER_IP

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


class InvitationPasswordTests(TestCase):
    """Un invito non deve poter creare un account senza password vera.

    Accettando l'invito con password vuota l'account nasceva comunque, e poi il
    login con quella stessa password vuota funzionava.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.role = Role.objects.create(salon=self.salon, name="Front Desk", scopes=["agenda"])

    def _accept(self, invitation, password):
        return post_json(
            self.client,
            "/api/auth/invitations/accept",
            {
                "token": str(invitation.token),
                "password": password,
                "first_name": "Giulia",
                "last_name": "Verdi",
            },
        )

    def test_empty_password_is_refused_and_the_invitation_stays_usable(self):
        from .models import Invitation

        invitation = Invitation.objects.create(
            salon=self.salon, email="giulia@parlour.it", role=self.role
        )
        refused = self._accept(invitation, "")
        self.assertEqual(refused.status_code, 400)
        self.assertFalse(User.objects.filter(email="giulia@parlour.it").exists())
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, Invitation.Status.PENDING)

        # Un rifiuto non brucia l'invito: con una password valida si entra.
        accepted = self._accept(invitation, "Cartellina-2026")
        self.assertEqual(accepted.status_code, 200, accepted.content)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, Invitation.Status.ACCEPTED)

    def test_short_and_common_passwords_are_refused(self):
        from .models import Invitation

        for password in ("abc", "password"):
            invitation = Invitation.objects.create(
                salon=self.salon, email=f"{password}@parlour.it", role=self.role
            )
            response = self._accept(invitation, password)
            self.assertEqual(response.status_code, 400, password)


class StaffLoginThrottleTests(TestCase):
    """Le credenziali staff non devono essere provabili all'infinito."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)

    def _login(self, password, ip="203.0.113.5"):
        return post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "anna@parlour.it", "password": password},
            REMOTE_ADDR=ip,
        )

    def test_repeated_wrong_passwords_get_throttled(self):
        from .api import LOGIN_MAX_PER_ACCOUNT

        statuses = [self._login("sbagliata").status_code for _ in range(LOGIN_MAX_PER_ACCOUNT)]
        self.assertEqual(set(statuses), {401})
        # Superato il tetto non si prova più, nemmeno con la password giusta.
        self.assertEqual(self._login("sbagliata").status_code, 429)
        self.assertEqual(self._login("segretissima").status_code, 429)

    def test_a_good_login_clears_the_counter(self):
        for _ in range(3):
            self._login("sbagliata")
        self.assertEqual(self._login("segretissima").status_code, 200)
        # Il contatore riparte: la collega che sbaglia tre volte e poi entra
        # non si trova bloccata al tentativo successivo.
        statuses = [self._login("sbagliata").status_code for _ in range(4)]
        self.assertEqual(set(statuses), {401})

    def test_the_cap_per_address_covers_many_accounts(self):
        from .api import LOGIN_MAX_PER_IP

        for n in range(LOGIN_MAX_PER_IP):
            post_json(
                self.client,
                "/api/auth/staff/login",
                {"email": f"tizia{n}@parlour.it", "password": "tentativo"},
                REMOTE_ADDR="203.0.113.6",
            )
        blocked = post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "altra@parlour.it", "password": "tentativo"},
            REMOTE_ADDR="203.0.113.6",
        )
        self.assertEqual(blocked.status_code, 429)
        # Un altro indirizzo non paga per quello bloccato.
        self.assertEqual(self._login("segretissima", ip="203.0.113.7").status_code, 200)


class StaffSessionTests(TestCase):
    """T14 + S3 + S7: cambiare la password caccia fuori davvero, e il refresh
    non è una sessione scorrevole infinita.

    I JWT sono stateless: finché non scadono valgono. Se il cambio password non
    li invalida, l'account compromesso resta compromesso per trenta giorni, ed
    è esattamente la situazione in cui la password si cambia."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)

    def _login(self, password="segretissima"):
        return post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "anna@parlour.it", "password": password},
        ).json()

    def _me(self, access):
        return self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {access}")

    def _refresh(self, refresh):
        return post_json(self.client, "/api/auth/staff/refresh", {"refresh": refresh})

    def test_changing_the_password_kills_every_open_session(self):
        vecchia = self._login()
        self.assertEqual(self._me(vecchia["access"]).status_code, 200)

        cambio = post_json(
            self.client,
            "/api/auth/staff/password",
            {"current_password": "segretissima", "new_password": "Cartellina-2026"},
            HTTP_AUTHORIZATION=f"Bearer {vecchia['access']}",
        )
        self.assertEqual(cambio.status_code, 200, cambio.content)

        # L'access token di prima non apre più niente...
        self.assertEqual(self._me(vecchia["access"]).status_code, 401)
        # ...e il refresh non permette di rifarsene uno (era la strada con cui
        # un attaccante restava dentro a tempo indeterminato).
        self.assertEqual(self._refresh(vecchia["refresh"]).status_code, 401)
        # Chi ha cambiato la password resta operativo con i token nuovi.
        self.assertEqual(self._me(cambio.json()["access"]).status_code, 200)

    def test_a_password_set_outside_the_endpoint_kills_the_sessions_too(self):
        """S3: dall'admin Django, da `changepassword` o da uno script."""
        vecchia = self._login()
        self.user.set_password("Cartellina-2026")  # quello che fa il form dell'admin
        self.user.save()

        self.assertEqual(self._me(vecchia["access"]).status_code, 401)
        self.assertEqual(self._refresh(vecchia["refresh"]).status_code, 401)
        self.assertEqual(self.user.token_version, 1)

    def test_creating_a_user_does_not_burn_a_version(self):
        """Il primo set_password non è un cambio: nessuno da sloggare."""
        nuovo = User.objects.create_user(email="giulia@parlour.it", password="Cartellina-2026")
        self.assertEqual(nuovo.token_version, 0)

    def test_rehashing_the_same_password_does_not_log_anyone_out(self):
        """Django riscrive l'hash quando cambiano i parametri dell'hasher.

        Passa dalla stessa strada (set_password) ma con la STESSA password: se
        contasse come cambio, un aggiornamento di Django sloggherebbe l'intero
        salone al primo accesso di ciascuno."""
        prima = self.user.token_version
        self.user.set_password("segretissima")
        self.assertEqual(self.user.token_version, prima)

    def test_the_refresh_rotates_and_the_spent_one_stops_working(self):
        sessione = self._login()
        rinnovo = self._refresh(sessione["refresh"])
        self.assertEqual(rinnovo.status_code, 200)
        nuovo = rinnovo.json()["refresh"]
        self.assertNotEqual(nuovo, sessione["refresh"])
        # Quello nuovo funziona.
        self.assertEqual(self._refresh(nuovo).status_code, 200)

        # Il token speso resta buono per i pochi secondi di tolleranza (le
        # schede multiple della dashboard rinnovano insieme)...
        self.assertEqual(self._refresh(sessione["refresh"]).status_code, 200)
        # ...ma non oltre: la copia esfiltrata muore al primo rinnovo fatto dal
        # proprietario. Si sposta l'orologio sulle revoche già registrate.
        StaffRefreshToken.objects.filter(revoked_at__isnull=False).update(
            revoked_at=timezone.now() - dt.timedelta(minutes=5)
        )
        self.assertEqual(self._refresh(sessione["refresh"]).status_code, 401)

    def test_logout_revokes_the_session_server_side(self):
        """Il POST è nudo: nessun corpo da mandare, nessun 400 da gestire."""
        sessione = self._login()
        uscita = self.client.post(
            "/api/auth/staff/logout", HTTP_AUTHORIZATION=f"Bearer {sessione['access']}"
        )
        self.assertEqual(uscita.status_code, 200, uscita.content)
        self.assertEqual(self._refresh(sessione["refresh"]).status_code, 401)

    def test_logout_closes_every_device(self):
        """Il titolare che ha perso il telefono non ha in mano quel refresh."""
        telefono = self._login()
        computer = self._login()
        uscita = self.client.post(
            "/api/auth/staff/logout", HTTP_AUTHORIZATION=f"Bearer {computer['access']}"
        )
        self.assertEqual(uscita.status_code, 200, uscita.content)
        self.assertEqual(self._refresh(telefono["refresh"]).status_code, 401)
        self.assertEqual(self._refresh(computer["refresh"]).status_code, 401)

    def test_logout_closes_the_grace_window_too(self):
        """Chi esce è fuori subito, anche dal token appena ruotato.

        La tolleranza serve alle schede multiple che rinnovano insieme, non a
        far sopravvivere una sessione che qualcuno ha chiuso apposta."""
        sessione = self._login()
        rinnovo = self._refresh(sessione["refresh"]).json()
        uscita = self.client.post(
            "/api/auth/staff/logout", HTTP_AUTHORIZATION=f"Bearer {rinnovo['access']}"
        )
        self.assertEqual(uscita.status_code, 200, uscita.content)
        self.assertEqual(self._refresh(rinnovo["refresh"]).status_code, 401)
        self.assertEqual(self._refresh(sessione["refresh"]).status_code, 401)

    def test_a_login_leaves_exactly_one_live_session(self):
        self._login()
        self.assertEqual(
            StaffRefreshToken.objects.filter(user=self.user, revoked_at__isnull=True).count(), 1
        )


class TeamPrivilegeTests(TestCase):
    """S5: lo scope `team` gestisce il personale, non promuove a titolare.

    Al responsabile del personale viene dato il solo scope team. Senza questi
    controlli si creava un ruolo con tutti e nove i permessi e se lo assegnava:
    al rinnovo aveva incassi, listino, magazzino e analisi che il titolare gli
    aveva negato."""

    def setUp(self):
        from common.auth import create_staff_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = User.objects.create_user(email="titolare@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=self.owner, salon=self.salon, is_owner=True)

        self.role_team = Role.objects.create(salon=self.salon, name="Personale", scopes=["team"])
        self.manager = User.objects.create_user(email="hr@parlour.it", password="x-Segreta-1")
        self.manager_membership = Membership.objects.create(
            user=self.manager, salon=self.salon, role=self.role_team
        )
        self.hr = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.manager, self.salon)['access']}"
        }
        self.boss = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.owner, self.salon)['access']}"
        }

    def test_a_role_cannot_grant_scopes_the_caller_does_not_have(self):
        response = post_json(
            self.client,
            "/api/auth/roles",
            {"name": "Tuttofare", "scopes": ["team", "sales", "insights"]},
            **self.hr,
        )
        self.assertEqual(response.status_code, 403, response.content)
        self.assertFalse(Role.objects.filter(salon=self.salon, name="Tuttofare").exists())

    def test_a_role_with_only_owned_scopes_is_allowed(self):
        response = post_json(
            self.client, "/api/auth/roles", {"name": "Vice", "scopes": ["team"]}, **self.hr
        )
        self.assertEqual(response.status_code, 200, response.content)

    def test_nobody_edits_their_own_membership(self):
        potente = Role.objects.create(salon=self.salon, name="Tutto", scopes=["team", "sales"])
        response = post_json(
            self.client,
            f"/api/auth/members/{self.manager_membership.id}/role",
            {"role_id": potente.id},
            **self.hr,
        )
        self.assertEqual(response.status_code, 403, response.content)
        self.manager_membership.refresh_from_db()
        self.assertEqual(self.manager_membership.role_id, self.role_team.id)

    def test_a_colleague_cannot_be_given_more_than_the_caller_has(self):
        collega = User.objects.create_user(email="sofia@parlour.it", password="x-Segreta-1")
        membership = Membership.objects.create(user=collega, salon=self.salon)
        potente = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        response = post_json(
            self.client, f"/api/auth/members/{membership.id}/role", {"role_id": potente.id}, **self.hr
        )
        self.assertEqual(response.status_code, 403, response.content)

    def test_an_invitation_cannot_smuggle_in_a_powerful_role(self):
        potente = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        response = post_json(
            self.client,
            "/api/auth/invitations",
            {"email": "nuova@parlour.it", "role_id": potente.id},
            **self.hr,
        )
        self.assertEqual(response.status_code, 403, response.content)

    def test_a_more_powerful_colleague_cannot_be_removed(self):
        collega = User.objects.create_user(email="sofia@parlour.it", password="x-Segreta-1")
        potente = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        membership = Membership.objects.create(user=collega, salon=self.salon, role=potente)
        response = self.client.delete(f"/api/auth/members/{membership.id}", **self.hr)
        self.assertEqual(response.status_code, 403, response.content)

    def test_the_owner_still_runs_the_salon(self):
        """Il titolare seminato deve continuare a lavorare senza limiti."""
        creazione = post_json(
            self.client,
            "/api/auth/roles",
            {"name": "Tuttofare", "scopes": list(SCOPES)},
            **self.boss,
        )
        self.assertEqual(creazione.status_code, 200, creazione.content)
        role_id = creazione.json()["id"]
        assegnazione = post_json(
            self.client,
            f"/api/auth/members/{self.manager_membership.id}/role",
            {"role_id": role_id},
            **self.boss,
        )
        self.assertEqual(assegnazione.status_code, 200, assegnazione.content)


class MediaGuardTests(TestCase):
    """S2 + S14: /media/ vive sull'origin dell'API, dove sta anche /admin/.

    Un file servito come pagina eseguirebbe il suo JavaScript lì dentro: un
    amministratore che apre il link consegna la sessione di superuser. (I test
    stanno qui perché `common/` non ha una sua suite.)"""

    def test_an_html_file_declared_as_an_image_is_refused(self):
        from ninja.errors import HttpError

        from common.media import IMAGE_CONTENT_TYPES, validate_upload

        evil = SimpleUploadedFile("evil.html", b"<script>", content_type="image/png")
        with self.assertRaises(HttpError) as caso:
            validate_upload(evil, allowed_types=IMAGE_CONTENT_TYPES)
        self.assertEqual(caso.exception.status_code, 400)

    def test_an_unknown_declared_type_is_refused(self):
        from ninja.errors import HttpError

        from common.media import IMAGE_CONTENT_TYPES, validate_upload

        evil = SimpleUploadedFile("evil.svg", b"<svg/>", content_type="image/svg+xml")
        with self.assertRaises(HttpError):
            validate_upload(evil, allowed_types=IMAGE_CONTENT_TYPES)

    def test_the_stored_name_comes_from_the_server(self):
        from common.media import IMAGE_CONTENT_TYPES, stored_upload_name

        foto = SimpleUploadedFile("../../etc/foto.PNG", b"x", content_type="image/png")
        nome = stored_upload_name(foto, allowed_types=IMAGE_CONTENT_TYPES)
        self.assertTrue(nome.endswith(".png"), nome)
        self.assertNotIn("/", nome)
        self.assertNotIn("foto", nome)

    def test_a_file_too_big_is_refused(self):
        from ninja.errors import HttpError

        from common.media import IMAGE_CONTENT_TYPES, validate_upload

        grande = SimpleUploadedFile("foto.png", b"x", content_type="image/png")
        grande.size = 20 * 1024 * 1024
        with self.assertRaises(HttpError):
            validate_upload(grande, allowed_types=IMAGE_CONTENT_TYPES)

    def test_reserved_prefixes_ignore_the_case(self):
        """Su un volume case-insensitive «Client_notes/…» apre lo stesso file."""
        from common.media import is_private

        self.assertTrue(is_private("client_notes/1/2/foto.jpg"))
        self.assertTrue(is_private("Client_Notes/1/2/foto.jpg"))
        self.assertFalse(is_private("branding/logo.png"))

    def test_only_real_images_are_opened_in_the_page(self):
        import tempfile
        from pathlib import Path

        from django.test import RequestFactory, override_settings

        from common.media import serve_media

        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "branding").mkdir()
            Path(tmp, "branding", "logo.png").write_bytes(b"\x89PNG")
            Path(tmp, "branding", "nota.pdf").write_bytes(b"%PDF-1.4")
            with override_settings(MEDIA_ROOT=tmp):
                richiesta = RequestFactory().get("/media/branding/logo.png")
                immagine = serve_media(richiesta, "branding/logo.png")
                # FileResponse mette comunque un Content-Disposition: quello che
                # conta è che non sia «attachment», così l'immagine resta
                # visualizzabile in pagina.
                self.assertNotIn("attachment", immagine.get("Content-Disposition", ""))
                self.assertEqual(immagine["X-Content-Type-Options"], "nosniff")

                richiesta = RequestFactory().get("/media/branding/nota.pdf")
                documento = serve_media(richiesta, "branding/nota.pdf")
                self.assertIn("attachment", documento["Content-Disposition"])


class ClientIpTests(TestCase):
    """S9: X-Forwarded-For è testo scritto dal client.

    Se lo si legge anche quando la connessione NON arriva dal proxy, basta
    cambiarlo a ogni richiesta per avere un secchiello nuovo ogni volta e ogni
    tetto — login staff, registrazioni, OTP — sparisce."""

    def test_the_header_counts_only_behind_the_proxy(self):
        from django.test import RequestFactory

        from common.ratelimit import client_ip

        # Connessione dalla rete interna di Docker: è il nostro proxy, e l'ultimo
        # anello della catena è il peer vero.
        dietro_proxy = RequestFactory().get(
            "/", REMOTE_ADDR="172.18.0.5", HTTP_X_FORWARDED_FOR="10.0.0.1, 203.0.113.9"
        )
        self.assertEqual(client_ip(dietro_proxy), "203.0.113.9")

        # Container raggiungibile direttamente: l'header è solo un'affermazione
        # dello sconosciuto che sta chiamando.
        diretto = RequestFactory().get(
            "/", REMOTE_ADDR="198.51.100.20", HTTP_X_FORWARDED_FOR="10.0.0.1, 1.2.3.4"
        )
        self.assertEqual(client_ip(diretto), "198.51.100.20")

    def test_a_very_long_email_does_not_blow_up_the_login(self):
        """S11: la chiave del contatore finiva in un CharField(200)."""
        from .api import _login_account_key

        chiave = _login_account_key("a" * 400 + "@example.com")
        self.assertLessEqual(len(chiave), 200)


class StreamPermissionTests(TestCase):
    """S6: lo stream live consegnava a chiunque quello che l'API nega.

    Un'operatrice con agenda e clienti riceveva in tempo reale incassi, gift
    card, magazzino e cambi di impostazioni. La mappa che decide chi vede cosa
    sta accanto a chi consegna gli eventi, in apps.core.views: il test guarda
    quella, non una copia, perché una copia diverge in silenzio."""

    def test_an_event_needs_the_scope_of_its_area(self):
        from apps.core.views import allowed_prefixes

        consentiti = allowed_prefixes(False, {"agenda", "clients"})
        self.assertIn("appointment.", consentiti)
        self.assertIn("client.", consentiti)
        self.assertNotIn("sale.", consentiti)
        self.assertNotIn("stock.", consentiti)
        self.assertNotIn("coupon.", consentiti)

    def test_the_owner_sees_everything(self):
        from apps.core.views import LIVE_FEED_PREFIXES, allowed_prefixes

        self.assertEqual(allowed_prefixes(True, set()), LIVE_FEED_PREFIXES)

    def test_an_unmapped_event_reaches_nobody_but_the_owner(self):
        from apps.core.views import allowed_prefixes

        tutti = allowed_prefixes(False, set(SCOPES))
        self.assertNotIn("qualcosa.", tutti)

    def test_a_renamed_label_reaches_marketing_too(self):
        """15-07: le etichette stanno anche nelle condizioni delle automazioni."""
        from apps.core.views import allowed_prefixes

        self.assertIn("client_category.", allowed_prefixes(False, {"marketing"}))

    def test_deposit_rules_reach_only_the_owner(self):
        """Le regole caparra le legge e le scrive solo il titolare."""
        from apps.core.views import LIVE_FEED_PREFIXES, allowed_prefixes

        self.assertIn("deposit_rule.", LIVE_FEED_PREFIXES)
        self.assertNotIn("deposit_rule.", allowed_prefixes(False, set(SCOPES)))

    def test_salon_settings_reach_every_member(self):
        """Orari e regole del salone li legge gia chiunque da /api/core/salon.

        Riservarli al titolare significava che un cambio di orari non
        raggiungeva piu le altre postazioni fino al ricaricamento della pagina.
        """
        from apps.core.views import allowed_prefixes

        self.assertIn("settings.", allowed_prefixes(False, {"agenda"}))
        self.assertIn("settings.", allowed_prefixes(False, set()))
