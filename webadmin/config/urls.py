from django.conf import settings
from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import include, path, re_path

from site_agent.agent.views import agent_proxy
from site_agent.users.forms import ThrottledAuthenticationForm

account_urls = [
    path(
        'connexion/',
        auth_views.LoginView.as_view(authentication_form=ThrottledAuthenticationForm, redirect_authenticated_user=True),
        name='login',
    ),
    path('deconnexion/', auth_views.LogoutView.as_view(), name='logout'),
    path('mot-de-passe/', auth_views.PasswordChangeView.as_view(), name='password_change'),
    path('mot-de-passe/change/', auth_views.PasswordChangeDoneView.as_view(), name='password_change_done'),
    path('mot-de-passe-oublie/', auth_views.PasswordResetView.as_view(), name='password_reset'),
    path('mot-de-passe-oublie/envoye/', auth_views.PasswordResetDoneView.as_view(), name='password_reset_done'),
    path('reinitialisation/<uidb64>/<token>/', auth_views.PasswordResetConfirmView.as_view(), name='password_reset_confirm'),
    path('reinitialisation/terminee/', auth_views.PasswordResetCompleteView.as_view(), name='password_reset_complete'),
]

urlpatterns = [
    path(settings.ADMIN_URL, admin.site.urls),
    path('comptes/', include(account_urls)),
    path('api/', include('config.api_router')),
    # Tout le reste est l'interface de l'agent et son API, servies à travers Django.
    re_path(r'^(?P<path>.*)$', agent_proxy),
]
