"""Cas d'usage : faire passer une requête de l'interface à l'agent, au nom de la personne connectée."""

from django.conf import settings

from site_agent.audit.services import record_event

from .client import AgentClient, AgentResponse
from .identity import Identity

MUTATING_METHODS = ('POST', 'PUT', 'PATCH', 'DELETE')


def default_client() -> AgentClient:
    return AgentClient(settings.SITE_AGENT_AGENT_URL, settings.SITE_AGENT_PROXY_SECRET_FILE, settings.SITE_AGENT_AGENT_TIMEOUT)


def forward_request(request, client: AgentClient | None = None) -> AgentResponse:
    """Transmet la requête ; l'action est inscrite au journal dès que l'agent la décrit.

    La personne doit avoir un rôle : c'est vérifié par la vue avant d'arriver ici.
    """
    user = request.user
    identity = Identity(username=user.get_username(), name=user.display_name, role=user.agent_role)
    mutating = request.method in MUTATING_METHODS
    response = (client or default_client()).forward(
        identity,
        method=request.method,
        path=request.get_full_path(),
        body=request.body if mutating else None,
        content_type=request.META.get('CONTENT_TYPE'),
        accept=request.headers.get('Accept', '*/*'),
    )
    if mutating and response.audit:
        record_event(
            request,
            response.audit.action,
            response.audit.outcome,
            target=response.audit.target,
            details=response.audit.details,
        )
    return response
