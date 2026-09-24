"""`OkOut` condiviso (common/schemas.py) contro le undici copie nelle app."""

import importlib

from django.test import SimpleTestCase

from common.schemas import OkOut

# Le app che al commit 4ecefc8 definivano ciascuna il proprio `OkOut`.
APPS_WITH_A_COPY = (
    "accounts", "agenda", "automations", "catalog", "clients", "core",
    "integrations", "inventory", "marketing", "sales", "staff",
)

# Lo schema JSON che generavano tutte e undici: è quello che finisce nel
# contratto OpenAPI (senza `description`: la classe non ha docstring).
COPIED_SCHEMA = {
    "properties": {"ok": {"default": True, "title": "Ok", "type": "boolean"}},
    "title": "OkOut",
    "type": "object",
}


class OkOutTests(SimpleTestCase):
    def test_default_body_is_ok_true(self):
        self.assertEqual(OkOut().dict(), {"ok": True})

    def test_ok_can_still_be_set(self):
        self.assertEqual(OkOut(ok=False).dict(), {"ok": False})

    def test_json_schema_is_the_one_of_the_copies(self):
        self.assertEqual(OkOut.model_json_schema(), COPIED_SCHEMA)

    def test_same_schema_and_config_as_every_copy_still_in_place(self):
        # Finché una copia resta in un'app, deve essere identica a questa: se
        # qualcuno ne cambia una, adottare la versione comune cambierebbe il
        # contratto di quell'app. Le copie già tolte non si controllano più.
        for app in APPS_WITH_A_COPY:
            try:
                module = importlib.import_module(f"apps.{app}.schemas")
            except ModuleNotFoundError:
                continue
            copy = getattr(module, "OkOut", None)
            if copy is None or copy is OkOut:
                continue
            with self.subTest(app=app):
                self.assertEqual(copy.model_json_schema(), OkOut.model_json_schema())
                self.assertEqual(copy.model_config, OkOut.model_config)
                self.assertEqual(copy().dict(), OkOut().dict())
