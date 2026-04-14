import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Plus, Trash2, Edit2, Shield, User, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';
import SettingsSection from '../SettingsSection';

interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
  created_at: string;
  last_login: string | null;
  is_active: number;
  has_completed_onboarding: number;
}

interface UserFormData {
  username: string;
  password: string;
  role: 'admin' | 'user';
}

export default function UserManagementTab() {
  const { t } = useTranslation('settings');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formData, setFormData] = useState<UserFormData>({
    username: '',
    password: '',
    role: 'user',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Fetch current user info and users list
  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Get current user
      const currentUserRes = await api.auth.user();
      if (currentUserRes.ok) {
        const currentUserData = await currentUserRes.json();
        setCurrentUserId(currentUserData.user?.id);
      }

      // Get all users
      const res = await api.users.getAll();
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      } else {
        const data = await res.json();
        setError(data.error || t('userManagement.errors.loadFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('userManagement.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formData.username || !formData.password) {
      setFormError(t('userManagement.errors.usernamePasswordRequired'));
      return;
    }

    if (formData.password.length < 6) {
      setFormError(t('userManagement.errors.passwordMinLength'));
      return;
    }

    try {
      const res = await api.auth.register(formData.username, formData.password);
      if (res.ok) {
        // Update role if needed
        const data = await res.json();
        if (data.user && data.user.role !== formData.role) {
          await api.users.update(data.user.id, { role: formData.role });
        }
        setShowAddModal(false);
        setFormData({ username: '', password: '', role: 'user' });
        fetchUsers();
      } else {
        const data = await res.json();
        setFormError(data.error || t('userManagement.errors.createFailed'));
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('userManagement.errors.createFailed'));
    }
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;

    setFormError(null);

    try {
      const res = await api.users.update(editingUser.id, {
        role: formData.role,
      });
      if (res.ok) {
        setEditingUser(null);
        setFormData({ username: '', password: '', role: 'user' });
        fetchUsers();
      } else {
        const data = await res.json();
        setFormError(data.error || t('userManagement.errors.updateFailed'));
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('userManagement.errors.updateFailed'));
    }
  };

  const handleDeleteUser = async (user: User) => {
    setDeleteConfirmation(user);
  };

  const confirmDeleteUser = async () => {
    if (!deleteConfirmation) return;

    setDeleting(true);
    try {
      const res = await api.users.delete(deleteConfirmation.id);
      if (res.ok) {
        setDeleteConfirmation(null);
        fetchUsers();
      } else {
        const data = await res.json();
        alert(data.error || t('userManagement.errors.deleteFailed'));
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : t('userManagement.errors.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    setDeleteConfirmation(null);
  };

  const openEditModal = (user: User) => {
    setEditingUser(user);
    setFormData({
      username: user.username,
      password: '',
      role: user.role,
    });
    setFormError(null);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return t('userManagement.never');
    return new Date(dateStr).toLocaleString();
  };

  if (loading) {
    return (
      <SettingsSection title={t('userManagement.title')}>
        <div className="flex items-center justify-center py-8">
          <div className="text-muted-foreground">{t('userManagement.loading')}</div>
        </div>
      </SettingsSection>
    );
  }

  if (error) {
    return (
      <SettingsSection title={t('userManagement.title')}>
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-4 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span>{error}</span>
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t('userManagement.title')}
      description={t('userManagement.description')}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {t('userManagement.userCount', { count: users.length })}
          </span>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            setShowAddModal(true);
            setFormData({ username: '', password: '', role: 'user' });
            setFormError(null);
          }}
          className="flex items-center gap-1"
        >
          <Plus className="h-4 w-4" />
          {t('userManagement.addUser')}
        </Button>
      </div>

      {/* Users Table */}
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('userManagement.table.user')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('userManagement.table.role')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('userManagement.table.created')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('userManagement.table.lastLogin')}</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">{t('userManagement.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((user) => (
              <tr key={user.id} className={`hover:bg-muted/30 ${!user.is_active ? 'opacity-50' : ''}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {user.role === 'admin' ? (
                      <Shield className="h-4 w-4 text-primary" />
                    ) : (
                      <User className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className={`font-medium ${!user.is_active ? 'text-muted-foreground' : ''}`}>{user.username}</span>
                    {!user.is_active && (
                      <span className="text-xs text-destructive">{t('userManagement.deleted')}</span>
                    )}
                    {user.id === currentUserId && (
                      <span className="text-xs text-muted-foreground">{t('userManagement.you')}</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      user.role === 'admin'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {t(`userManagement.roles.${user.role}`)}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {formatDate(user.created_at)}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {formatDate(user.last_login)}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {user.is_active && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditModal(user)}
                        disabled={user.id === currentUserId}
                        className="h-8 w-8 p-0"
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteUser(user)}
                      disabled={user.id === currentUserId}
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold">{t('userManagement.addModal.title')}</h3>
            <form onSubmit={handleAddUser} className="space-y-4">
              {formError && (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {formError}
                </div>
              )}
              <div>
                <label className="mb-1 block text-sm font-medium">{t('userManagement.form.username')}</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  placeholder={t('userManagement.form.usernamePlaceholder')}
                  minLength={3}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t('userManagement.form.password')}</label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  placeholder={t('userManagement.form.passwordPlaceholder')}
                  minLength={6}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t('userManagement.form.role')}</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value as 'admin' | 'user' })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="user">{t('userManagement.roles.user')}</option>
                  <option value="admin">{t('userManagement.roles.admin')}</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setShowAddModal(false)}>
                  {t('userManagement.form.cancel')}
                </Button>
                <Button type="submit">{t('userManagement.form.createUser')}</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
            <h3 className="mb-2 text-lg font-semibold">
              {deleteConfirmation.is_active
                ? t('userManagement.confirmDeleteTitle')
                : t('userManagement.confirmPermanentDeleteTitle')}
            </h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {deleteConfirmation.is_active
                ? t('userManagement.confirmDeleteMessage', { username: deleteConfirmation.username })
                : t('userManagement.confirmPermanentDeleteMessage', { username: deleteConfirmation.username })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={cancelDelete} disabled={deleting}>
                {t('userManagement.form.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={confirmDeleteUser}
                disabled={deleting}
                className="flex items-center gap-1"
              >
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                {deleteConfirmation.is_active
                  ? t('userManagement.form.delete')
                  : t('userManagement.form.permanentDelete')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold">{t('userManagement.editModal.title', { username: editingUser.username })}</h3>
            <form onSubmit={handleUpdateUser} className="space-y-4">
              {formError && (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {formError}
                </div>
              )}
              <div>
                <label className="mb-1 block text-sm font-medium">{t('userManagement.form.role')}</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value as 'admin' | 'user' })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="user">{t('userManagement.roles.user')}</option>
                  <option value="admin">{t('userManagement.roles.admin')}</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setEditingUser(null)}>
                  {t('userManagement.form.cancel')}
                </Button>
                <Button type="submit">{t('userManagement.form.updateUser')}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}