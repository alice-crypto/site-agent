import logging

from django.db import transaction
from django.http import HttpResponse, JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views.decorators.csrf import ensure_csrf_cookie

from .services.client import AgentUnavailable
from .services.gateway import forward_request

logger = logging.getLogger(__name__)


def _refuse(request, is_api, status, message, template):
    if is_api:
        return JsonResponse({'error': message, 'loginUrl': reverse('login')}, status=status)
    return render(request, template, {'message': message}, status=status)


# Un cycle de l'agent peut durer de longues minutes : aucune transaction ne doit rester ouverte pendant ce temps.
@transaction.non_atomic_requests
@ensure_csrf_cookie
def agent_proxy(request, path):
    """Sert l'interface de l'agent et son API, au nom de la personne connectée."""
    is_api = path.startswith('api/')

    if not request.user.is_authenticated:
        if is_api:
            return JsonResponse({'error': 'Connectez-vous pour continuer.', 'loginUrl': reverse('login')}, status=401)
        return redirect(f"{reverse('login')}?next=/")

    if request.user.agent_role is None:
        return _refuse(request, is_api, 403, "Votre compte n'a encore aucun accès à l'agent.", 'agent/no_access.html')

    try:
        upstream = forward_request(request)
    except AgentUnavailable as error:
        logger.warning('Agent injoignable : %s', error.__cause__ or error)
        return _refuse(request, is_api, 502, str(error), 'agent/unavailable.html')

    response = HttpResponse(upstream.content, status=upstream.status)
    for name, value in upstream.headers.items():
        response[name] = value
    return response
