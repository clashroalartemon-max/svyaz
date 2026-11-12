import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../hooks';
import type { ThemeMode } from '../types';

const NEXT: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const LABEL: Record<ThemeMode, string> = {
  light: 'Светлая тема',
  dark: 'Тёмная тема',
  system: 'Системная тема',
};

/** Переключение темы по кругу: светлая → тёмная → системная */
export function ThemeToggle() {
  const [mode, setMode] = useTheme();

  return (
    <button
      type="button"
      onClick={() => setMode(NEXT[mode])}
      className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface hover:text-text"
      title={`${LABEL[mode]}. Нажмите, чтобы переключить`}
      aria-label="Переключить тему"
    >
      {mode === 'light' && <Sun size={18} />}
      {mode === 'dark' && <Moon size={18} />}
      {mode === 'system' && <Monitor size={18} />}
    </button>
  );
}
