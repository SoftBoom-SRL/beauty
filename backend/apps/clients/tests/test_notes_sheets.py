"""Note (anche con allegati) e schede tecniche della cliente.

Le schede tecniche sono immutabili dopo la creazione (nessuna rotta di
update/delete registrata sul router); allegati e foto si scaricano solo con
l'URL firmato.
"""

import json
import shutil
import tempfile

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Salon
from common.auth import create_staff_tokens

from ..api import create_note, create_sheet, delete_note, list_notes, list_sheets, router
from ..models import Client, ClientNote, ClientNoteAttachment, TechnicalSheet
from ..schemas import NoteIn, TechnicalSheetIn
from .base import ClientsTestCase, _staff_http


class NotesTests(ClientsTestCase):
    def test_create_and_delete_note(self):
        client = self.make_client()
        note = create_note(self.request, client.id, NoteIn(text="Allergica al lattice"))
        self.assertEqual(len(list_notes(self.request, client.id)), 1)
        delete_note(self.request, client.id, note["id"])
        self.assertFalse(ClientNote.objects.filter(id=note["id"]).exists())


class TechnicalSheetTests(ClientsTestCase):
    def test_create_sheet(self):
        client = self.make_client()
        sheet = create_sheet(
            self.request,
            client.id,
            TechnicalSheetIn(category="hair", treatment="Colore"),
        )
        self.assertEqual(TechnicalSheet.objects.filter(client=client).count(), 1)
        self.assertEqual(list(list_sheets(self.request, client.id)), [sheet])

    def _operator(self, salon=None):
        from apps.staff.models import Operator

        return Operator.objects.create(
            salon=salon or self.salon, first_name="Giulia", last_name="Bianchi"
        )

    def test_sheet_linked_to_an_appointment_of_this_client(self):
        from apps.agenda.models import Appointment

        client = self.make_client()
        appointment = Appointment.objects.create(
            salon=self.salon, client=client, operator=self._operator(), start=timezone.now()
        )
        sheet = create_sheet(
            self.request,
            client.id,
            TechnicalSheetIn(category="hair", treatment="Colore", appointment_id=appointment.id),
        )
        # La view restituisce il dizionario di _sheet_out (foto con URL firmato, 06-03).
        self.assertEqual(sheet["appointment_id"], appointment.id)

    def test_an_appointment_of_someone_else_is_refused(self):
        """Prima l'id finiva dritto nella create: quello di un altro salone
        veniva salvato e la scheda spariva dallo storico (che la cerca fra gli
        appuntamenti di questa cliente), quello inesistente usciva come 500."""
        from apps.agenda.models import Appointment

        client = self.make_client()
        other_salon = Salon.objects.create(name="Altro", slug="altro")
        stranger = Client.objects.create(
            salon=other_salon, first_name="Estranea", phone="+390001112222"
        )
        foreign = Appointment.objects.create(
            salon=other_salon,
            client=stranger,
            operator=self._operator(other_salon),
            start=timezone.now(),
        )
        other_client = self.make_client(phone="+393338889999", first_name="Altra")
        mine_but_hers = Appointment.objects.create(
            salon=self.salon, client=other_client, operator=self._operator(), start=timezone.now()
        )
        for appointment_id in (foreign.id, mine_but_hers.id, 999999):
            with self.assertRaises(HttpError) as caught:
                create_sheet(
                    self.request,
                    client.id,
                    TechnicalSheetIn(
                        category="hair", treatment="Colore", appointment_id=appointment_id
                    ),
                )
            self.assertEqual(caught.exception.status_code, 404, appointment_id)
        self.assertEqual(TechnicalSheet.objects.count(), 0)

    def test_no_update_or_delete_routes_for_sheets(self):
        """Verifica di contratto: le schede tecniche sono sola lettura dopo la
        creazione, quindi il router non deve esporre PUT/PATCH/DELETE su di esse."""
        methods: set[str] = set()
        for path, path_view in router.path_operations.items():
            if "sheets" in path:
                for operation in path_view.operations:
                    methods.update(operation.methods)
        self.assertIn("GET", methods)
        self.assertIn("POST", methods)
        self.assertNotIn("PUT", methods)
        self.assertNotIn("PATCH", methods)
        self.assertNotIn("DELETE", methods)

    def test_no_update_or_delete_view_functions_exported(self):
        import apps.clients.api as api_module

        self.assertFalse(hasattr(api_module, "update_sheet"))
        self.assertFalse(hasattr(api_module, "delete_sheet"))


