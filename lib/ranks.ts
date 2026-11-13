import type { Rank } from '../types';

/**
 * Логика званий курсантов по курсу обучения (внутренний устав училища МВД).
 *
 *  1-й курс — все носят погоны курсанта (включая командиров отделения и взвода);
 *  2-й курс — командиры (отделения, зам. командира взвода) — младший сержант,
 *             остальные — рядовой;
 *  3-й курс — командиры — сержант, остальные — рядовой;
 *  4-й курс — ВСЕ выпускники — младший лейтенант.
 *
 * Администратор может переопределить звание вручную: авто-логика лишь
 * подставляет значение по умолчанию.
 */

/** Должности, которые считаются «командными» для авто-званий. */
const COMMAND_POSITIONS = ['командир отделения', 'заместитель командира взвода'];

/** Должности из курсантского состава — для них работает авто-логика. */
const CADET_POSITIONS = [
  'курсант',
  'староста группы',
  'командир отделения',
  'заместитель командира взвода',
];

/** Является ли должность командной (командир отделения / замкомвзвода). */
export function isCommandPosition(position?: string | null): boolean {
  if (!position) return false;
  const p = position.trim().toLowerCase();
  return COMMAND_POSITIONS.some((c) => p.includes(c));
}

/**
 * Офицерская/служебная должность: авто-звание по курсу к ней не применяется,
 * иначе подполковник-начальник курса превратился бы в рядового.
 */
export function isOfficerPosition(position?: string | null): boolean {
  if (!position) return false;
  const p = position.trim().toLowerCase();
  return !CADET_POSITIONS.some((c) => p === c);
}

/**
 * Курс по названию взвода.
 *  • «152 взвод» → 2-й курс (последняя цифра номера — курс);
 *  • «1 взвод» … «25 взвод» → 1-й курс, «26»…«50» → 2-й и т. д.
 * Результат ограничен 1…4.
 */
export function courseFromGroup(group?: string | null): number {
  if (!group) return 1;
  const digits = (group.match(/\d+/g) ?? []).join('');
  if (!digits) return 1;

  if (digits.length >= 3) {
    const last = Number(digits.slice(-1));
    if (last >= 1 && last <= 4) return last;
    return 1;
  }

  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return 1;
  const course = Math.ceil(n / 25);
  return Math.min(4, Math.max(1, course));
}

/**
 * Звание по умолчанию для курсанта: курс + должность.
 * Возвращает базовое название без «полиции» — при выводе добавляется автоматически.
 */
export function autoAssignRank(course: number, position?: string | null): Rank {
  const c = Math.min(4, Math.max(1, Math.round(course)));
  const command = isCommandPosition(position);

  if (c === 1) return 'курсант';
  if (c === 2) return command ? 'младший сержант' : 'рядовой';
  if (c === 3) return command ? 'сержант' : 'рядовой';
  return 'младший лейтенант';
}

/**
 * Удобная обёртка: звание по названию взвода и должности.
 * Для офицерских должностей возвращает текущее звание без изменений.
 */
export function autoAssignRankForGroup(
  group?: string | null,
  position?: string | null,
  current?: string | null,
): string {
  if (isOfficerPosition(position)) return (current ?? '').trim();
  return autoAssignRank(courseFromGroup(group), position);
}
