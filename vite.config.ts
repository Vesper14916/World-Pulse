import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { worldPulseApiPlugin } from './server/world-pulse/plugin';

function pulsePages(): Plugin {
  return {
    name: 'world-pulse-pages',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        if (pathname === '/') {
          response.statusCode = 302;
          response.setHeader('Location', '/world');
          response.end();
          return;
        }
        if (!['/world', '/portfolio', '/explore', '/command'].includes(pathname)) return next();
        try {
          const html = await server.transformIndexHtml(
            pathname,
            await readFile(resolve('world-pulse.html'), 'utf8'),
          );
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(html);
        } catch (error) {
          next(error as Error);
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        if (pathname === '/') request.url = '/world';
        else if (['/world', '/portfolio', '/explore', '/command'].includes(pathname))
          request.url = '/world-pulse.html';
        next();
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (['/world', '/portfolio', '/explore', '/command', '/world-pulse.html'].includes(context.path))
          return html.replace(/<title>.*?<\/title>/, '<title>World Pulse</title>');
        return html;
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    envPrefix: 'VITE_PULSE_PUBLIC_',
    plugins: [pulsePages(), worldPulseApiPlugin(env)],
    server: {
      host: '127.0.0.1',
      port: Number(env.PULSE_PORT || 3000),
      strictPort: true,
      open: false,
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    build: {
      outDir: 'dist',
      rollupOptions: { input: { pulse: resolve('world-pulse.html') } },
    },
  };
});
