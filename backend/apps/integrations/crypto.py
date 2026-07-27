"""Cifratura token a riposo (AES-256-GCM) + verifica firma HMAC dei webhook.

Stesso schema dei portali food/real_estate (src/lib/crypto.ts): AES-256-GCM,
chiave da ENCRYPTION_KEY (32 byte hex, `openssl rand -hex 32`), formato del
payload `iv:tag:ciphertext` in base64. Interoperabile con quei portali.
"""

import base64
import hashlib
import hmac
import os
import re
import time

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from django.conf import settings

IV_LENGTH = 16
TAG_LENGTH = 16


def _key() -> bytes:
    key = settings.ENCRYPTION_KEY
    if not key:
        raise RuntimeError("ENCRYPTION_KEY mancante in .env")
    # 32 byte hex (64 char) → usali direttamente; altrimenti deriva con SHA-256.
    # ponytail: NON cambiare questa derivazione senza re-cifrare tutti i secret
    # esistenti. Consigliato: ENCRYPTION_KEY di 32 byte hex (openssl rand -hex 32).
    if re.fullmatch(r"[0-9a-fA-F]{64}", key):
        return bytes.fromhex(key)
    return hashlib.sha256(key.encode()).digest()


def encrypt(plaintext: str) -> str:
    if not plaintext:
        return ""
    iv = os.urandom(IV_LENGTH)
    enc = Cipher(algorithms.AES(_key()), modes.GCM(iv)).encryptor()
    ciphertext = enc.update(plaintext.encode()) + enc.finalize()
    # Formato: iv:tag:ciphertext (tutto base64) — identico a food/real_estate.
    return ":".join(
        base64.b64encode(part).decode() for part in (iv, enc.tag, ciphertext)
    )


def decrypt(payload: str) -> str:
    if not payload:
        return ""
    try:
        iv_b64, tag_b64, data_b64 = payload.split(":")
    except ValueError as exc:
        raise ValueError("Payload cifrato non valido") from exc
    iv = base64.b64decode(iv_b64)
    tag = base64.b64decode(tag_b64)
    data = base64.b64decode(data_b64)
    dec = Cipher(algorithms.AES(_key()), modes.GCM(iv, tag)).decryptor()
    return (dec.update(data) + dec.finalize()).decode()


# Firma webhook: HMAC-SHA256 su `{timestamp}.{body}`, header
# `x-yourang-signature: sha256=<hex>` + `x-yourang-timestamp`, freschezza ±5 min.
# Identico a food/real_estate.
FRESHNESS_SECONDS = 5 * 60


def verify_signature(body: bytes, signature: str, timestamp: str, secret: str) -> bool:
    if not (signature and timestamp and secret):
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
