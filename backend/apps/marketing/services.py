"""Modulo di compatibilità: il marketing ora sta nei moduli per argomento.

`codes` (codici al portatore), `coupons`, `gift_cards`, `loyalty`,
`communications`, `consent` e `wallet`. Qui restano importabili, con lo stesso
oggetto, i nomi che questo modulo esponeva: li usano ancora altre app mentre
il refactoring è in corso — la scheda cliente chiama `marketing_consent_changed`
e `drop_from_pending_sends` con `getattr(apps.marketing.services, nome)` a ogni
salvataggio (e i suoi test li patchano qui con `create=True`), i test di
agenda e clients importano `create_gift_card`. Dentro marketing e sales si
importa dai moduli nuovi, e le patch dei test puntano lì.

compat refactoring: rimuovere dopo l'integrazione, quando i chiamanti puntano
ai moduli nuovi.
"""

from .codes import unique_code  # noqa: F401
from .communications import (  # noqa: F401
    CANCEL_EVENT,
    SEND_EVENT,
    cancel_pending_send,
    send_communication,
    settle_due_communications,
)
from .consent import CONSENT_EVENT, drop_from_pending_sends, marketing_consent_changed  # noqa: F401
from .coupons import coupon_discount, mark_coupon_redeemed, validate_coupon  # noqa: F401
from .gift_cards import create_gift_card, redeem_gift_card  # noqa: F401
from .loyalty import MAX_REWARDS_PER_SALE, accrue_loyalty  # noqa: F401
