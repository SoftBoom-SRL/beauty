"""Unica NinjaAPI: serve sia la dashboard gestionale sia la web app cliente.

Ogni app di dominio espone `router` in apps/<nome>/api.py.
"""

import os

from django.conf import settings
from ninja import NinjaAPI

# La documentazione interattiva (/api/docs + /api/openapi.json) è aperta a
# chiunque: elenca ogni rotta, ogni parametro e ogni schema, compresi quelli
# delle aree riservate. Utilissima in sviluppo, regalata a chi cerca un bersaglio
# in produzione. Default: accesa solo con DEBUG. Chi la vuole online la accende
# di proposito con API_DOCS=1.
_DOCS_ENABLED = os.getenv("API_DOCS", "1" if settings.DEBUG else "0") == "1"

api = NinjaAPI(
    title="youty API",
    version="1.0",
    docs_url="/docs" if _DOCS_ENABLED else None,
    openapi_url="/openapi.json" if _DOCS_ENABLED else None,
)

from apps.accounts.api import router as accounts_router  # noqa: E402
from apps.agenda.api import router as agenda_router  # noqa: E402
from apps.automations.api import router as automations_router  # noqa: E402
from apps.catalog.api import router as catalog_router  # noqa: E402
from apps.clients.api import router as clients_router  # noqa: E402
from apps.core.api import router as core_router  # noqa: E402
from apps.insights.api import router as insights_router  # noqa: E402
from apps.integrations.api import router as integrations_router  # noqa: E402
from apps.inventory.api import router as inventory_router  # noqa: E402
from apps.marketing.api import router as marketing_router  # noqa: E402
from apps.sales.api import router as sales_router  # noqa: E402
from apps.staff.api import router as staff_router  # noqa: E402

api.add_router("/auth", accounts_router)
api.add_router("/core", core_router)
api.add_router("/clients", clients_router)
api.add_router("/staff", staff_router)
api.add_router("/catalog", catalog_router)
api.add_router("/agenda", agenda_router)
api.add_router("/sales", sales_router)
api.add_router("/inventory", inventory_router)
api.add_router("/marketing", marketing_router)
api.add_router("/automations", automations_router)
api.add_router("/insights", insights_router)
api.add_router("/integrations", integrations_router)
