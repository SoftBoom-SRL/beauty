"""Il client dell'external API di Yourang (client.py) con httpx finto, senza _request mockato."""

from datetime import timedelta
from unittest.mock import Mock, patch

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.integrations import crypto

from .base import TEST_KEY


@override_settings(YOURANG_ISSUER_URL="https://api.example", ENCRYPTION_KEY=TEST_KEY)
class ClientRequestTests(TestCase):
    """_request è mockato in tutti gli altri test: qui gira per davvero (con
    httpx finto) perché URL e header di autorizzazione non sono mai stati
    verificati da nessuno."""

    def setUp(self):
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        self.salon = Salon.objects.create(name="Salone HTTP", slug="salone-http")
        self.conn = YourangConnection.objects.create(
            salon=self.salon,
            yourang_org_id="org-http",
            access_token_enc=crypto.encrypt("tok-abc"),
            refresh_token_enc=crypto.encrypt("ref-abc"),
            expires_at=timezone.now() + timedelta(hours=1),
        )

    def _response(self, data):
        resp = Mock()
        resp.json.return_value = {"ok": True, "data": data}
        return resp

    def test_url_and_headers(self):
        from apps.integrations.client import YourangClient

        with patch("apps.integrations.client.httpx.request",
                   return_value=self._response([{"id": "c-1"}])) as req:
            out = YourangClient(self.conn).list_contacts(limit=50, offset=100)

        method, url = req.call_args.args
        self.assertEqual(method, "GET")
        self.assertEqual(
            url, "https://api.example/api/external/v1/contacts?limit=50&offset=100"
        )
        headers = req.call_args.kwargs["headers"]
        self.assertEqual(headers["Authorization"], "Bearer tok-abc")
        # Il flusso diretto parla per UN salone col token di quel salone: nessun
        # selettore di organizzazione da mandare (era un header del proxy).
        self.assertNotIn("X-Yourang-Org", headers)
        self.assertEqual(out, [{"id": "c-1"}])

    def test_remote_ids_are_percent_encoded(self):
        """httpx normalizza i dot-segment: un id ostile cambierebbe rotta alla
        chiamata (.../events/1/../../contacts diventa .../contacts)."""
        from apps.integrations.client import YourangClient

        with patch("apps.integrations.client.httpx.request",
                   return_value=self._response({})) as req:
            YourangClient(self.conn).get_event("1/../../contacts")
        self.assertEqual(
            req.call_args.args[1],
            "https://api.example/api/external/v1/events/1%2F..%2F..%2Fcontacts",
        )

        with patch("apps.integrations.client.httpx.request",
                   return_value=self._response({})) as req:
            YourangClient(self.conn).upsert_catalogue_item("a/../b", {"name": "x"})
        self.assertEqual(
            req.call_args.args[1],
            "https://api.example/api/external/v1/catalogues/items/a%2F..%2Fb",
        )

    def test_connection_without_tokens_never_calls_the_api(self):
        """Senza refresh token non c'è modo di autenticarsi: deve alzare prima
        di uscire in rete, non mandare una richiesta senza credenziali."""
        from apps.core.models import Salon
        from apps.integrations.client import YourangClient
        from apps.integrations.models import YourangConnection

        orphan = YourangConnection.objects.create(
            salon=Salon.objects.create(name="Orfano", slug="orfano"), yourang_org_id=""
        )
        with patch("apps.integrations.client.httpx.request") as req:
            with self.assertRaises(RuntimeError):
                YourangClient(orphan).list_contacts()
        req.assert_not_called()
