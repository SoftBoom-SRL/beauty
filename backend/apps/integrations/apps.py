from django.apps import AppConfig


class IntegrationsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.integrations"
    verbose_name = "Integrazioni (Yourang)"

    def ready(self):
        # Segnaposto delle prenotazioni Yourang idoneo per ogni operatrice.
        from . import signals  # noqa: F401
