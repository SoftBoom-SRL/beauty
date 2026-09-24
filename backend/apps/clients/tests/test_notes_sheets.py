"""Caccia 22/09 — foto delle schede tecniche (06-03).

technical_sheets/ si scarica solo con l'URL firmato, ma lista, creazione e
caricamento della foto restituivano il `.url` nudo del FileField: nella scheda
tecnica e nella modale le foto erano sempre rotte (403), anche subito dopo il
caricamento. Solo lo storico, che firmava, le mostrava.
"""

import shutil
import tempfile

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from apps.core.models import Salon
from common.auth import create_staff_tokens

from ..models import Client


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
