import { useParams } from 'react-router-dom';
import { Chat } from '../components/Chat';
import { MainPage } from './MainPage';
import { useMediaQuery } from '../hooks';

/**
 * Отдельный роут чата.
 *
 * Мобильный (<900px): показывается ТОЛЬКО панель чата с кнопкой «Назад»,
 * список чатов живёт на /main — две панели на узком экране не помещаются.
 *
 * Десктоп: тот же двухпанельный экран, что и /main, но с открытым чатом —
 * так переход из поиска сотрудников не «теряет» список переписок.
 */
export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const isDesktop = useMediaQuery('(min-width: 900px)');

  if (!id) return null;

  if (isDesktop) {
    return <MainPage initialChatId={id} />;
  }

  return (
    <div className="h-full bg-bg">
      <Chat chatId={id} showBack />
    </div>
  );
}
