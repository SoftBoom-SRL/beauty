"""Backend email di Django che spedisce con l'API HTTP di Mailgun.

Il salone usa Mailgun (il titolare, 19/10). Con l'API bastano la chiave e il
dominio (MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_REGION): niente porte SMTP
da aprire sul server, e quando qualcosa non va la risposta di Mailgun dice il
perché («Domain not found», «Forbidden»), che finisce nell'invito
(`send_error`) invece di un timeout di connessione. La regione conta: un
dominio creato nella regione EU risponde solo su api.eu.mailgun.net.

Si sceglie in settings (EMAIL_BACKEND) quando chiave e dominio ci sono; chi
manda mail usa le solite funzioni di Django (EmailMultiAlternatives).
"""

import httpx
from django.conf import settings
from django.core.mail.backends.base import BaseEmailBackend

API_HOSTS = {"eu": "https://api.eu.mailgun.net", "us": "https://api.mailgun.net"}


class MailgunError(Exception):
    """Mailgun ha rifiutato il messaggio (il testo dice perché)."""


def _reason(response: httpx.Response) -> str:
    try:
        detail = response.json().get("message") or ""
    except ValueError:
        detail = response.text[:200]
    hint = ""
    if response.status_code in (401, 403, 404):
        # chiave sbagliata, dominio di un'altra regione o non verificato
        hint = " (controlla MAILGUN_API_KEY, MAILGUN_DOMAIN e MAILGUN_REGION eu/us)"
    return f"Mailgun {response.status_code}: {detail}{hint}".strip()


class MailgunBackend(BaseEmailBackend):
    def _client(self) -> httpx.Client:
        return httpx.Client(timeout=settings.EMAIL_TIMEOUT, auth=("api", settings.MAILGUN_API_KEY))

    def _url(self) -> str:
        host = API_HOSTS.get(settings.MAILGUN_REGION, API_HOSTS["us"])
        return f"{host}/v3/{settings.MAILGUN_DOMAIN}/messages"

    def send_messages(self, email_messages) -> int:
        if not email_messages:
            return 0
        sent = 0
        with self._client() as client:
            for message in email_messages:
                try:
                    self._send(client, message)
                except Exception:
                    if not self.fail_silently:
                        raise
                    continue
                sent += 1
        return sent

    def _send(self, client: httpx.Client, message) -> None:
        data = {
            "from": message.from_email or settings.DEFAULT_FROM_EMAIL,
            "to": list(message.to),
            "subject": message.subject,
            "text": message.body,
        }
        if message.cc:
            data["cc"] = list(message.cc)
        if message.bcc:
            data["bcc"] = list(message.bcc)
        if message.reply_to:
            data["h:Reply-To"] = ", ".join(message.reply_to)
        for content, mimetype in getattr(message, "alternatives", None) or []:
            if mimetype == "text/html":
                data["html"] = content
        response = client.post(self._url(), data=data)
        if response.status_code >= 400:
            raise MailgunError(_reason(response))
