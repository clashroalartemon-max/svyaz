import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // host: true — слушаем все интерфейсы, чтобы открыть приложение с телефона
    // по http://<IP-компьютера>:5173 (см. README)
    host: true,
    port: 5173,
    strictPort: true,
    // Туннель к публичному HTTPS-адресу. Vite 6+ блокирует незнакомые Host и
    // отвечает 403 «Blocked request» — из-за этого сайт не открывался с другого
    // устройства по ссылке туннеля. Список доменов не помогает (они случайные:
    // xxx.trycloudflare.com, xxx.tunnelmole.net), поэтому true — любой Host.
    allowedHosts: true,
  },
  preview: {
    // preview нужен для «боевого» режима: отдаём уже собранный dist
    // (один бандл вместо сотен модулей dev-сервера) — по туннелю с телефона
    // грузится в разы быстрее.
    host: true,
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
});
