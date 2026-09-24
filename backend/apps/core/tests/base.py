"""Aiuti condivisi dai moduli di test del core."""

from common.auth import create_staff_tokens


def _owner(salon, email="own@x.it"):
    from apps.accounts.models import Membership, User

    user = User.objects.create_user(email=email, password="pw-lunga-123")
    Membership.objects.create(user=user, salon=salon, is_owner=True)
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}
