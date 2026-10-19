"""Inviti al team (19/10): «è confusionario e non arrivano neanche le mail».

Prima l'invito era un codice da copiare a mano: nessuna mail partiva e non
c'era nemmeno una pagina dove usarlo. Ora è un link (/invito/<codice>) che
parte per mail quando il server SMTP è configurato; si accetta con un account
nuovo, con la password di uno già esistente o con la sessione aperta, e può
portare la scheda Staff da collegare a chi entra.
"""

import datetime as dt
from unittest import mock

from django.core import mail
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.core.models import OutboxEvent, Salon
from apps.staff.models import Operator
from common.testing import bearer, post_json

from ..models import Invitation, Membership, Role, User

ORIGIN = "https://beauty.example.it"


@override_settings(FRONTEND_ORIGIN=ORIGIN)
class _InviteSetup(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = User.objects.create_user(
            email="titolare@parlour.it", password="x-Segreta-1", first_name="Sole", last_name="Caputo"
        )
        Membership.objects.create(user=self.owner, salon=self.salon, is_owner=True)
        self.boss = bearer(self.owner, self.salon)
        self.front = Role.objects.create(salon=self.salon, name="Banco", scopes=["agenda", "clients"])
        self.mara = Operator.objects.create(salon=self.salon, first_name="Mara", last_name="Rizzo")

    def _invite(self, email="mara@parlour.it", **extra):
        res = post_json(self.client, "/api/auth/invitations", {"email": email, "role_id": self.front.id, **extra}, **self.boss)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def _accept(self, token, **body):
        return post_json(self.client, "/api/auth/invitations/accept", {"token": str(token), **body})


class InvitationEmailTests(_InviteSetup):
    @override_settings(EMAIL_ENABLED=True)
    def test_the_invitation_leaves_by_email_with_the_link(self):
        out = self._invite()
        self.assertTrue(out["email_sent"])
        self.assertTrue(out["can_email"])
        self.assertEqual(out["link"], f"{ORIGIN}/invito/{out['token']}")
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertEqual(msg.to, ["mara@parlour.it"])
        self.assertIn("The Parlour", msg.subject)
        self.assertIn(out["link"], msg.body)
        self.assertIn("Sole Caputo ti invita", msg.body)
        self.assertIn("«Banco»", msg.body)
        self.assertEqual(msg.reply_to, ["titolare@parlour.it"])
        self.assertIsNotNone(Invitation.objects.get(id=out["id"]).sent_at)

    def test_without_an_smtp_server_the_link_is_handed_to_the_owner(self):
        out = self._invite()
        self.assertFalse(out["email_sent"])
        self.assertFalse(out["can_email"])
        self.assertEqual(len(mail.outbox), 0)
        self.assertTrue(out["link"].startswith(f"{ORIGIN}/invito/"))
        # chi consegna gli eventi sa che la mail non è partita, e ha il link
        event = OutboxEvent.objects.get(event_type="team.invitation")
        self.assertEqual((event.payload["email_sent"], event.payload["accept_url"]), (False, out["link"]))

    @override_settings(EMAIL_ENABLED=True)
    def test_a_server_error_does_not_stop_the_invitation(self):
        with mock.patch("apps.accounts.invitations.EmailMultiAlternatives.send", side_effect=OSError("connessione rifiutata")) as send:
            out = self._invite()
        send.assert_called_once()
        self.assertFalse(out["email_sent"])
        self.assertIn("connessione rifiutata", out["send_error"])
        self.assertEqual(Invitation.objects.get(id=out["id"]).status, Invitation.Status.PENDING)

    @override_settings(
        EMAIL_ENABLED=True, EMAIL_BACKEND="common.mailgun.MailgunBackend",
        MAILGUN_API_KEY="key-sbagliata", MAILGUN_DOMAIN="mg.example.it", MAILGUN_REGION="eu",
    )
    def test_with_mailgun_a_refusal_ends_up_on_the_invitation(self):
        import httpx

        from common.mailgun import MailgunBackend

        def refuse(request):
            return httpx.Response(401, text="Forbidden")

        client = httpx.Client(transport=httpx.MockTransport(refuse))
        with mock.patch.object(MailgunBackend, "_client", return_value=client) as made:
            out = self._invite()
        made.assert_called_once()
        self.assertFalse(out["email_sent"])
        self.assertIn("Mailgun 401", out["send_error"])
        self.assertIn("MAILGUN_API_KEY", out["send_error"])

    def test_inviting_again_replaces_the_open_invitation(self):
        first = self._invite()
        second = self._invite("MARA@parlour.it")
        self.assertEqual(Invitation.objects.get(id=first["id"]).status, Invitation.Status.REVOKED)
        res = self._accept(first["token"], password="Cartellina-2026", first_name="Mara")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self._accept(second["token"], password="Cartellina-2026", first_name="Mara").status_code, 200)

    @override_settings(EMAIL_ENABLED=True)
    def test_resend_renews_an_expired_invitation_and_revoke_closes_it(self):
        out = self._invite()
        Invitation.objects.filter(id=out["id"]).update(expires_at=timezone.now() - dt.timedelta(days=1), status=Invitation.Status.EXPIRED)
        res = self.client.post(f"/api/auth/invitations/{out['id']}/resend", **self.boss)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["email_sent"])
        self.assertEqual(len(mail.outbox), 2)
        invitation = Invitation.objects.get(id=out["id"])
        self.assertEqual(invitation.status, Invitation.Status.PENDING)
        self.assertGreater(invitation.expires_at, timezone.now() + dt.timedelta(days=6))
        self.assertEqual(self.client.delete(f"/api/auth/invitations/{out['id']}", **self.boss).status_code, 200)
        self.assertEqual(Invitation.objects.get(id=out["id"]).status, Invitation.Status.REVOKED)
        self.assertEqual(self._accept(out["token"], password="Cartellina-2026", first_name="Mara").status_code, 400)
        # annullato non si rimanda: se ne crea uno nuovo
        self.assertEqual(self.client.post(f"/api/auth/invitations/{out['id']}/resend", **self.boss).status_code, 400)

    def test_who_cannot_grant_the_role_cannot_resend_or_revoke(self):
        hr_role = Role.objects.create(salon=self.salon, name="Personale", scopes=["team"])
        hr_user = User.objects.create_user(email="hr@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=hr_user, salon=self.salon, role=hr_role)
        hr = bearer(hr_user, self.salon)
        out = self._invite()
        self.assertEqual(self.client.post(f"/api/auth/invitations/{out['id']}/resend", **hr).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/auth/invitations/{out['id']}", **hr).status_code, 403)


class InvitationPreviewTests(_InviteSetup):
    def _preview(self, token):
        return self.client.get("/api/auth/invitations/preview", {"token": str(token)})

    def test_the_page_says_where_and_as_what(self):
        out = self._invite()
        res = self._preview(out["token"])
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(
            (body["salon_name"], body["role_name"], body["email"], body["invited_by"], body["status"], body["has_account"]),
            ("The Parlour", "Banco", "mara@parlour.it", "Sole Caputo", "pending", False),
        )
        Invitation.objects.filter(id=out["id"]).update(expires_at=timezone.now() - dt.timedelta(minutes=1))
        self.assertEqual(self._preview(out["token"]).json()["status"], "expired")
        self.assertEqual(self._preview("non-un-codice").status_code, 404)

    def test_an_existing_account_is_announced_with_or_without_password(self):
        User.objects.create_user(email="mara@parlour.it", password="Sua-Password-9")
        out = self._invite()
        body = self._preview(out["token"]).json()
        self.assertEqual((body["has_account"], body["has_password"]), (True, True))
        User.objects.filter(email="mara@parlour.it").update(password="!")   # entra solo con Yourang
        self.assertEqual(self._preview(out["token"]).json()["has_password"], False)


class InvitationAcceptTests(_InviteSetup):
    def test_a_new_account_enters_and_lands_on_her_staff_card(self):
        out = self._invite(operator_id=self.mara.id)
        self.assertEqual(out["operator"], {"id": self.mara.id, "name": "Mara Rizzo"})
        res = self._accept(out["token"], password="Cartellina-2026", first_name="Mara", last_name="Rizzo")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["salon"]["slug"], "the-parlour")
        user = User.objects.get(email="mara@parlour.it")
        self.assertEqual(Membership.objects.get(user=user, salon=self.salon).role, self.front)
        self.mara.refresh_from_db()
        self.assertEqual(self.mara.user, user)
        # e nell'elenco del team la si vede collegata
        members = {m["user"]["email"]: m for m in self.client.get("/api/auth/members", **self.boss).json()}
        self.assertEqual(members["mara@parlour.it"]["operator"], {"id": self.mara.id, "name": "Mara Rizzo"})
        self.assertIsNone(members["titolare@parlour.it"]["operator"])

    def test_a_new_account_needs_a_name_and_a_real_password(self):
        out = self._invite()
        self.assertEqual(self._accept(out["token"], password="Cartellina-2026").status_code, 400)
        self.assertEqual(self._accept(out["token"], password="123", first_name="Mara").status_code, 400)
        self.assertFalse(User.objects.filter(email="mara@parlour.it").exists())

    def test_an_existing_account_enters_with_its_own_password(self):
        """Prima: «Esiste già un utente con questa email», e chi lavora in due
        saloni non poteva entrare nel secondo."""
        other = Salon.objects.create(name="Altro", slug="altro")
        mara = User.objects.create_user(email="mara@parlour.it", password="Sua-Password-9", first_name="Mara")
        Membership.objects.create(user=mara, salon=other, is_owner=True)
        out = self._invite()
        wrong = self._accept(out["token"], password="sbagliata-123")
        self.assertEqual(wrong.status_code, 400)
        self.assertIn("Password non corretta", wrong.json()["detail"])
        res = self._accept(out["token"], password="Sua-Password-9")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["salon"]["slug"], "the-parlour")
        self.assertEqual(Membership.objects.get(user=mara, salon=self.salon).role, self.front)
        mara.refresh_from_db()
        self.assertEqual(mara.first_name, "Mara", "l'account resta com'era")

    def test_who_enters_with_yourang_accepts_with_the_open_session(self):
        other = Salon.objects.create(name="Altro", slug="altro")
        mara = User.objects.create_user(email="mara@parlour.it", password=None)
        Membership.objects.create(user=mara, salon=other, is_owner=True)
        out = self._invite(operator_id=self.mara.id)
        no_password = self._accept(out["token"], password="qualcosa-123")
        self.assertIn("Yourang", no_password.json()["detail"])
        session = bearer(mara, other)
        res = post_json(self.client, "/api/auth/invitations/accept-session", {"token": out["token"]}, **session)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["salon"]["slug"], "the-parlour")
        self.mara.refresh_from_db()
        self.assertEqual(self.mara.user, mara)

    def test_the_session_of_someone_else_does_not_open_the_invitation(self):
        out = self._invite()
        res = post_json(self.client, "/api/auth/invitations/accept-session", {"token": out["token"]}, **self.boss)
        self.assertEqual(res.status_code, 403)
        self.assertFalse(Membership.objects.filter(salon=self.salon, user__email="mara@parlour.it").exists())

    def test_a_staff_card_already_linked_is_not_offered_twice(self):
        someone = User.objects.create_user(email="x@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=someone, salon=self.salon, role=self.front)
        Operator.objects.filter(id=self.mara.id).update(user=someone)
        res = post_json(self.client, "/api/auth/invitations", {"email": "mara@parlour.it", "role_id": self.front.id, "operator_id": self.mara.id}, **self.boss)
        self.assertEqual(res.status_code, 400)
        self.assertIn("ha già un accesso", res.json()["detail"])

    def test_removing_a_member_frees_her_staff_card(self):
        out = self._invite(operator_id=self.mara.id)
        self._accept(out["token"], password="Cartellina-2026", first_name="Mara")
        membership = Membership.objects.get(salon=self.salon, user__email="mara@parlour.it")
        self.assertEqual(self.client.delete(f"/api/auth/members/{membership.id}", **self.boss).status_code, 200)
        self.mara.refresh_from_db()
        self.assertIsNone(self.mara.user)
