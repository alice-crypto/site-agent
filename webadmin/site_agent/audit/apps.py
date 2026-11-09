from django.apps import AppConfig


class AuditConfig(AppConfig):
    name = 'site_agent.audit'
    verbose_name = "Journal d'audit"

    def ready(self):
        from . import signals  # noqa: F401
