"""Difese trasversali: file serviti da /media/, IP del client dietro il proxy,
eventi dello stream live filtrati per permesso."""

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from common.permissions import SCOPES


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
        from ..api import _login_account_key

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
