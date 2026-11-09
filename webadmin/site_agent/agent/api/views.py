from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .serializers import SessionSerializer


@method_decorator(ensure_csrf_cookie, name='dispatch')
class SessionView(APIView):
    """Public : sans session, l'interface y apprend où se connecter."""

    permission_classes = [AllowAny]

    def get(self, request):
        return Response(SessionSerializer(request).data)
