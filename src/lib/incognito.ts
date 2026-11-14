import * as storage from './storage';
import { emit } from './bus';

/** Режим инкогнито: в списке чатов не показываем текст последнего сообщения. */
const KEY = 'svyaz.incognito';

export function isIncognito(): boolean {
  return storage.readJson<boolean>(KEY) === true;
}

export function setIncognito(enabled: boolean): void {
  storage.writeJson(KEY, enabled);
  emit('settings:changed', { incognito: enabled });
}
