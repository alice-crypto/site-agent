"""Les trois rôles de l'agent. Ils sont portés par des permissions, regroupées dans trois groupes Django."""

from enum import StrEnum


class Role(StrEnum):
    VIEWER = 'viewer'
    OPERATOR = 'operator'
    ADMIN = 'admin'


ROLE_LABELS = {Role.VIEWER: 'Lecteur', Role.OPERATOR: 'Opérateur', Role.ADMIN: 'Administrateur'}

# Du plus élevé au plus faible : le premier rôle accordé l'emporte.
ROLE_PERMISSIONS = (
    (Role.ADMIN, 'users.administer_agent'),
    (Role.OPERATOR, 'users.operate_agent'),
    (Role.VIEWER, 'users.view_agent'),
)

AGENT_PERMISSIONS = [
    ('view_agent', 'Consulter les sites, leur état et leur historique'),
    ('operate_agent', 'Simuler, lancer un cycle, valider ou refuser une mise à jour'),
    ('administer_agent', 'Associer et retirer des sites, changer les règles et la surveillance'),
]

# Groupe -> permissions sur l'agent.
ROLE_GROUPS = {
    'Lecteurs': ['view_agent'],
    'Opérateurs': ['view_agent', 'operate_agent'],
    'Administrateurs': ['view_agent', 'operate_agent', 'administer_agent'],
}
ADMIN_GROUP = 'Administrateurs'
# Le groupe des administrateurs gère aussi les comptes et consulte le journal dans l'administration Django.
ADMIN_GROUP_DJANGO_PERMISSIONS = [
    ('users', 'user', ['add', 'change', 'view']),
    ('auth', 'group', ['view']),
    ('audit', 'auditentry', ['view']),
]
