import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import * as db from '../lib/db';
import { useAuth } from '../hooks';
import { Button, Input } from '../ui';

export function LoginPage() {
  const userId = useAuth();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (userId) return <Navigate to="/main" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!login.trim() || !password) {
      setError('Введите логин и пароль');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const user = await db.verifyLogin(login.trim(), password);
      if (!user) {
        setError('Неверный логин или пароль');
        return;
      }
      db.setCurrentUserId(user.id);
      void db.registerSession(user.id);
      // редирект произойдёт через useAuth
    } catch (err) {
      setError(
        err instanceof Error
          ? `Не удалось войти: ${err.message}`
          : 'Не удалось войти. Попробуйте ещё раз',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[340px]">
        <div className="mb-8 text-center">
          <div className="text-[22px] font-semibold text-text">Связь</div>
          <div className="text-[13px] text-text-muted">Закрытая система</div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input
            label="Логин"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="cadet001"
            autoFocus
            autoComplete="username"
          />
          <Input
            label="Пароль"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
          />
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Проверка…' : 'Войти'}
          </Button>
        </form>
      </div>

      <p className="mt-10 max-w-[340px] text-center text-[13px] text-text-muted">
        Тест: cadet001 / test1234, admin / admin12345
      </p>
    </div>
  );
}
