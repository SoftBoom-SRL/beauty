"""Aiuti condivisi dai moduli di test del core."""

from common.testing import bearer


def _owner(salon, email="own@x.it"):
    from apps.accounts.models import Membership, User

    user = User.objects.create_user(email=email, password="pw-lunga-123")
    Membership.objects.create(user=user, salon=salon, is_owner=True)
    return bearer(user, salon)
