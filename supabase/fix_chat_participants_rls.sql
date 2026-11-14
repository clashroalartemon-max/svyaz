-- Баг 1: создатель личного чата не мог добавить участников.
-- Разрешаем: себя, владельца чата, действующего участника и первого участника
-- пустого чата (создание личного чата: чат уже создан, участников ещё нет).
drop policy if exists participants_insert on public.chat_participants;
create policy participants_insert on public.chat_participants for insert
  with check (
    public.current_user_id() is not null
    and (
      user_id = public.current_user_id()
      or exists (
        select 1 from public.chats c
         where c.id = chat_id and c.owner_id = public.current_user_id()
      )
      or public.is_chat_member(chat_id, public.current_user_id())
      or not exists (
        select 1 from public.chat_participants p where p.chat_id = chat_participants.chat_id
      )
    )
  );

grant select, insert, update, delete on public.chat_participants to authenticated;
