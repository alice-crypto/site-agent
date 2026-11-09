"""Réglages communs de l'administration de Site Agent.

Tout se règle par variables d'environnement ou dans webadmin/.env (modèle : .env.example).
"""

import secrets
from pathlib import Path
from urllib.parse import urlsplit

import environ

BASE_DIR = Path(__file__).resolve(strict=True).parent.parent.parent
APPS_DIR = BASE_DIR / 'site_agent'

env = environ.Env()
if (BASE_DIR / '.env').exists():
    env.read_env(str(BASE_DIR / '.env'))

# Site Agent
# ------------------------------------------------------------------------------
# Dossier de l'agent Node.js : la clé partagée avec lui est dans son sous-dossier .site-agent.
SITE_AGENT_HOME = Path(env('SITE_AGENT_HOME', default=str(BASE_DIR.parent))).resolve()
SITE_AGENT_DATA_DIR = SITE_AGENT_HOME / '.site-agent'
SITE_AGENT_PROXY_SECRET_FILE = SITE_AGENT_DATA_DIR / 'proxy-secret'
SITE_AGENT_AGENT_URL = env('SITE_AGENT_AGENT_URL', default='http://127.0.0.1:4310')
# Un cycle de mise à jour peut durer : tests, build, déploiement, vérification.
SITE_AGENT_AGENT_TIMEOUT = env.int('SITE_AGENT_AGENT_TIMEOUT', default=1800)
SITE_AGENT_PUBLIC_URL = env('SITE_AGENT_PUBLIC_URL', default='http://127.0.0.1:8000').rstrip('/')
_public = urlsplit(SITE_AGENT_PUBLIC_URL)


def _persistent_secret_key():
    """Créée au premier lancement puis conservée : les sessions survivent aux redémarrages."""
    path = SITE_AGENT_DATA_DIR / 'django-secret-key'
    if path.exists() and path.read_text(encoding='utf-8').strip():
        return path.read_text(encoding='utf-8').strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_urlsafe(50)
    path.write_text(value, encoding='utf-8')
    return value


# Général
# ------------------------------------------------------------------------------
DEBUG = env.bool('DJANGO_DEBUG', default=False)
SECRET_KEY = env('DJANGO_SECRET_KEY', default='') or _persistent_secret_key()
ALLOWED_HOSTS = sorted({_public.hostname, 'localhost', '127.0.0.1'})
CSRF_TRUSTED_ORIGINS = [f'{_public.scheme}://{_public.netloc}']
TIME_ZONE = env('SITE_AGENT_TIME_ZONE', default='Europe/Paris')
LANGUAGE_CODE = 'fr-fr'
USE_I18N = True
USE_TZ = True

# Base de données
# ------------------------------------------------------------------------------
DATABASES = {'default': env.db('DATABASE_URL', default='postgres://site_agent@127.0.0.1:5432/site_agent')}
DATABASES['default']['ATOMIC_REQUESTS'] = True
DATABASES['default']['CONN_MAX_AGE'] = env.int('CONN_MAX_AGE', default=60)
DATABASES['default']['CONN_HEALTH_CHECKS'] = True
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# URLs
# ------------------------------------------------------------------------------
ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'

# Applications
# ------------------------------------------------------------------------------
DJANGO_APPS = [
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.admin',
]
THIRD_PARTY_APPS = [
    'rest_framework',
]
LOCAL_APPS = [
    'site_agent.users',
    'site_agent.audit',
    'site_agent.agent',
]
INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

# Authentification
# ------------------------------------------------------------------------------
AUTH_USER_MODEL = 'users.User'
LOGIN_URL = 'login'
LOGIN_REDIRECT_URL = '/'
LOGOUT_REDIRECT_URL = 'login'
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 12}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]
# Trop d'échecs de connexion sur un même identifiant : blocage temporaire.
LOGIN_MAX_FAILURES = 5
LOGIN_LOCK_MINUTES = 15

# Middleware
# ------------------------------------------------------------------------------
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.locale.LocaleMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

# Fichiers statiques
# ------------------------------------------------------------------------------
STATIC_ROOT = str(BASE_DIR / 'staticfiles')
STATIC_URL = '/static/'
STATICFILES_DIRS = [str(APPS_DIR / 'static')]
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage'},
}

# Gabarits
# ------------------------------------------------------------------------------
TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [str(APPS_DIR / 'templates')],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

# Sécurité
# ------------------------------------------------------------------------------
HTTPS = _public.scheme == 'https'
SESSION_COOKIE_NAME = 'site_agent_session'
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Strict'
SESSION_COOKIE_SECURE = HTTPS
# Session fermée après 12 h sans activité.
SESSION_COOKIE_AGE = 12 * 60 * 60
SESSION_SAVE_EVERY_REQUEST = True
# L'interface lit ce jeton pour l'envoyer avec ses requêtes : ce cookie n'est pas HttpOnly, par conception.
CSRF_COOKIE_NAME = 'site_agent_csrf'
CSRF_COOKIE_SAMESITE = 'Strict'
CSRF_COOKIE_SECURE = HTTPS
# Caddy termine le HTTPS et l'indique par cet en-tête.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'same-origin'
X_FRAME_OPTIONS = 'DENY'

# Courriels : réinitialisation de mot de passe
# ------------------------------------------------------------------------------
EMAIL_BACKEND = env('DJANGO_EMAIL_BACKEND', default='django.core.mail.backends.smtp.EmailBackend')
EMAIL_HOST = env('EMAIL_HOST', default='localhost')
EMAIL_PORT = env.int('EMAIL_PORT', default=587)
EMAIL_HOST_USER = env('EMAIL_HOST_USER', default='')
EMAIL_HOST_PASSWORD = env('EMAIL_HOST_PASSWORD', default='')
EMAIL_USE_TLS = env.bool('EMAIL_USE_TLS', default=True)
EMAIL_TIMEOUT = 10
DEFAULT_FROM_EMAIL = env('DJANGO_DEFAULT_FROM_EMAIL', default='Site Agent <site-agent@localhost>')

# Administration
# ------------------------------------------------------------------------------
ADMIN_URL = 'admin/'

# Django REST Framework
# ------------------------------------------------------------------------------
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': ('rest_framework.authentication.SessionAuthentication',),
    'DEFAULT_PERMISSION_CLASSES': ('rest_framework.permissions.IsAuthenticated',),
    'DEFAULT_RENDERER_CLASSES': ('rest_framework.renderers.JSONRenderer',),
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.LimitOffsetPagination',
    'PAGE_SIZE': 50,
}

# Journal
# ------------------------------------------------------------------------------
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {'verbose': {'format': '%(levelname)s %(asctime)s %(name)s %(message)s'}},
    'handlers': {'console': {'class': 'logging.StreamHandler', 'formatter': 'verbose'}},
    'root': {'handlers': ['console'], 'level': 'INFO'},
}
