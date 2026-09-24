"""Tema e navigazione dell'admin (django-unfold), letti come `settings.UNFOLD`.

Erano un centinaio di righe in fondo a settings.py, con un import a metà
file: chi cercava un'impostazione vera doveva scorrerle tutte. settings.py le
importa da qui; il nome del setting resta UNFOLD.
"""

from django.urls import reverse_lazy


def _changelist(name: str):
    return reverse_lazy(f"admin:{name}_changelist")


UNFOLD = {
    "SITE_TITLE": "youty admin",
    "SITE_HEADER": "youty",
    "SITE_SUBHEADER": "Gestionale salone",
    "SITE_SYMBOL": "spa",  # icona Material Symbols nell'header
    "SHOW_HISTORY": True,
    "SHOW_VIEW_ON_SITE": False,  # backend API-only: nessuna pagina pubblica per oggetto
    "COLORS": {
        "primary": {
            "50": "245 243 255",
            "100": "237 233 254",
            "200": "221 214 254",
            "300": "196 181 253",
            "400": "167 139 250",
            "500": "139 92 246",
            "600": "124 58 237",
            "700": "109 40 217",
            "800": "91 33 182",
            "900": "76 29 149",
            "950": "46 16 101",
        },
    },
    "SIDEBAR": {
        "show_search": True,
        "show_all_applications": True,  # dropdown di fallback con tutti i modelli
        "navigation": [
            {
                "title": "Salone",
                "separator": False,
                "items": [
                    {"title": "Saloni", "icon": "store", "link": _changelist("core_salon")},
                    {"title": "Sedi", "icon": "location_on", "link": _changelist("core_location")},
                    {"title": "Impostazioni", "icon": "settings", "link": _changelist("core_salonsettings")},
                    {"title": "Regole caparra", "icon": "euro", "link": _changelist("core_depositrule")},
                ],
            },
            {
                "title": "Clienti & Staff",
                "items": [
                    {"title": "Clienti", "icon": "group", "link": _changelist("clients_client")},
                    {"title": "Etichette clienti", "icon": "sell", "link": _changelist("clients_clientcategory")},
                    {"title": "Operatrici", "icon": "badge", "link": _changelist("staff_operator")},
                ],
            },
            {
                "title": "Catalogo & Agenda",
                "items": [
                    {"title": "Servizi", "icon": "content_cut", "link": _changelist("catalog_service")},
                    {"title": "Categorie servizi", "icon": "category", "link": _changelist("catalog_servicecategory")},
                    {"title": "Pacchetti", "icon": "package_2", "link": _changelist("catalog_package")},
                    {"title": "Appuntamenti", "icon": "calendar_month", "link": _changelist("agenda_appointment")},
                    {"title": "Lista d'attesa", "icon": "hourglass_top", "link": _changelist("agenda_waitlistentry")},
                ],
            },
            {
                "title": "Vendite & Magazzino",
                "items": [
                    {"title": "Vendite", "icon": "point_of_sale", "link": _changelist("sales_sale")},
                    {"title": "Prodotti", "icon": "inventory_2", "link": _changelist("inventory_product")},
                    {"title": "Fornitori", "icon": "local_shipping", "link": _changelist("inventory_supplier")},
                    {"title": "Ordini fornitore", "icon": "receipt_long", "link": _changelist("inventory_purchaseorder")},
                    {"title": "Movimenti stock", "icon": "swap_vert", "link": _changelist("inventory_stockmovement")},
                ],
            },
            {
                "title": "Marketing & Automazioni",
                "items": [
                    {"title": "Coupon", "icon": "confirmation_number", "link": _changelist("marketing_coupon")},
                    {"title": "Gift card", "icon": "card_giftcard", "link": _changelist("marketing_giftcard")},
                    {"title": "Fedeltà", "icon": "loyalty", "link": _changelist("marketing_loyaltyprogram")},
                    {"title": "Comunicazioni", "icon": "campaign", "link": _changelist("marketing_communication")},
                    {"title": "Automazioni", "icon": "bolt", "link": _changelist("automations_automation")},
                ],
            },
            {
                "title": "Sistema",
                "items": [
                    {"title": "Utenti", "icon": "manage_accounts", "link": _changelist("accounts_user")},
                    {"title": "Ruoli", "icon": "shield_person", "link": _changelist("accounts_role")},
                    {"title": "Membership", "icon": "diversity_3", "link": _changelist("accounts_membership")},
                    {"title": "Inviti", "icon": "mail", "link": _changelist("accounts_invitation")},
                    {"title": "Outbox Yourang", "icon": "outbox", "link": _changelist("core_outboxevent")},
                    {"title": "Registro attività", "icon": "history", "link": _changelist("core_activitylog")},
                ],
            },
        ],
    },
}
