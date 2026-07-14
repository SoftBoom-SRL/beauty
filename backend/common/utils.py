"""Utility condivise."""

import secrets
import string

from django.shortcuts import get_object_or_404


def salon_get(model, ctx, pk, **extra):
    """get_object_or_404 con scoping tenant obbligatorio sul salone del contesto."""
    return get_object_or_404(model, pk=pk, salon=ctx.salon, **extra)


_CODE_ALPHABET = string.ascii_uppercase + string.digits
_CODE_ALPHABET = _CODE_ALPHABET.translate(str.maketrans("", "", "O0I1"))  # niente ambigui


def human_code(length: int = 8) -> str:
    """Codice leggibile per coupon/gift card (senza caratteri ambigui)."""
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(length))
