import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, ChevronDown, ChevronRight, Search, Users } from 'lucide-react';
import * as db from '../lib/db';
import type { DepartmentRow, PositionRow } from '../lib/db';
import type { User } from '../types';

const KIND_TABS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'university', label: 'Руководство' },
  { key: 'institute', label: 'Институты' },
  { key: 'faculty', label: 'Факультеты' },
  { key: 'department', label: 'Кафедры' },
  { key: 'unit', label: 'Подразделения' },
];

/** Русские подписи для всех видов подразделений, включая служебные. */
const KIND_LABELS: Record<string, string> = {
  university: 'Руководство',
  institute: 'Институты',
  faculty: 'Факультеты',
  department: 'Кафедры',
  unit: 'Подразделения',
  center: 'Центры',
  library: 'Библиотека',
  club: 'Спортивный клуб',
  committee: 'Профсоюзная организация',
  clinic: 'Поликлиника',
  veterans: 'Ветеранская организация',
};

/** Порядок групп в дереве: от руководства к вспомогательным службам. */
const KIND_ORDER = [
  'university',
  'institute',
  'faculty',
  'department',
  'unit',
  'center',
  'library',
  'club',
  'committee',
  'clinic',
  'veterans',
];

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function StructurePage() {
  const navigate = useNavigate();
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [people, setPeople] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [depts, pos, users] = await Promise.all([
          db.getDepartments(),
          db.getPositions(),
          db.getAllUsers(),
        ]);
        if (!alive) return;
        setDepartments(depts);
        setPositions(pos);
        setPeople(users);
      } catch (e) {
        if (!alive) return;
        console.warn('structure load failed', e);
        setError(
          'Структура ещё не загружена в базу. Выполните supabase/seed_university.sql в Supabase → SQL Editor.',
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const positionsByDept = useMemo(() => {
    const map = new Map<string, PositionRow[]>();
    for (const p of positions) {
      if (!p.departmentId) continue;
      const list = map.get(p.departmentId) ?? [];
      list.push(p);
      map.set(p.departmentId, list);
    }
    return map;
  }, [positions]);

  /** Люди по подразделению: основная привязка — profiles.department. */
  const peopleByDept = useMemo(() => {
    const map = new Map<string, User[]>();
    for (const u of people) {
      // В структуре показываем только людей с должностью: технические
      // аккаунты без должности (admin) в дерево не попадают.
      if (!norm(u.position)) continue;
      const key = norm(u.department);
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(u);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
    }
    return map;
  }, [people]);

  /** Люди с должностью, но без подразделения (старая база). */
  const unassigned = useMemo(
    () =>
      people
        .filter((u) => !norm(u.department) && (u.position || u.rank))
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    [people],
  );

  const q = norm(query);

  const visibleDepartments = useMemo(
    () =>
      departments.filter((d) => {
        if (tab !== 'all' && d.kind !== tab) return false;
        if (!q) return true;
        const deptPeople = peopleByDept.get(norm(d.name)) ?? [];
        const pos = positionsByDept.get(d.id) ?? [];
        return (
          norm(d.name).includes(q) ||
          pos.some((p) => norm(p.name).includes(q)) ||
          deptPeople.some(
            (u) => norm(u.fullName).includes(q) || norm(u.position).includes(q),
          )
        );
      }),
    [departments, tab, q, peopleByDept, positionsByDept],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, DepartmentRow[]>();
    for (const d of visibleDepartments) {
      const list = map.get(d.kind) ?? [];
      list.push(d);
      map.set(d.kind, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      const ia = KIND_ORDER.indexOf(a);
      const ib = KIND_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [visibleDepartments]);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalPeople = people.filter((u) => u.position || u.rank).length;

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={() => navigate('/main')}
          className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Назад"
        >
          <ArrowLeft size={18} />
        </button>
        <Building2 size={18} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-text">
            Структура университета
          </div>
          <div className="truncate text-[12px] text-text-muted">
            Московский университет МВД России имени В.Я. Кикотя
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-1.5 text-[12px] text-text-muted sm:flex">
          <Users size={14} />
          {totalPeople} чел.
        </div>
      </header>

      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {KIND_TABS.map(({ key, label }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={active}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-[13px] ${
                active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface hover:text-text'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="shrink-0 border-b border-border p-3">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по подразделению, должности или ФИО"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-[15px] text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && <div className="p-4 text-[13px] text-text-muted">Загрузка структуры…</div>}

        {!loading && error && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-[13px] text-text">
            {error}
          </div>
        )}

        {!loading && !error && visibleDepartments.length === 0 && (
          <div className="p-4 text-[13px] text-text-muted">Ничего не найдено.</div>
        )}

        <div className="flex flex-col gap-4">
          {grouped.map(([kind, depts]) => (
            <section key={kind}>
              <div className="mb-1.5 px-1 text-[12px] font-medium uppercase tracking-wide text-text-muted">
                {KIND_LABELS[kind] ?? KIND_TABS.find((t) => t.key === kind)?.label ?? kind}
              </div>
              <div className="overflow-hidden rounded-xl border border-border">
                {depts.map((dept) => {
                  const deptPositions = positionsByDept.get(dept.id) ?? [];
                  const deptPeople = peopleByDept.get(norm(dept.name)) ?? [];
                  const isOpen = !collapsed.has(dept.id);
                  return (
                    <div key={dept.id} className="border-b border-border last:border-b-0">
                      <button
                        type="button"
                        onClick={() => toggle(dept.id)}
                        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-surface"
                        aria-expanded={isOpen}
                      >
                        {isOpen ? (
                          <ChevronDown size={16} className="mt-0.5 shrink-0 text-text-muted" />
                        ) : (
                          <ChevronRight size={16} className="mt-0.5 shrink-0 text-text-muted" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-medium text-text">
                            {dept.name}
                          </span>
                          <span className="mt-0.5 block text-[12px] text-text-muted">
                            {deptPeople.length > 0
                              ? `${deptPeople.length} чел.`
                              : deptPositions.length > 0
                                ? `${deptPositions.length} должн.`
                                : 'нет данных'}
                          </span>
                        </span>
                      </button>

                      {isOpen && (
                        <div className="px-3 pb-3 pl-9">
                          {deptPeople.length > 0 && (
                            <ul className="mb-2 flex flex-col gap-1">
                              {deptPeople.map((u) => (
                                <li key={u.id} className="flex flex-wrap items-baseline gap-x-2">
                                  <span className="text-[13px] text-text">{u.fullName}</span>
                                  {u.rank && (
                                    <span className="text-[12px] text-text-muted">{u.rank}</span>
                                  )}
                                  {u.position && (
                                    <span className="text-[12px] text-accent">{u.position}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                          {deptPositions.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {deptPositions.map((p) => (
                                <span
                                  key={p.id}
                                  className="rounded-md border border-border px-2 py-0.5 text-[12px] text-text-muted"
                                >
                                  {p.name}
                                </span>
                              ))}
                            </div>
                          )}
                          {deptPeople.length === 0 && deptPositions.length === 0 && (
                            <div className="text-[12px] text-text-muted">
                              Должности и сотрудники не заполнены.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {!loading && !error && unassigned.length > 0 && (tab === 'all' || tab === 'university') && (
            <section>
              <div className="mb-1.5 px-1 text-[12px] font-medium uppercase tracking-wide text-text-muted">
                Без подразделения
              </div>
              <div className="rounded-xl border border-border px-3 py-2.5">
                <ul className="flex flex-col gap-1">
                  {unassigned.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[13px] text-text">{u.fullName}</span>
                      {u.rank && <span className="text-[12px] text-text-muted">{u.rank}</span>}
                      {u.position && <span className="text-[12px] text-accent">{u.position}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
