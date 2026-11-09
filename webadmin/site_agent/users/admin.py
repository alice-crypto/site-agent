from django.contrib import admin
from django.contrib.auth import admin as auth_admin

from .forms import ThrottledAuthenticationForm, UserAdminChangeForm, UserAdminCreationForm
from .models import User
from .roles import ROLE_LABELS

admin.site.site_header = 'Administration de Site Agent'
admin.site.site_title = 'Site Agent'
admin.site.index_title = 'Comptes, groupes et journal'
admin.site.site_url = '/'
# La connexion à l'administration a la même protection contre les essais répétés.
admin.site.login_form = ThrottledAuthenticationForm


@admin.register(User)
class UserAdmin(auth_admin.UserAdmin):
    form = UserAdminChangeForm
    add_form = UserAdminCreationForm
    fieldsets = (
        (None, {'fields': ('username', 'password')}),
        ('Informations', {'fields': ('name', 'email')}),
        (
            'Accès',
            {
                'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions'),
                'description': "Le rôle dans l'agent vient des groupes : Lecteurs, Opérateurs ou Administrateurs. "
                "« Statut équipe » donne en plus l'accès à cette administration.",
            },
        ),
        ('Dates', {'fields': ('last_login', 'date_joined')}),
    )
    add_fieldsets = (
        (None, {'classes': ('wide',), 'fields': ('username', 'name', 'email', 'usable_password', 'password1', 'password2')}),
    )
    list_display = ('username', 'name', 'email', 'role', 'is_active', 'is_staff', 'last_login')
    list_filter = ('is_active', 'is_staff', 'is_superuser', 'groups')
    search_fields = ('username', 'name', 'email')
    ordering = ('username',)

    @admin.display(description="Rôle dans l'agent")
    def role(self, user):
        return ROLE_LABELS.get(user.agent_role, 'Aucun accès')
