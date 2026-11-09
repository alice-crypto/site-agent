"""Tests automatiques : même PostgreSQL, base de test créée et détruite par pytest."""

from .base import *  # noqa: F403

SECRET_KEY = 'tests-uniquement'
PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']
EMAIL_BACKEND = 'django.core.mail.backends.locmem.EmailBackend'
STORAGES['staticfiles']['BACKEND'] = 'django.contrib.staticfiles.storage.StaticFilesStorage'  # noqa: F405
# Pas de collectstatic pendant les tests : WhiteNoise n'a rien à servir.
MIDDLEWARE = [m for m in MIDDLEWARE if m != 'whitenoise.middleware.WhiteNoiseMiddleware']  # noqa: F405
