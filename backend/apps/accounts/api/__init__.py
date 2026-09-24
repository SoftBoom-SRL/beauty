"""Endpoint /api/auth — login staff, team & ruoli, inviti, login OTP clienti.

Tre pubblici diversi, un modulo ciascuno: `staff` (accesso e sessione della
dashboard), `team` (membri, ruoli e inviti) e `client` (registrazione e accesso
con OTP della web app). Qui si montano tutti sotto lo stesso router, nello
stesso ordine di quando stavano in un file solo; i sottorouter non hanno tag
propri ed ereditano "accounts". Ogni percorso sta tutto in un sottorouter
(GET e PUT di /client/me insieme): divisi su due, il secondo non verrebbe mai
raggiunto.
"""

from ninja import Router

from . import client, staff, team

router = Router(tags=["accounts"])
router.add_router("", staff.router)
router.add_router("", team.router)
router.add_router("", client.router)
