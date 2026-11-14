import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import {
  ArrowLeft,
  BarChart3,
  Building2,
  Download,
  Flag,
  KeyRound,
  LogOut,
  Megaphone,
  MessagesSquare,
  Pencil,
  Save,
  ScrollText,
  Settings,
  Shield,
  Trash2,
  Upload,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import * as db from '../lib/db';
import { useAuth, useCurrentUser } from '../hooks';
import { autoAssignRankForGroup, courseFromGroup } from '../lib/ranks';
import { Avatar, Button, Input, RankBadge } from '../ui';
import type { User } from '../types';
import { POSITIONS, RANKS } from '../types';

type AdminTab =
  | 'dashboard'
  | 'users'
  | 'chats'
  | 'broadcasts'
  | 'complaints'
  | 'security'
  | 'audit'
  | 'structure'
  | 'settings';

const TABS: Array<{ key: AdminTab; label: string; icon: typeof Users }> = [
  { key: 'dashboard', label: 'Дашборд', icon: BarChart3 },
  { key: 'users', label: 'Пользователи', icon: Users },
  { key: 'chats', label: 'Чаты', icon: MessagesSquare },
  { key: 'broadcasts', label: 'Оповещения', icon: Megaphone },
  { key: 'complaints', label: 'Жалобы', icon: Flag },
  { key: 'audit', label: 'Журнал', icon: ScrollText },
  { key: 'structure', label: 'Структура', icon: Building2 },
  { key: 'settings', label: 'Настройки', icon: Settings },
];

/**
 * Админ-панель: дашборд, пользователи (поиск, фильтры, массовые действия,
 * CSV), чаты, оповещения, журнал действий, структура и настройки.
 */
export function AdminPage() {
  const navigate = useNavigate();
  const myId = useAuth();
  const me = useCurrentUser();

  const [tab, setTab] = useState<AdminTab>('dashboard');
  const [users, setUsers] = useState<User[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setError(null);
    try {
      setUsers(await db.getAllUsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить пользователей');
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const roleAdmin = myId && me && me.role === 'admin';
  if (!myId || !me) return null;
  if (!roleAdmin) return <Navigate to="/main" replace />;

  const downloadBackup = async () => {
    try {
      const data = await db.exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `svyaz-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setNotice('Резервная копия скачана');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось создать резервную копию');
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={() => navigate('/main')}
          className="rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Назад"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="flex items-center gap-2 text-[17px] font-medium text-text">
          <Shield size={18} className="text-accent" />
          Админ-панель
        </h1>
        <button
          type="button"
          onClick={() => void downloadBackup()}
          className="ml-auto rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Скачать резервную копию"
          title="Резервная копия (JSON)"
        >
          <Download size={18} />
        </button>
        <span className="rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-[13px] text-accent">
          {users.length} пользователей
        </span>
      </header>

      {/* вкладки админки */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key);
                setError(null);
                setNotice(null);
              }}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] ${
                active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface hover:text-text'
              }`}
              aria-pressed={active}
            >
              <Icon size={15} />
              {label}
            </button>
          );
        })}
      </div>

      <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 overflow-y-auto p-4">
        {(error || notice) && (
          <div
            className={`rounded-lg border px-3 py-2 text-[13px] ${
              error
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-accent/40 bg-accent/10 text-text'
            }`}
          >
            {error ?? notice}
          </div>
        )}

        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'users' && (
          <UsersTab
            users={users}
            myId={myId}
            onReload={loadUsers}
            setNotice={setNotice}
            setError={setError}
          />
        )}
        {tab === 'chats' && <ChatsTab users={users} setNotice={setNotice} setError={setError} />}
        {tab === 'broadcasts' && <BroadcastsTab setNotice={setNotice} setError={setError} />}
        {tab === 'complaints' && <ComplaintsTab />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'structure' && <StructureTab setNotice={setNotice} setError={setError} />}
        {tab === 'settings' && (
          <SettingsTab
            users={users}
            myId={myId}
            setNotice={setNotice}
            setError={setError}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Дашборд

function DashboardTab() {
  const [stats, setStats] = useState<db.AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState<db.AdminActivityPoint[]>([]);
  const [activityMissing, setActivityMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    db.getAdminStats()
      .then((s) => {
        if (alive) s && setStats(s);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    db.getAdminActivity(30)
      .then((points) => {
        if (alive) setActivity(points);
      })
      .catch(() => {
        if (alive) setActivityMissing(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <p className="text-[13px] text-text-muted">Загрузка статистики…</p>;
  if (!stats) return <p className="text-[13px] text-text-muted">Статистика недоступна</p>;

  const maxCount = Math.max(1, ...stats.activity.map((a) => a.count));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatCard label="Всего" value={stats.usersTotal} tone="neutral" />
        <StatCard label="Онлайн" value={stats.usersOnline} tone="good" />
        <StatCard label="Офлайн" value={stats.usersOffline} tone="muted" />
        <StatCard label="Сообщений сегодня" value={stats.messagesToday} tone="neutral" />
        <StatCard label="Сообщений за неделю" value={stats.messagesWeek} tone="neutral" />
        <StatCard label="Активных чатов" value={stats.activeChats} tone="good" />
      </div>

      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="mb-3 text-[13px] font-medium text-text-muted">
          Активность за 7 дней (сообщения)
        </div>
        <div className="flex h-32 items-end gap-1.5">
          {stats.activity.map((a) => (
            <div key={a.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="tabular-nums text-[11px] text-text-muted">{a.count}</div>
              <div
                className="w-full rounded-t bg-accent/60"
                style={{ height: `${Math.max(4, (a.count / maxCount) * 88)}px` }}
                title={`${a.label}: ${a.count}`}
              />
              <div className="truncate text-[10px] text-text-muted">{a.label}</div>
            </div>
          ))}
        </div>
      </div>

      <MonthChart points={activity} missing={activityMissing} />
    </div>
  );
}

/** Активность за 30 дней: SVG-график с областью и подписями дат. */
function MonthChart({
  points,
  missing,
}: {
  points: db.AdminActivityPoint[];
  missing: boolean;
}) {
  const total = points.reduce((sum, p) => sum + p.count, 0);
  const max = Math.max(1, ...points.map((p) => p.count));
  const W = 600;
  const H = 150;
  const padX = 8;
  const baseY = H - 22;
  const step = points.length > 1 ? (W - padX * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({
    x: padX + i * step,
    y: baseY - (p.count / max) * (H - 50),
    ...p,
  }));
  const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area = coords.length
    ? `M ${padX},${baseY} L ${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' L ')} L ${(W - padX).toFixed(1)},${baseY} Z`
    : '';
  const labels = coords.filter((_, i) => i % 7 === 0 || i === coords.length - 1);

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-[13px] font-medium text-text-muted">
          Активность за 30 дней (сообщения)
        </div>
        <div className="text-[15px] font-semibold tabular-nums text-text">{total}</div>
      </div>

      {missing || points.length === 0 ? (
        <p className="text-[12px] text-text-muted">
          {missing
            ? 'График появится после обновления schema.sql (функция admin_activity).'
            : 'Пока нет данных для графика.'}
        </p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Активность за 30 дней">
          <defs>
            <linearGradient id="adminActivityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((k) => (
            <line
              key={k}
              x1={padX}
              x2={W - padX}
              y1={baseY - k * (H - 50)}
              y2={baseY - k * (H - 50)}
              stroke="var(--border)"
              strokeDasharray="3 4"
            />
          ))}
          <path d={area} fill="url(#adminActivityFill)" />
          <polyline
            points={line}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {coords.map((c) =>
            c.count === max && max > 0 ? (
              <circle key={`p-${c.day}`} cx={c.x} cy={c.y} r="3.5" fill="var(--accent)" />
            ) : null,
          )}
          {labels.map((c) => (
            <text
              key={`l-${c.day}`}
              x={c.x}
              y={H - 4}
              textAnchor={c.x < 30 ? 'start' : c.x > W - 30 ? 'end' : 'middle'}
              fontSize="10"
              fill="var(--text-muted)"
            >
              {c.day}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'good' | 'muted';
}) {
  const color =
    tone === 'good' ? 'text-green-600' : tone === 'muted' ? 'text-text-muted' : 'text-text';
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-[12px] text-text-muted">{label}</div>
      <div className={`text-[22px] font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

// ------------------------------------------------------------ Пользователи

function UsersTab({
  users,
  myId,
  onReload,
  setNotice,
  setError,
}: {
  users: User[];
  myId: string;
  onReload: () => Promise<void>;
  setNotice: (v: string | null) => void;
  setError: (v: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [posFilter, setPosFilter] = useState('');
  const [rankFilter, setRankFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [departments, setDepartments] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // редактирование
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editGroup, setEditGroup] = useState('');
  const [editRank, setEditRank] = useState('');
  const [editPosition, setEditPosition] = useState('');
  const [editDepartment, setEditDepartment] = useState('');
  const [editRoleLevel, setEditRoleLevel] = useState(1);
  /** звание назначается автоматически по курсу и должности */
  const [editAutoRank, setEditAutoRank] = useState(true);

  // сброс пароля
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  useEffect(() => {
    db.getDepartments()
      .then((list) => setDepartments(list.map((d) => d.name)))
      .catch(() => {});
  }, []);

  const groups = useMemo(
    () => Array.from(new Set(users.map((u) => u.group).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru')),
    [users],
  );
  const positions = useMemo(
    () => Array.from(new Set(users.map((u) => u.position ?? '').filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru')),
    [users],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (q) {
        const hay = `${u.fullName} ${u.login} ${u.username ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (groupFilter && u.group !== groupFilter) return false;
      if (deptFilter && (u.department ?? '') !== deptFilter) return false;
      if (posFilter && (u.position ?? '') !== posFilter) return false;
      if (rankFilter) {
        const base = (u.rank ?? '').replace(/\s+полиции\s*$/i, '').trim().toLowerCase();
        if (base !== rankFilter) return false;
      }
      return true;
    });
  }, [users, query, groupFilter, deptFilter, posFilter, rankFilter]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedIds = Array.from(selected);

  const handleEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editId) return;
    setBusyId(editId);
    setError(null);
    setNotice(null);
    try {
      await db.adminUpdateProfile(editId, editName, editGroup, editRank, editPosition, editRoleLevel, editDepartment);
      await db.logAudit(myId, 'Изменение профиля', 'user', editId, editName);
      setNotice('Данные пользователя обновлены.');
      setEditId(null);
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить данные');
    } finally {
      setBusyId(null);
    }
  };

  const handleReset = async (e: FormEvent) => {
    e.preventDefault();
    if (!resetId) return;
    setBusyId(resetId);
    setError(null);
    setNotice(null);
    try {
      await db.adminResetPassword(resetId, resetPassword);
      await db.logAudit(myId, 'Сброс пароля', 'user', resetId);
      setNotice('Пароль сброшен. Приватный ключ перешифрован.');
      setResetId(null);
      setResetPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сбросить пароль');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (u: User) => {
    if (u.id === myId) {
      setError('Нельзя удалить собственную учётную запись');
      return;
    }
    if (!window.confirm(`Удалить пользователя ${u.fullName} (${u.login}) со всеми данными?`)) return;
    setBusyId(u.id);
    setError(null);
    setNotice(null);
    try {
      await db.adminDeleteUser(u.id);
      await db.logAudit(myId, 'Удаление пользователя', 'user', u.id, u.fullName);
      setNotice(`Пользователь ${u.login} удалён.`);
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить пользователя');
    } finally {
      setBusyId(null);
    }
  };

  const handleLogoutDevices = async (u: User) => {
    setBusyId(u.id);
    setError(null);
    setNotice(null);
    try {
      await db.adminLogoutUser(u.id);
      await db.logAudit(myId, 'Сброс сессий', 'user', u.id, u.login);
      setNotice(`Сессии ${u.login} сброшены.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сбросить сессии');
    } finally {
      setBusyId(null);
    }
  };

  const handleFixKeys = async (u: User) => {
    setBusyId(u.id);
    setError(null);
    setNotice(null);
    try {
      const { fixed } = await db.adminFixKeys(u.id);
      setNotice(
        fixed > 0
          ? `Ключи для ${u.login} созданы. Приватную часть он получит при следующем входе.`
          : `У ${u.login} ключ уже есть.`,
      );
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось починить ключи');
    } finally {
      setBusyId(null);
    }
  };

  const handleBulkReset = async () => {
    if (selectedIds.length === 0) return;
    const password = window.prompt('Новый пароль для выбранных пользователей (мин. 6 символов):', 'test1234');
    if (!password) return;
    setBulkBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { ok, failed } = await db.adminBulkResetPassword(selectedIds, password);
      await db.logAudit(myId, 'Массовый сброс пароля', 'user', null, `ok=${ok}, failed=${failed}`);
      setNotice(`Пароль сброшен: ${ok}. Ошибок: ${failed}.`);
      setSelected(new Set());
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выполнить массовый сброс');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkMove = async () => {
    if (selectedIds.length === 0) return;
    const group = window.prompt('Перевести выбранных в взвод / группу:', '152 взвод');
    if (!group) return;
    setBulkBusy(true);
    setError(null);
    setNotice(null);
    try {
      await db.adminBulkMoveGroup(selectedIds, group);
      await db.logAudit(myId, 'Массовый перевод в взвод', 'user', null, `${group}: ${selectedIds.length}`);
      setNotice(`Переведено в «${group}»: ${selectedIds.length}.`);
      setSelected(new Set());
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось перевести пользователей');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Удалить ${selectedIds.length} пользователей со всеми данными?`)) return;
    setBulkBusy(true);
    setError(null);
    setNotice(null);
    try {
      await db.adminBulkDelete(selectedIds.filter((id) => id !== myId));
      await db.logAudit(myId, 'Массовое удаление пользователей', 'user', null, `count=${selectedIds.length}`);
      setNotice(`Удалено пользователей: ${selectedIds.length}.`);
      setSelected(new Set());
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить пользователей');
    } finally {
      setBulkBusy(false);
    }
  };

  const exportCsv = () => {
    const header = ['ФИО', 'Логин', 'Группа', 'Звание', 'Должность', 'Подразделение'];
    // Если отмечены галочками — экспортируем ровно выбранных, иначе фильтр.
    const exportList =
      selected.size > 0 ? users.filter((u) => selected.has(u.id)) : filtered;
    const rows = exportList.map((u) => [
      u.fullName,
      u.login,
      u.group,
      u.rank ?? '',
      u.position ?? '',
      u.department ?? '',
    ]);
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const csv = [header, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`Экспортировано пользователей: ${exportList.length}.`);
  };

  const parseCsv = (text: string): db.ImportUserRow[] => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return [];
    const splitLine = (line: string): string[] => {
      const out: string[] = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else inQuotes = !inQuotes;
        } else if ((ch === ';' || ch === ',') && !inQuotes) {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out.map((s) => s.trim());
    };
    const first = splitLine(lines[0]).map((s) => s.toLowerCase());
    const hasHeader = first.some((c) => c.includes('фио') || c.includes('логин'));
    const dataLines = hasHeader ? lines.slice(1) : lines;
    return dataLines.map((line) => {
      const c = splitLine(line);
      const num = Number(c[7]);
      return {
        fullName: c[0] ?? '',
        login: c[1] ?? '',
        password: c[2] ?? 'test1234',
        group: c[3] ?? '',
        rank: c[4] ?? '',
        position: c[5] ?? '',
        department: c[6] ?? '',
        roleLevel: Number.isFinite(num) && num >= 1 ? num : 1,
      };
    });
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBulkBusy(true);
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const res = await db.adminImportUsers(rows);
      await db.logAudit(myId, 'Импорт пользователей из CSV', 'user', null, `created=${res.created}`);
      setNotice(
        `Импорт завершён: создано ${res.created}.${
          res.failed.length ? ` Ошибок: ${res.failed.length} (${res.failed[0].login}: ${res.failed[0].reason})` : ''
        }`,
      );
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось импортировать пользователей');
    } finally {
      setBulkBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="space-y-3">
      {/* поиск и фильтры */}
      <div className="space-y-2">
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по ФИО, логину или нику…"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 pr-9 text-[15px] text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text"
              aria-label="Очистить"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[13px] text-text"
          >
            <option value="">Все взводы</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[13px] text-text"
          >
            <option value="">Все подразделения</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d.length > 46 ? `${d.slice(0, 46)}…` : d}
              </option>
            ))}
          </select>
          <select
            value={posFilter}
            onChange={(e) => setPosFilter(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[13px] text-text"
          >
            <option value="">Все должности</option>
            {positions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            value={rankFilter}
            onChange={(e) => setRankFilter(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[13px] text-text"
          >
            <option value="">Все звания</option>
            {RANKS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-text-muted">
            Найдено: {filtered.length}
            {selectedIds.length > 0 ? ` · выбрано ${selectedIds.length}` : ''}
          </span>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button variant="secondary" className="!py-1.5 !text-[13px]" onClick={exportCsv}>
              <Download size={14} />
              CSV
            </Button>
            <Button
              variant="secondary"
              className="!py-1.5 !text-[13px]"
              disabled={bulkBusy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={14} />
              Импорт
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => void handleImport(e)}
            />
          </div>
        </div>
      </div>

      {/* массовые действия */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 p-2">
          <Button
            variant="secondary"
            className="!py-1.5 !text-[13px]"
            disabled={bulkBusy}
            onClick={() => void handleBulkReset()}
          >
            <KeyRound size={14} />
            Сбросить пароль
          </Button>
          <Button
            variant="secondary"
            className="!py-1.5 !text-[13px]"
            disabled={bulkBusy}
            onClick={() => void handleBulkMove()}
          >
            <Users size={14} />
            Перевести в взвод
          </Button>
          <Button
            variant="danger"
            className="!py-1.5 !text-[13px]"
            disabled={bulkBusy}
            onClick={() => void handleBulkDelete()}
          >
            <Trash2 size={14} />
            Удалить
          </Button>
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 text-[13px] text-text-muted hover:text-text"
            onClick={() => setSelected(new Set())}
          >
            Снять выделение
          </button>
        </div>
      )}

      {/* список */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="py-8 text-center text-[13px] text-text-muted">Никого не найдено</div>
        )}
        {filtered.map((u) => (
          <div
            key={u.id}
            className="rounded-lg border border-border bg-surface p-3 transition-colors hover:border-text-muted"
          >
            {editId === u.id ? (
              <form onSubmit={(e) => void handleEdit(e)} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Avatar name={u.fullName} size="sm" seed={u.id} />
                  <div className="text-[13px] text-text-muted">{u.login}</div>
                </div>
                <Input label="ФИО" value={editName} onChange={(e) => setEditName(e.target.value)} />
                <Input
                  label="Группа / взвод"
                  value={editGroup}
                  onChange={(e) => {
                    const v = e.target.value;
                    setEditGroup(v);
                    if (editAutoRank) setEditRank(autoAssignRankForGroup(v, editPosition, editRank));
                  }}
                />
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-text-muted">Звание</span>
                    <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-text-muted">
                      <input
                        type="checkbox"
                        checked={editAutoRank}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setEditAutoRank(on);
                          if (on) setEditRank(autoAssignRankForGroup(editGroup, editPosition, editRank));
                        }}
                        className="h-3.5 w-3.5 accent-accent"
                      />
                      по курсу ({courseFromGroup(editGroup)} курс)
                    </label>
                  </div>
                  {editAutoRank ? (
                    <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2">
                      <RankBadge rank={editRank} size="sm" />
                      <span className="text-[13px] text-text">
                        {editRank || 'не определено'}
                        <span className="ml-1.5 text-[11px] text-text-muted">
                          — автоматически по курсу и должности
                        </span>
                      </span>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-1.5">
                      {RANKS.map((r) => {
                        const active = editRank === r;
                        return (
                          <button
                            key={r}
                            type="button"
                            onClick={() => setEditRank(active ? '' : r)}
                            className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-1.5 transition-colors ${
                              active
                                ? 'border-accent bg-accent/10'
                                : 'border-border bg-surface hover:border-text-muted'
                            }`}
                            aria-pressed={active}
                          >
                            <RankBadge rank={r} size="sm" />
                            <span
                              className={`w-full truncate text-center text-[11px] leading-tight ${
                                active ? 'font-medium text-accent' : 'text-text-muted'
                              }`}
                            >
                              {r}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div>
                  <span className="mb-1.5 block text-[13px] font-medium text-text-muted">Должность</span>
                  <select
                    value={editPosition}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEditPosition(v);
                      if (editAutoRank) setEditRank(autoAssignRankForGroup(editGroup, v, editRank));
                    }}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-text"
                  >
                    <option value="">— без должности —</option>
                    {POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="mb-1.5 block text-[13px] font-medium text-text-muted">Подразделение</span>
                  <select
                    value={editDepartment}
                    onChange={(e) => setEditDepartment(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-text"
                  >
                    <option value="">— без подразделения —</option>
                    {departments.map((d) => (
                      <option key={d} value={d}>
                        {d.length > 60 ? `${d.slice(0, 60)}…` : d}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="mb-1.5 block text-[13px] font-medium text-text-muted">
                    Уровень прав (1 — курсант … 10 — начальник университета)
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={editRoleLevel}
                    onChange={(e) => setEditRoleLevel(Number(e.target.value))}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-text"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={busyId === u.id} className="flex-1">
                    <Save size={15} />
                    Сохранить
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditId(null);
                    }}
                  >
                    Отмена
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggleSelect(u.id)}
                    className="mt-1.5 h-4 w-4 shrink-0 accent-accent"
                    aria-label={`Выбрать ${u.login}`}
                  />
                  <Avatar name={u.fullName} size="md" seed={u.id} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium text-text">
                      {u.fullName}
                      {u.role === 'admin' && (
                        <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                          admin
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[13px] text-text-muted">
                      @{u.login} · {u.group}
                      {u.rank ? ` · ${u.rank}` : ''}
                      {u.position ? ` · ${u.position}` : ''}
                    </div>
                    {u.department && (
                      <div className="truncate text-[12px] text-text-muted">{u.department}</div>
                    )}
                  </div>
                </div>

                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    className="gap-1.5 !py-1.5 !text-[13px]"
                    disabled={busyId === u.id}
                    onClick={() => {
                      setEditId(u.id);
                      setEditName(u.fullName);
                      setEditGroup(u.group);
                      // По умолчанию звание считается по курсу и должности;
                      // админ может снять галочку и выставить вручную.
                      setEditAutoRank(true);
                      setEditRank(autoAssignRankForGroup(u.group, u.position, u.rank));
                      setEditPosition(u.position ?? '');
                      setEditDepartment(u.department ?? '');
                      setEditRoleLevel(u.roleLevel ?? 1);
                      setResetId(null);
                    }}
                  >
                    <Pencil size={14} />
                    Изменить
                  </Button>
                  <Button
                    variant="secondary"
                    className="gap-1.5 !py-1.5 !text-[13px]"
                    disabled={busyId === u.id}
                    onClick={() => {
                      setResetId(u.id);
                      setEditId(null);
                      setResetPassword('');
                    }}
                  >
                    <KeyRound size={14} />
                    Сбросить пароль
                  </Button>
                  <Button
                    variant="secondary"
                    className="gap-1.5 !py-1.5 !text-[13px]"
                    disabled={busyId === u.id}
                    onClick={() => void handleLogoutDevices(u)}
                  >
                    <LogOut size={14} />
                    Выйти на всех устройствах
                  </Button>
                  <Button
                    variant="secondary"
                    className="gap-1.5 !py-1.5 !text-[13px]"
                    disabled={busyId === u.id}
                    onClick={() => void handleFixKeys(u)}
                  >
                    <Wrench size={14} />
                    Починить ключи
                  </Button>
                  {u.id !== myId && (
                    <Button
                      variant="danger"
                      className="gap-1.5 !ml-auto !py-1.5 !text-[13px]"
                      disabled={busyId === u.id}
                      onClick={() => void handleDelete(u)}
                    >
                      <Trash2 size={14} />
                      Удалить
                    </Button>
                  )}
                </div>

                {resetId === u.id && (
                  <form onSubmit={(e) => void handleReset(e)} className="mt-3 space-y-2 border-t border-border pt-3">
                    <Input
                      label={`Новый пароль для ${u.login}`}
                      type="password"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      autoComplete="new-password"
                      placeholder="Минимум 6 символов"
                    />
                    <div className="flex gap-2">
                      <Button type="submit" disabled={busyId === u.id} className="flex-1">
                        <KeyRound size={15} />
                        Сохранить новый пароль
                      </Button>
                      <Button variant="ghost" onClick={() => setResetId(null)}>
                        Отмена
                      </Button>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Чаты

function ChatsTab({
  users,
  setNotice,
  setError,
}: {
  users: User[];
  setNotice: (v: string | null) => void;
  setError: (v: string | null) => void;
}) {
  const [chats, setChats] = useState<db.AdminChatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) m.set(u.id, u.fullName);
    return m;
  }, [users]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setChats(await db.adminGetChats());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты');
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const KIND_LABEL: Record<string, string> = {
    direct: 'личный',
    squad: 'взвод',
    commander: 'командир',
    course: 'курсовой',
    teachers: 'преподаватели',
    group: 'групповой',
    broadcast: 'рассылка',
  };

  const filtered = chats.filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      (c.title ?? '').toLowerCase().includes(q) ||
      (c.target ?? '').toLowerCase().includes(q) ||
      c.kind.toLowerCase().includes(q)
    );
  });

  const remove = async (c: db.AdminChatRow) => {
    if (!window.confirm('Удалить чат со всеми сообщениями у всех участников?')) return;
    try {
      await db.adminDeleteChat(c.id);
      setNotice('Чат удалён.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить чат');
    }
  };

  const pin = async (c: db.AdminChatRow) => {
    try {
      await db.adminToggleChatPin(c.id, !c.pinned);
      setNotice(c.pinned ? 'Чат откреплён.' : 'Чат закреплён.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить закрепление');
    }
  };

  const mergeDuplicates = async () => {
    if (merging) return;
    setMerging(true);
    try {
      const removed = await db.adminMergeDuplicateChats();
      setNotice(
        removed > 0
          ? `Объединено дублей: ${removed}. Сообщения и участники перенесены.`
          : 'Дублей не найдено — всё уже объединено.',
      );
      await load();
    } catch (e) {
      setError(
        e instanceof Error
          ? `Не удалось объединить дубли: ${e.message}`
          : 'Не удалось объединить дубли. Выполните обновлённый schema.sql.',
      );
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по названию, взводу или типу…"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-text placeholder:text-text-muted"
        />
        <button
          type="button"
          onClick={() => void mergeDuplicates()}
          disabled={merging}
          className="shrink-0 rounded-lg border border-border px-3 py-2 text-[13px] text-text hover:bg-surface disabled:opacity-50"
          title="Перенести сообщения и участников из дублей авточатов в один чат"
        >
          {merging ? 'Объединяем…' : 'Объединить дубли'}
        </button>
      </div>
      <div className="text-[13px] text-text-muted">Всего чатов: {filtered.length}</div>

      {loading && <p className="text-[13px] text-text-muted">Загрузка…</p>}

      <div className="space-y-2">
        {filtered.map((c) => (
          <div key={c.id} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                {KIND_LABEL[c.kind] ?? c.kind}
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-text">
                {c.title || (c.kind === 'direct' ? 'Личный диалог' : 'Без названия')}
                {c.target ? ` · ${c.target}` : ''}
              </span>
              {c.pinned && <span className="text-[11px] text-accent">закреплён</span>}
              <span className="text-[12px] text-text-muted">{c.participants.length} уч.</span>
              <span className="text-[12px] text-text-muted">{c.messageCount} сообщ.</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                variant="secondary"
                className="!py-1 !text-[12px]"
                onClick={() => setExpanded(expanded === c.id ? null : c.id)}
              >
                <Users size={13} />
                {expanded === c.id ? 'Скрыть участников' : 'Участники'}
              </Button>
              <Button variant="secondary" className="!py-1 !text-[12px]" onClick={() => void pin(c)}>
                {c.pinned ? 'Открепить' : 'Закрепить'}
              </Button>
              <Button variant="danger" className="!py-1 !text-[12px]" onClick={() => void remove(c)}>
                <Trash2 size={13} />
                Удалить
              </Button>
            </div>
            {expanded === c.id && (
              <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded border border-border bg-bg p-2 text-[12px] text-text-muted">
                {c.participants.map((p) => (
                  <div key={p} className="truncate">
                    {nameById.get(p) ?? p}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {!loading && filtered.length === 0 && (
          <p className="py-6 text-center text-[13px] text-text-muted">Чатов не найдено</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Оповещения

function BroadcastsTab({
  setNotice,
  setError,
}: {
  setNotice: (v: string | null) => void;
  setError: (v: string | null) => void;
}) {
  const [items, setItems] = useState<db.AdminBroadcastRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await db.adminGetBroadcasts());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить оповещения');
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const TARGET_LABEL: Record<string, string> = {
    squad: 'взвод',
    course: 'курс',
    faculty: 'факультет',
    university: 'университет',
    custom: 'выборочно',
  };

  const remove = async (b: db.AdminBroadcastRow) => {
    if (!window.confirm('Удалить оповещение у всех получателей?')) return;
    try {
      await db.adminDeleteBroadcast(b.id);
      setNotice('Оповещение удалено.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить оповещение');
    }
  };

  const editText = async (b: db.AdminBroadcastRow) => {
    const text = window.prompt('Новый текст оповещения:', b.text);
    if (!text || text === b.text) return;
    try {
      await db.adminUpdateBroadcastText(b.id, text);
      setNotice('Текст оповещения обновлён.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить оповещение');
    }
  };

  const fmt = (ts: number) =>
    new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  if (loading) return <p className="text-[13px] text-text-muted">Загрузка…</p>;

  return (
    <div className="space-y-2">
      <div className="text-[13px] text-text-muted">Всего оповещений: {items.length}</div>
      {items.length === 0 && (
        <p className="py-6 text-center text-[13px] text-text-muted">Оповещений ещё не было</p>
      )}
      {items.map((b) => (
        <div key={b.id} className="rounded-lg border border-border bg-surface p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
            <span className="rounded bg-accent/15 px-1.5 py-0.5 font-medium text-accent">
              {TARGET_LABEL[b.targetType] ?? b.targetType}
              {b.targetValue ? `: ${b.targetValue}` : ''}
            </span>
            <span>{b.senderName}</span>
            <span>{fmt(b.createdAt)}</span>
            <span className="ml-auto">
              получателей {b.recipients} · прочитано {b.readCount}
            </span>
          </div>
          <div className="whitespace-pre-wrap break-words text-[14px] text-text">{b.text}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button variant="secondary" className="!py-1 !text-[12px]" onClick={() => void editText(b)}>
              <Pencil size={13} />
              Изменить текст
            </Button>
            <Button variant="danger" className="!py-1 !text-[12px]" onClick={() => void remove(b)}>
              <Trash2 size={13} />
              Удалить
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Журнал

function ComplaintsTab() {
  const [items, setItems] = useState<db.AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    db.getAuditLog({ action: 'Жалоба', limit: 200 })
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Не удалось загрузить жалобы');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-3">
      <div className="text-[13px] text-text-muted">
        Жалобы поступают из меню сообщения («Пожаловаться»). Всего: {items.length}
      </div>
      {error && <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-[13px] text-danger">{error}</div>}
      {loading && <div className="text-[13px] text-text-muted">Загрузка…</div>}
      {!loading && items.length === 0 && (
        <p className="py-6 text-center text-[13px] text-text-muted">Жалоб пока нет</p>
      )}
      {items.map((item) => (
        <div key={item.id} className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[14px] font-medium text-text">
              {item.actorName ?? 'Пользователь'}
            </span>
            <span className="text-[12px] text-text-muted">
              {new Date(item.createdAt).toLocaleString('ru-RU')}
            </span>
          </div>
          <div className="mt-1 text-[13px] text-text">{item.action}</div>
          <div className="mt-0.5 text-[12px] text-text-muted">
            Сообщение: {item.targetId ?? '—'} · {item.details ?? ''}
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditTab() {
  const [items, setItems] = useState<db.AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(
        await db.getAuditLog({
          actor: actor.trim() || undefined,
          action: action.trim() || undefined,
          from: dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : undefined,
          to: dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : undefined,
        }),
      );
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [actor, action, dateFrom, dateTo]);

  useEffect(() => {
    void load();
    // Перезагружаем при смене дат (в т.ч. быстрыми кнопками), фильтры
    // по пользователю и действию применяются кнопкой.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  const fmt = (ts: number) =>
    new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const setRange = (fromOffset: number, toOffset: number) => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(now.getDate() + fromOffset);
    const to = new Date(now);
    to.setDate(now.getDate() + toOffset);
    setDateFrom(ymd(from));
    setDateTo(ymd(to));
  };
  const RANGES = [
    { label: 'Сегодня', from: 0, to: 0 },
    { label: 'Вчера', from: -1, to: -1 },
    { label: '7 дней', from: -6, to: 0 },
    { label: '30 дней', from: -29, to: 0 },
  ] as const;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <button
            key={r.label}
            type="button"
            onClick={() => setRange(r.from, r.to)}
            className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-text hover:bg-surface"
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Пользователь (ФИО)"
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] text-text"
        />
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Действие (например, вход)"
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] text-text"
        />
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] text-text"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] text-text"
        />
      </div>
      <Button variant="secondary" className="!py-1.5 !text-[13px]" onClick={() => void load()}>
        Применить фильтры
      </Button>

      {loading && <p className="text-[13px] text-text-muted">Загрузка…</p>}

      <div className="space-y-1.5">
        {!loading && items.length === 0 && (
          <p className="py-6 text-center text-[13px] text-text-muted">Записей нет</p>
        )}
        {items.map((e) => (
          <div key={e.id} className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text">{e.action}</span>
              <span className="text-text-muted">{e.actorName ?? '—'}</span>
              <span className="ml-auto tabular-nums text-text-muted">{fmt(e.createdAt)}</span>
            </div>
            {(e.targetType || e.details) && (
              <div className="mt-0.5 text-[12px] text-text-muted">
                {e.targetType ? `${e.targetType}: ` : ''}
                {e.details ?? e.targetId ?? ''}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Структура

function StructureTab({
  setNotice,
  setError,
}: {
  setNotice: (v: string | null) => void;
  setError: (v: string | null) => void;
}) {
  const [items, setItems] = useState<db.DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await db.getDepartments());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить структуру');
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const KIND_LABEL: Record<string, string> = {
    university: 'руководство',
    institute: 'институт',
    faculty: 'факультет',
    department: 'кафедра',
    unit: 'управление / отдел',
    center: 'центр',
    library: 'библиотека',
    club: 'клуб',
    clinic: 'поликлиника',
    veterans: 'ветеранская организация',
    committee: 'комитет',
  };

  const add = async () => {
    if (!newName.trim()) return;
    try {
      await db.adminAddDepartment(newName.trim());
      setNotice('Подразделение добавлено.');
      setNewName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось добавить подразделение');
    }
  };

  const rename = async (d: db.DepartmentRow) => {
    const name = window.prompt('Новое название подразделения:', d.name);
    if (!name || name === d.name) return;
    try {
      await db.adminRenameDepartment(d.id, name);
      setNotice('Название обновлено.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось переименовать');
    }
  };

  const remove = async (d: db.DepartmentRow) => {
    if (!window.confirm(`Удалить подразделение «${d.name}»?`)) return;
    try {
      await db.adminDeleteDepartment(d.id);
      setNotice('Подразделение удалено.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Название нового подразделения"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text"
        />
        <Button onClick={() => void add()} className="!py-2 !text-[13px]">
          Добавить
        </Button>
      </div>

      {loading && <p className="text-[13px] text-text-muted">Загрузка…</p>}

      <div className="space-y-1.5">
        {items.map((d) => (
          <div
            key={d.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
          >
            <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">
              {KIND_LABEL[d.kind] ?? d.kind}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-text">{d.name}</span>
            <button
              type="button"
              onClick={() => void rename(d)}
              className="rounded p-1 text-text-muted hover:text-text"
              aria-label="Переименовать"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => void remove(d)}
              className="rounded p-1 text-danger/80 hover:text-danger"
              aria-label="Удалить"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Настройки

function SettingsTab({
  users,
  myId,
  setNotice,
  setError,
}: {
  users: User[];
  myId: string;
  setNotice: (v: string | null) => void;
  setError: (v: string | null) => void;
}) {
  const [settings, setSettings] = useState<db.AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await db.getAppSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = async (key: string, value: string) => {
    setSaving(true);
    try {
      await db.setAppSetting(key, value);
      await db.logAudit(myId, 'Изменение настроек', 'setting', key, value);
      setNotice('Настройка сохранена.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить настройку');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) return <p className="text-[13px] text-text-muted">Загрузка…</p>;

  const admins = users.filter((u) => u.role === 'admin' || (u.roleLevel ?? 1) >= 10);

  return (
    <div className="space-y-3">
      <ToggleRow
        title="Регистрация новых пользователей"
        description="По умолчанию выключена: новые аккаунты создаёт администратор."
        checked={settings.registrationEnabled}
        disabled={saving}
        onChange={(v) => void update('registration_enabled', String(v))}
      />
      <ToggleRow
        title="Глобальное отключение чатов"
        description="Режим «только оповещения»: отправка сообщений в чатах блокируется."
        checked={settings.chatsDisabled}
        disabled={saving}
        onChange={(v) => void update('chats_disabled', String(v))}
      />
      <ToggleRow
        title="Технический режим"
        description="Диагностические подписи (ID чатов и сообщений) для администратора."
        checked={settings.techMode}
        disabled={saving}
        onChange={(v) => void update('tech_mode', String(v))}
      />
      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="mb-1 text-[14px] font-medium text-text">Главный администратор</div>
        <div className="mb-2 text-[12px] text-text-muted">
          Учётная запись, которой принадлежит управление системой.
        </div>
        <select
          value={settings.mainAdminId}
          disabled={saving}
          onChange={(e) => void update('main_admin_id', e.target.value)}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[14px] text-text"
        >
          <option value="">— не назначен —</option>
          {admins.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName} (@{u.login})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-text">{title}</div>
        <div className="text-[12px] text-text-muted">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-border'
        } disabled:opacity-50`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-5.5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function SecurityTab() {
  const [events, setEvents] = useState<db.LoginEvent[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setError(null);
    Promise.all([db.getLoginEvents(100), db.getAllUsers()])
      .then(([list, all]) => {
        setEvents(list);
        setUsers(all);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить журнал входов'));
  };

  useEffect(load, []);

  const setBlocked = async (login: string, blocked: boolean) => {
    const user = users.find((u) => u.login === login);
    if (!user) {
      setError(`Пользователь ${login} не найден`);
      return;
    }
    setBusy(login + String(blocked));
    try {
      await db.adminSetUserBlocked(user.id, blocked, blocked ? 'Заблокирован администратором' : undefined);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить блокировку');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[15px] font-medium text-text">Входы и блокировки</div>
          <div className="text-[12px] text-text-muted">
            Неверные пароли, новые устройства и геолокация. Всего записей: {events.length}
          </div>
        </div>
        <Button variant="secondary" onClick={load}>Обновить</Button>
      </div>
      {error && <div className="rounded-lg border border-danger/40 px-3 py-2 text-[13px] text-danger">{error}</div>}
      {events.length === 0 && !error && (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-[13px] text-text-muted">
          Журнал пуст. Примените supabase/security_logins.sql и войдите заново.
        </div>
      )}
      <div className="space-y-2">
        {events.map((event) => (
          <div key={event.id} className="rounded-lg border border-border bg-bg p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[14px] text-text">
                  {event.login}
                  <span className={`ml-2 text-[12px] ${event.success ? 'text-green-600' : 'text-danger'}`}>
                    {event.success ? 'успешный вход' : 'неудачная попытка'}
                  </span>
                </div>
                <div className="text-[12px] text-text-muted">
                  {new Date(event.createdAt).toLocaleString('ru-RU')}
                  {event.ip ? ` · IP ${event.ip}` : ''}
                  {event.geo ? ` · ${event.geo}` : ''}
                </div>
                {event.reason && <div className="text-[12px] text-text-muted">{event.reason}</div>}
                {event.device && <div className="truncate text-[11px] text-text-muted">{event.device}</div>}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void setBlocked(event.login, true)}
                >
                  Заблокировать
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void setBlocked(event.login, false)}
                >
                  Разблокировать
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
