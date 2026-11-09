from django.urls import path
from rest_framework.routers import DefaultRouter

from site_agent.agent.api.views import SessionView
from site_agent.audit.api.views import AuditEntryViewSet
from site_agent.users.api.views import UserViewSet

router = DefaultRouter(trailing_slash=False)
router.include_root_view = False
router.register('users', UserViewSet)
router.register('audit', AuditEntryViewSet)

app_name = 'api'
urlpatterns = [
    path('session', SessionView.as_view(), name='session'),
    *router.urls,
]
