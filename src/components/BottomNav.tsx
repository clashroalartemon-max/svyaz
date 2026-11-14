import { useState } from 'react';
import {
  Archive,
  Building2,
  MessageCircle,
  Megaphone,
  MoreHorizontal,
  Plus,
  Settings,
  Users,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

const ITEMS = [
  { key: 'chats', label: 'Чаты', icon: MessageCircle, to: '/main' },
  { key: 'create', label: 'Создать', icon: Plus, to: '/main?new=1' },
  { key: 'alerts', label: 'Оповещения', icon: Megaphone, to: '/main?panel=notifications' },
  { key: 'more', label: 'Ещё', icon: MoreHorizontal, to: '' },
] as const;

const MORE_ITEMS = [
  { label: 'Контакты', icon: Users, to: '/contacts' },
  { label: 'Настройки', icon: Settings, to: '/settings' },
  { label: 'Структура', icon: Building2, to: '/structure' },
  { label: 'Архив', icon: Archive, to: '/main?archive=1' },
] as const;

/**
 * Компактная нижняя панель (50px): 4 вкладки, лишнее — в шторке «Ещё».
 * Так на экране остаются только чаты, создание, оповещения и вход в остальное.
 */
export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);

  if (location.pathname === '/login' || location.pathname.startsWith('/chat/')) return null;

  const params = new URLSearchParams(location.search);
  const alertsOpen = location.pathname === '/main' && params.get('panel') === 'notifications';
  const createOpen = location.pathname === '/main' && params.get('new') === '1';
  const archiveOpen = location.pathname === '/main' && params.get('archive') === '1';
  const extraPage = ['/contacts', '/settings', '/structure'].includes(location.pathname) || archiveOpen;

  const isActive = (key: string): boolean => {
    if (key === 'chats') return location.pathname === '/main' && !alertsOpen && !createOpen && !archiveOpen;
    if (key === 'create') return createOpen;
    if (key === 'alerts') return alertsOpen;
    if (key === 'more') return moreOpen || extraPage;
    return false;
  };

  const go = (to: string) => {
    setMoreOpen(false);
    navigate(to);
  };

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-[60] min-[900px]:hidden" role="dialog" aria-label="Дополнительное меню">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Закрыть меню"
            onClick={() => setMoreOpen(false)}
          />
          <div
            className="absolute inset-x-0 bottom-[50px] rounded-t-2xl border-t border-border bg-bg p-2 shadow-xl"
            style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
          >
            <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-border" />
            <div className="grid grid-cols-2 gap-1">
              {MORE_ITEMS.map(({ label, icon: Icon, to }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => go(to)}
                  className="flex items-center gap-2 rounded-lg px-3 py-3 text-left text-[14px] text-text hover:bg-surface"
                >
                  <Icon size={18} className="text-text-muted" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav
        className="shrink-0 border-t border-border bg-bg/95 backdrop-blur min-[900px]:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Основная навигация"
      >
        <div className="grid grid-cols-4">
          {ITEMS.map(({ key, label, icon: Icon, to }) => {
            const active = isActive(key);
            const create = key === 'create';
            return (
              <button
                key={key}
                type="button"
                onClick={() => (key === 'more' ? setMoreOpen((value) => !value) : go(to))}
                className={`flex min-h-[50px] flex-col items-center justify-center gap-0.5 text-[10px] ${
                  active ? 'text-accent' : 'text-text-muted'
                }`}
                aria-current={active ? 'page' : undefined}
                aria-expanded={key === 'more' ? moreOpen : undefined}
              >
                <span
                  className={
                    create
                      ? 'flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white'
                      : ''
                  }
                >
                  <Icon size={create ? 18 : 19} strokeWidth={active ? 2.2 : 1.8} />
                </span>
                {label}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
