from django.apps import AppConfig
from django.db.models.signals import post_migrate


def _create_role_groups(sender, using='default', **kwargs):
    from .services import ensure_role_groups

    ensure_role_groups(using)


class UsersConfig(AppConfig):
    name = 'site_agent.users'
    verbose_name = 'Comptes'

    def ready(self):
        # Les permissions sont créées au post_migrate de chaque application : les groupes sont complétés à chaque passage.
        post_migrate.connect(_create_role_groups, dispatch_uid='site-agent-role-groups')
