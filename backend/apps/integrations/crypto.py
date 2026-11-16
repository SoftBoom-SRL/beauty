"""Verifica della firma HMAC dei webhook (ri-firmati dal proxy connect.yourang.ai).

La cifratura dei token a riposo (AES-256-GCM, ENCRYPTION_KEY) non serve più: i
token li custodisce il proxy (YR-502).
"""

import hashlib
import hmac
import time


# Firma webhook: HMAC-SHA256 su `{timestamp}.{body}`, header
# `x-yourang-signature: sha256=<hex>` + `x-yourang-timestamp`, freschezza ±5 min.
# Identico a food/real_estate.
FRESHNESS_SECONDS = 5 * 60


def verify_signature(body: bytes, signature: str, timestamp: str, secret: str) -> bool:
    if not (signature and timestamp and secret):
        return False
    # compare_digest alza TypeError se una delle due stringhe non è ASCII: un
    # header con un byte >= 0x80 diventa un 500 su una rotta pubblica, e un 500
    # ripetibile è già di per sé una leva. Firma non ASCII = firma sbagliata.
    # Fix portato avanti da 9991cb5, che lo aveva corretto sulla verifica proxy.
    if not signature.isascii():
        return False
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - ts) > FRESHNESS_SECONDS:
        return False
    signed = f"{timestamp}.".encode() + body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    provided = signature.removeprefix("sha256=")
    return hmac.compare_digest(expected, provided)