@override_settings(MEDIA_ROOT=tempfile.mkdtemp(prefix="youty-test-media-"))
class NoteAttachmentsApiTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients"])
        self.client_obj = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+391112223333")

    def tearDown(self):
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)

    def test_upload_note_with_files_then_remove_attachment(self):
        png = SimpleUploadedFile("prima.png", b"\x89PNG\r\n\x1a\n" + b"0" * 64, content_type="image/png")
        pdf = SimpleUploadedFile("consenso.pdf", b"%PDF-1.4 test", content_type="application/pdf")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "Prima seduta", "visibility": "private", "files": [png, pdf]},
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        note = res.json()
        self.assertEqual(note["text"], "Prima seduta")
        self.assertEqual(len(note["attachments"]), 2)
        self.assertTrue(note["attachments"][0]["is_image"])
        self.assertFalse(note["attachments"][1]["is_image"])
        self.assertTrue(note["attachments"][0]["url"].startswith("/media/"))

        att_id = note["attachments"][0]["id"]
        res = self.client.delete(f"/api/clients/{self.client_obj.id}/notes/{note['id']}/attachments/{att_id}", **self.auth)
        self.assertEqual(res.status_code, 200)
        notes = self.client.get(f"/api/clients/{self.client_obj.id}/notes", **self.auth).json()
        self.assertEqual(len(notes[0]["attachments"]), 1)

    def test_private_attachment_requires_signed_url(self):
        content = b"\x89PNG\r\n\x1a\n" + b"7" * 64
        png = SimpleUploadedFile("riservata.png", content, content_type="image/png")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "Riservata", "visibility": "private", "files": [png]},
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        url = res.json()["attachments"][0]["url"]
        path, _, query = url.partition("?")
        self.assertTrue(path.startswith("/media/client_notes/"))
        self.assertTrue(query.startswith("t="))
        # chi conosce solo il percorso non scarica nulla
        self.assertEqual(self.client.get(path).status_code, 403)
        # token manomesso: negato
        self.assertEqual(self.client.get(f"{path}?t={query[2:-3]}xyz").status_code, 403)
        # URL firmato restituito dall'API: il file
        res = self.client.get(url)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(b"".join(res.streaming_content), content)

    def test_private_attachment_cannot_be_reached_with_a_disguised_path(self):
        """Il controllo della firma non si aggira riscrivendo il percorso.

        `django.views.static.serve` normalizza il percorso dopo di noi: senza
        normalizzare prima, `/media/./client_notes/…` e `/media/x/../client_notes/…`
        (anche codificati) scaricavano il file senza token.
        """
        content = b"\x89PNG\r\n\x1a\n" + b"9" * 64
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "Riservata", "visibility": "private",
                  "files": [SimpleUploadedFile("nascosta.png", content, content_type="image/png")]},
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        path = res.json()["attachments"][0]["url"].split("?")[0]   # /media/client_notes/…
        rel = path[len("/media/"):]
        for disguised in (
            f"/media/./{rel}",
            f"/media/pub/../{rel}",
            f"/media/a/%2e%2e/{rel}",
            f"/media/%2e/{rel}",
            f"/media/client_notes/../{rel}",
        ):
            self.assertEqual(self.client.get(disguised).status_code, 403, disguised)

    def test_unsupported_type_rejected(self):
        zipf = SimpleUploadedFile("x.zip", b"PK\x03\x04", content_type="application/zip")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "x", "files": [zipf]}, **self.auth,
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(ClientNote.objects.count(), 0)

    def test_an_extension_that_lies_about_the_type_is_refused(self):
        """Il Content-Type lo dichiara il client. Quello che conta è come il
        file finisce su disco: un .html servito da /media/ girerebbe sullo
        stesso origin di /admin/."""
        evil = SimpleUploadedFile(
            "foto.png.html", b"<script>alert(1)</script>", content_type="image/png"
        )
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "x", "files": [evil]}, **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(ClientNote.objects.count(), 0)
        self.assertEqual(ClientNoteAttachment.objects.count(), 0)

    def test_the_stored_name_is_the_servers_and_the_original_stays_on_the_card(self):
        png = SimpleUploadedFile("prima seduta.png", b"\x89PNG\r\n\x1a\n" + b"0" * 8, content_type="image/png")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "x", "files": [png]}, **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        attachment = ClientNoteAttachment.objects.get()
        # sulla scheda resta il nome che l'operatrice riconosce…
        self.assertEqual(attachment.name, "prima seduta.png")
        # …su disco no: nome generato dal server, estensione coerente col tipo
        stored = attachment.file.name.rsplit("/", 1)[-1]
        self.assertNotIn("prima seduta", stored)
        self.assertTrue(stored.endswith(".png"), stored)

    def test_a_rejected_file_leaves_no_half_saved_attachment(self):
        good = SimpleUploadedFile("buona.png", b"\x89PNG\r\n\x1a\n", content_type="image/png")
        bad = SimpleUploadedFile("x.zip", b"PK\x03\x04", content_type="application/zip")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "x", "files": [good, bad]}, **self.auth,
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(ClientNoteAttachment.objects.count(), 0)

    def test_note_can_be_edited(self):
        note = ClientNote.objects.create(client=self.client_obj, text="vecchio")
        res = self.client.put(
            f"/api/clients/{self.client_obj.id}/notes/{note.id}",
            data=json.dumps({"text": "nuovo", "visibility": "ai"}), content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["text"], "nuovo")
        self.assertEqual(res.json()["visibility"], "ai")


