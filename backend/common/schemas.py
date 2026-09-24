"""Schemi di risposta condivisi fra le app."""

from ninja import Schema


# Risposta delle azioni che non restituiscono dati: `{"ok": true}`.
#
# Era scritta identica in undici `schemas.py` (accounts, agenda, automations,
# catalog, clients, core, integrations, inventory, marketing, sales, staff).
# Il nome resta `OkOut`, quello del componente nello schema OpenAPI, e la classe
# non ha docstring apposta: pydantic la pubblicherebbe come `description` dello
# schema, e le risposte che la usano cambierebbero forma nel contratto HTTP.
class OkOut(Schema):
    ok: bool = True
