import { describe, expect, it } from 'vitest';
import { autoAssignRank, courseFromGroup, isCommandPosition, isOfficerPosition } from './ranks';

describe('courseFromGroup', () => {
  it('трёхзначный номер взвода — последняя цифра', () => {
    expect(courseFromGroup('152 взвод')).toBe(2);
    expect(courseFromGroup('141 взвод')).toBe(1);
    expect(courseFromGroup('433')).toBe(3);
  });

  it('короткие номера — по 25 взводов на курс', () => {
    expect(courseFromGroup('1 взвод')).toBe(1);
    expect(courseFromGroup('25 взвод')).toBe(1);
    expect(courseFromGroup('26 взвод')).toBe(2);
    expect(courseFromGroup('76 взвод')).toBe(4);
  });

  it('мусор и пустое значение — первый курс', () => {
    expect(courseFromGroup('')).toBe(1);
    expect(courseFromGroup(null)).toBe(1);
    expect(courseFromGroup('ППС')).toBe(1);
  });
});

describe('autoAssignRank', () => {
  it('1 курс — все курсанты', () => {
    expect(autoAssignRank(1, 'командир отделения')).toBe('курсант');
    expect(autoAssignRank(1, 'курсант')).toBe('курсант');
  });

  it('2 курс — командиры младшие сержанты, остальные рядовые', () => {
    expect(autoAssignRank(2, 'командир отделения')).toBe('младший сержант');
    expect(autoAssignRank(2, 'заместитель командира взвода')).toBe('младший сержант');
    expect(autoAssignRank(2, 'курсант')).toBe('рядовой');
  });

  it('3 курс — командиры сержанты', () => {
    expect(autoAssignRank(3, 'командир отделения')).toBe('сержант');
    expect(autoAssignRank(3, 'курсант')).toBe('рядовой');
  });

  it('4 курс — все младшие лейтенанты', () => {
    expect(autoAssignRank(4, 'курсант')).toBe('младший лейтенант');
    expect(autoAssignRank(4, 'командир отделения')).toBe('младший лейтенант');
  });
});

describe('должности', () => {
  it('командные определяются', () => {
    expect(isCommandPosition('командир отделения')).toBe(true);
    expect(isCommandPosition('заместитель командира взвода')).toBe(true);
    expect(isCommandPosition('курсант')).toBe(false);
  });

  it('офицерские должности не попадают под авто-звания', () => {
    expect(isOfficerPosition('начальник курса')).toBe(true);
    expect(isOfficerPosition('командир взвода')).toBe(true);
    expect(isOfficerPosition('курсант')).toBe(false);
    expect(isOfficerPosition('')).toBe(false);
  });
});