# ---------------------------------------------------------------------------
# Caccia 22/09 — foto delle schede tecniche (06-03).
#
# technical_sheets/ si scarica solo con l'URL firmato, ma lista, creazione e
# caricamento della foto restituivano il `.url` nudo del FileField: nella scheda
# tecnica e nella modale le foto erano sempre rotte (403), anche subito dopo il
# caricamento. Solo lo storico, che firmava, le mostrava.
# ---------------------------------------------------------------------------


@override_settings(MEDIA_ROOT=tempfile.mkdtemp(prefix="caccia22-schede-"))
class SheetPhotoUrlTests(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="operatrice@theparlour.it", password="x" * 10)
        user.first_name, user.last_name = "Giulia", "Bianchi"
        user.save()
        role = Role.objects.create(salon=self.salon, name="Operatrice", scopes=["agenda", "clients"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=False)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.card = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+393331110000")

    def tearDown(self):
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)

    def test_the_photo_url_opens_wherever_it_comes_from(self):
        created = self.client.post(
            f"/api/clients/{self.card.id}/sheets",
            data={"category": "hair", "treatment": "Colore"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(created.status_code, 200, created.content)
        self.assertEqual(created.json()["author_name"], "Giulia Bianchi")
        sheet_id = created.json()["id"]
        png = SimpleUploadedFile("dopo.png", b"\x89PNG\r\n\x1a\n" + b"1" * 64, content_type="image/png")
        uploaded = self.client.post(
            f"/api/clients/{self.card.id}/sheets/{sheet_id}/photo", data={"photo": png}, **self.auth
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.content)
        listed = self.client.get(f"/api/clients/{self.card.id}/sheets", **self.auth).json()
        self.assertEqual(listed[0]["author_name"], "Giulia Bianchi")
        for url in (uploaded.json()["photo"], listed[0]["photo"]):
            with self.subTest(url=url):
                self.assertIn("?t=", url)
                self.assertEqual(self.client.get(url).status_code, 200)
        # Senza firma resta privata.
        self.assertEqual(self.client.get(listed[0]["photo"].split("?")[0]).status_code, 403)
