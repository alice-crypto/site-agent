"""Écriture et lecture du journal d'audit, indépendantes des vues."""

from datetime import timedelta

from django.utils import timezone

from .models import AuditEntry

LOGIN_FAILED = 'login.failed'
LOOPBACK = {'127.0.0.1', '::1'}


def client_ip(request):
    remote = request.META.get('REMOTE_ADDR') or None
    # Derrière Caddy, sur la même machine, l'adresse du navigateur est le dernier élément de X-Forwarded-For.
    # L'en-tête n'est cru que s'il vient de là : sinon n'importe qui pourrait s'attribuer une adresse.
    forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
    if remote in LOOPBACK and forwarded:
        return forwarded.split(',')[-1].strip() or remote
    return remote


def record_event(request, action, outcome, *, user=None, username=None, target='', details=None) -> AuditEntry:
    if user is None and request is not None and getattr(request, 'user', None) and request.user.is_authenticated:
        user = request.user
    if username is None:
        username = user.get_username() if user else ''
    return AuditEntry.objects.create(
        user=user,
        username=username[:150],
        action=action[:64],
        target=str(target)[:200],
        outcome=str(outcome)[:300],
        details=details or {},
        ip=client_ip(request) if request is not None else None,
    )


def recent_login_failures(username: str, minutes: int) -> int:
    since = timezone.now() - timedelta(minutes=minutes)
    return AuditEntry.objects.filter(action=LOGIN_FAILED, username=username, at__gte=since).count()
