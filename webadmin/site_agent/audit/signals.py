from django.contrib.auth.signals import user_logged_in, user_logged_out, user_login_failed
from django.dispatch import receiver

from .services import LOGIN_FAILED, record_event


@receiver(user_logged_in)
def on_login(sender, request, user, **kwargs):
    record_event(request, 'login', 'ok', user=user)


@receiver(user_logged_out)
def on_logout(sender, request, user, **kwargs):
    if user is not None:
        record_event(request, 'logout', 'ok', user=user)


@receiver(user_login_failed)
def on_login_failed(sender, credentials, request=None, **kwargs):
    # Jamais le mot de passe : seulement l'identifiant tenté.
    record_event(request, LOGIN_FAILED, 'refusé', username=str(credentials.get('username', '')).strip().lower())
