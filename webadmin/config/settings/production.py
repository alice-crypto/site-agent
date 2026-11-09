"""Serveur de l'équipe : derrière Caddy, en HTTPS."""

from .base import *  # noqa: F403
from .base import env

DEBUG = False
SECRET_KEY = env('DJANGO_SECRET_KEY', default=SECRET_KEY)  # noqa: F405

# Sans serveur SMTP configuré, les courriels vont dans le journal plutôt que d'échouer.
if not env('EMAIL_HOST', default=''):
    EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'

LOGGING['root']['level'] = 'WARNING'  # noqa: F405
