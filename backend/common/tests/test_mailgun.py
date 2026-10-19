"""Le mail con l'API di Mailgun (19/10: il salone usa Mailgun): che cosa
arriva a Mailgun, e che cosa succede quando lo rifiuta."""

from unittest import mock

import httpx
from django.core.mail import EmailMultiAlternatives, get_connection
from django.test import SimpleTestCase, override_settings

from common.mailgun import MailgunBackend, MailgunError

MAILGUN = {
    "EMAIL_BACKEND": "common.mailgun.MailgunBackend", "MAILGUN_API_KEY": "key-123",
    "MAILGUN_DOMAIN": "mg.example.it", "MAILGUN_REGION": "eu", "DEFAULT_FROM_EMAIL": "youty <no-reply@mg.example.it>",
}


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), auth=("api", "key-123"))


@override_settings(**MAILGUN)
class MailgunBackendTests(SimpleTestCase):
    def _message(self):
        msg = EmailMultiAlternatives("Entra nel team", "testo", to=["mara@x.it"], reply_to=["sole@x.it"])
        msg.attach_alternative("<p>html</p>", "text/html")
        return msg

    def test_the_message_reaches_the_eu_api_with_text_html_and_reply_to(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json={"id": "<1@mg>", "message": "Queued. Thank you."})

        with mock.patch.object(MailgunBackend, "_client", return_value=_client(handler)) as client:
            self.assertEqual(get_connection().send_messages([self._message()]), 1)
        client.assert_called_once()
        request = seen[0]
        self.assertEqual(str(request.url), "https://api.eu.mailgun.net/v3/mg.example.it/messages")
        self.assertTrue(request.headers["authorization"].startswith("Basic "))
        form = dict(httpx.QueryParams(request.content.decode()))
        self.assertEqual(
            (form["from"], form["to"], form["subject"], form["text"], form["html"], form["h:Reply-To"]),
            ("youty <no-reply@mg.example.it>", "mara@x.it", "Entra nel team", "testo", "<p>html</p>", "sole@x.it"),
        )

    @override_settings(MAILGUN_REGION="us")
    def test_the_us_region_has_its_own_address(self):
        self.assertEqual(MailgunBackend()._url(), "https://api.mailgun.net/v3/mg.example.it/messages")

    def test_a_refusal_says_why_and_where_to_look(self):
        handler = lambda request: httpx.Response(404, json={"message": "Domain not found: mg.example.it"})  # noqa: E731
        with mock.patch.object(MailgunBackend, "_client", return_value=_client(handler)):
            with self.assertRaises(MailgunError) as err:
                get_connection().send_messages([self._message()])
        self.assertIn("Mailgun 404: Domain not found", str(err.exception))
        self.assertIn("MAILGUN_REGION", str(err.exception))
        # in silenzio, se chi manda lo chiede: nessuna mail contata
        with mock.patch.object(MailgunBackend, "_client", return_value=_client(handler)):
            self.assertEqual(get_connection(fail_silently=True).send_messages([self._message()]), 0)
