"""Poste de développement."""

from .base import *  # noqa: F403
from .base import env

DEBUG = env.bool('DJANGO_DEBUG', default=True)
# Sans serveur de courriel : les messages s'affichent dans la console.
EMAIL_BACKEND = env('DJANGO_EMAIL_BACKEND', default='django.core.mail.backends.console.EmailBackend')
