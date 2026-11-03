"""Il client verso il proxy Yourang (client.py) con httpx finto, senza _request mockato."""

from unittest.mock import Mock, patch

from django.test import TestCase, override_settings

from .base import API_SETTINGS, PROXY_API_KEY


@override_settings(**API_SETTINGS)
class ClientRequestTests(TestCase):
    """_request è mockato in tutti gli altri test: qui gira per davvero (con
    httpx finto), perché URL e header verso il proxy li verifica solo questo."""

    def setUp(self):
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        self.salon = Salon.objects.create(name="Salone HTTP", slug="salone-http")
        self.conn = YourangConnection.objects.create(salon=self.salon, yourang_org_id="org-http")

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
            url, "https://connect.yourang.invalid/v/beauty/api/contacts?limit=50&offset=100"
        )
        headers = req.call_args.kwargs["headers"]
        # L'API key del portale, mai un token Yourang; l'org come selettore del grant.
        self.assertEqual(headers["Authorization"], f"Bearer {PROXY_API_KEY}")
        self.assertEqual(headers["X-Yourang-Org"], "org-http")
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
            "https://connect.yourang.invalid/v/beauty/api/events/1%2F..%2F..%2Fcontacts",
        )

        with patch("apps.integrations.client.httpx.request",
                   return_value=self._response({})) as req:
            YourangClient(self.conn).upsert_catalogue_item("a/../b", {"name": "x"})
        self.assertEqual(
            req.call_args.args[1],
            "https://connect.yourang.invalid/v/beauty/api/catalogues/items/a%2F..%2Fb",
        )

    def test_connection_without_org_never_calls_the_api(self):
        """Senza org il proxy non saprebbe quale grant usare: deve alzare prima
        di uscire in rete."""
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

    def test_redeeming_a_link_code_sends_the_api_key(self):
        from apps.integrations.client import proxy_login_url, redeem_link_code

        resp = Mock()
        resp.json.return_value = {"org_id": "org-1", "email": "a@b.it"}
        with patch("apps.integrations.client.httpx.post", return_value=resp) as post:
            self.assertEqual(redeem_link_code("yl-1")["org_id"], "org-1")
        self.assertEqual(post.call_args.args[0], "https://connect.yourang.invalid/v/beauty/auth/link")
        self.assertEqual(post.call_args.kwargs["json"], {"code": "yl-1"})
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], f"Bearer {PROXY_API_KEY}")
        self.assertEqual(
            proxy_login_url("https://beauty.example/oauth-popup/done?state=s"),
            "https://connect.yourang.invalid/v/beauty/auth/login"
            "?return_to=https%3A%2F%2Fbeauty.example%2Foauth-popup%2Fdone%3Fstate%3Ds",
        )
