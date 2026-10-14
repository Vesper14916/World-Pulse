import { MaritimeService } from './maritime';
import { strategicArea } from '../../shared/world-pulse-strategic';
import { COMMAND_RETENTION_MS } from '../../shared/world-pulse-command';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { PulseError, WorldPulseService } from './service';
import {
  parseTokenPrice,
  validChatCompletionsUrl,
} from './ai-config';

function localHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/'
    );
  } catch {
    return false;
  }
}
function reply(
  response: ServerResponse,
  status: number,
  value: unknown,
  request?: IncomingMessage,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const body = JSON.stringify(value);
  // Snapshots run to several megabytes; compress them for the browser.
  if (body.length > 65_536 && /\bgzip\b/.test(String(request?.headers['accept-encoding'] ?? ''))) {
    response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Vary', 'Accept-Encoding');
    response.end(gzipSync(body, { level: 4 }));
    return;
  }
  response.end(body);
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new PulseError(415, 'Use application/json.');
  let size = 0,
    body = '';
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw new PulseError(413, 'Request body is too large.');
    body += chunk.toString();
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new PulseError(400, 'Invalid JSON body.');
  }
}
export function worldPulseMiddleware(
  service: WorldPulseService,
  maritime?: MaritimeService,
  configDirectory = process.cwd(),
) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const path = (request.url ?? '').split('?')[0];
    if (!path?.startsWith('/api/world-pulse/')) {
      next();
      return;
    }
    void (async () => {
      if (!localHost(request.headers.host))
        throw new PulseError(403, 'This API is available only on the local host.');
      const origin = request.headers.origin;
      if (
        origin &&
        origin !== `http://${request.headers.host}` &&
        origin !== `https://${request.headers.host}`
      )
        throw new PulseError(403, 'Cross-origin requests are not allowed.');
      if (path === '/api/world-pulse/ai-config' && request.method === 'GET') {
        reply(response, 200, service.aiConfiguration());
      } else if (path === '/api/world-pulse/ai-config' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new PulseError(400, 'Provide an AI configuration update.');
        const data = body as Record<string, unknown>;
        const clearing = data.clearApiKey === true;
        if (clearing) {
          if (Object.keys(data).length !== 1)
            throw new PulseError(400, 'Clear the saved API key as a separate operation.');
        } else {
          const allowed = new Set([
            'apiUrl',
            'model',
            'apiKey',
            'inputPricePerMillion',
            'outputPricePerMillion',
          ]);
          if (
            Object.keys(data).some((key) => !allowed.has(key)) ||
            typeof data.apiUrl !== 'string' ||
            typeof data.model !== 'string' ||
            typeof data.inputPricePerMillion !== 'string' ||
            typeof data.outputPricePerMillion !== 'string' ||
            (data.apiKey !== undefined && typeof data.apiKey !== 'string')
          )
            throw new PulseError(400, 'Check the endpoint, model, key, and token prices.');
        }
        let result: ReturnType<WorldPulseService['aiConfiguration']>;
        if (clearing) {
          try {
            result = service.saveAIConfiguration(configDirectory, { clearApiKey: true });
          } catch {
            throw new PulseError(500, 'The local AI configuration could not be saved.');
          }
        } else {
          const apiUrl = (data.apiUrl as string).trim();
          const model = (data.model as string).trim();
          const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
          const inputPrice = parseTokenPrice(data.inputPricePerMillion);
          const outputPrice = parseTokenPrice(data.outputPricePerMillion);
          if (
            (apiUrl && !validChatCompletionsUrl(apiUrl)) ||
            model.length > 200 ||
            /[\u0000-\u001f\u007f]/.test(model) ||
            apiKey.length > 4096 ||
            /[\r\n\u0000]/.test(apiKey) ||
            (data.inputPricePerMillion !== '' && inputPrice === null) ||
            (data.outputPricePerMillion !== '' && outputPrice === null)
          )
            throw new PulseError(400, 'Check the endpoint, model, key, and token prices.');
          try {
            result = service.saveAIConfiguration(configDirectory, {
              apiUrl,
              model,
              ...(apiKey ? { apiKey } : {}),
              inputPricePerMillion: inputPrice,
              outputPricePerMillion: outputPrice,
            });
          } catch {
            throw new PulseError(500, 'The local AI configuration could not be saved.');
          }
        }
        reply(response, 200, result);
      } else if (['/api/world-pulse/situation','/api/world-pulse/maritime','/api/world-pulse/timeline'].includes(path) && request.method === 'GET') {
        if (!maritime) throw new PulseError(503, 'Maritime observations are not running.');
        const q = new URL(request.url!, 'http://localhost').searchParams;
        const region=q.get('region')||'global';
        if(!strategicArea(region)) throw new PulseError(400,'Unknown observation area.');
        const now=Date.now();
        const parseTime=(name:string,fallback:number)=>{const raw=q.get(name);const t=raw===null?fallback:Date.parse(raw);if(!Number.isFinite(t)||t<now-COMMAND_RETENTION_MS||t>now+1000)throw new PulseError(400,'Time must be inside the retained seven-day window.');return Math.min(t,now);};
        if(path.endsWith('/situation')) reply(response,200,maritime.situation(),request);
        else if(path.endsWith('/timeline')) {
          const from=parseTime('from',now-COMMAND_RETENTION_MS+1000),to=parseTime('to',now);
          if(from>to)throw new PulseError(400,'Invalid time range.');
          reply(response,200,maritime.timeline(region,from,to),request);
        } else {
          const at=parseTime('at',now),mmsi=q.get('mmsi')||undefined;
          if(mmsi&&!/^\d{9}$/.test(mmsi))throw new PulseError(400,'Invalid vessel identity.');
          if(!q.has('at'))maritime.watch(region);
          reply(response,200,maritime.snapshot(region,at,mmsi),request);
        }
      } else if (path === '/api/world-pulse/events' && request.method === 'GET') {
        await service.refresh(
          new URL(request.url!, 'http://localhost').searchParams.get('refresh') === '1',
        );
        reply(response, 200, service.snapshot(), request);
      } else if (path === '/api/world-pulse/health' && request.method === 'GET')
        reply(response, 200, { ok: true, diagnostics: service.diagnostics() });
      else if (path === '/api/world-pulse/status' && request.method === 'GET')
        reply(response, 200, service.snapshot(), request);
      else if (path === '/api/world-pulse/filter' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new PulseError(400, 'Provide a filter update.');
        const data = body as Record<string, unknown>;
        if (
          Object.keys(data).some((k) => !['enabled', 'eventId'].includes(k)) ||
          Object.keys(data).length !== 1 ||
          (data.enabled !== undefined && typeof data.enabled !== 'boolean') ||
          (data.eventId !== undefined &&
            (typeof data.eventId !== 'string' || !/^[a-f0-9]{24}$/.test(data.eventId)))
        )
          throw new PulseError(400, 'Provide enabled or eventId.');
        reply(
          response,
          200,
          service.filtering(
            data.enabled as boolean | undefined,
            data.eventId as string | undefined,
          ),
        );
      } else if (path === '/api/world-pulse/ai-control' && request.method === 'POST') {
        const body = await readBody(request);
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !('enabled' in body) ||
          typeof body.enabled !== 'boolean'
        )
          throw new PulseError(400, 'Provide only enabled.');
        reply(response, 200, service.setAIEnabled(body.enabled));
      } else if (path === '/api/world-pulse/companies' && request.method === 'GET')
        reply(
          response,
          200,
          await service.directory(
            new URL(request.url!, 'http://localhost').searchParams.get('q') ?? '',
          ),
        );
      else if (
        [
          '/api/world-pulse/company-data',
          '/api/world-pulse/article',
          '/api/world-pulse/assess',
          '/api/world-pulse/ai-test',
        ].includes(path) &&
        request.method === 'POST'
      ) {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new PulseError(400, 'Provide a JSON object.');
        const data = body as Record<string, unknown>;
        if (path.endsWith('/ai-test')) {
          if (Object.keys(data).length) throw new PulseError(400, 'No test payload is accepted.');
          reply(response, 200, await service.aiTest());
        } else if (path.endsWith('/company-data')) {
          if (
            Object.keys(data).some((k) => k !== 'companyId') ||
            typeof data.companyId !== 'string' ||
            data.companyId.length > 80
          )
            throw new PulseError(400, 'Provide only companyId.');
          reply(response, 200, await service.companyData(data.companyId));
        } else if (path.endsWith('/article')) {
          if (
            Object.keys(data).some((k) => !['eventId', 'reportId'].includes(k)) ||
            typeof data.eventId !== 'string' ||
            !/^[a-f0-9]{24}$/.test(data.eventId) ||
            (data.reportId !== undefined &&
              (typeof data.reportId !== 'string' ||
                data.reportId.length < 1 ||
                data.reportId.length > 500 ||
                !/^[a-zA-Z0-9:_-]+$/.test(data.reportId)))
          )
            throw new PulseError(400, 'Provide eventId and an optional reportId.');
          reply(response, 200, await service.article(data.eventId, data.reportId as string | undefined));
        } else {
          if (
            Object.keys(data).some((k) => !['eventId', 'companyId'].includes(k)) ||
            typeof data.eventId !== 'string' ||
            !/^[a-f0-9]{24}$/.test(data.eventId) ||
            (data.companyId !== undefined &&
              (typeof data.companyId !== 'string' || data.companyId.length > 80))
          )
            throw new PulseError(400, 'Provide eventId and optional companyId.');
          reply(
            response,
            200,
            await service.assess(data.eventId, data.companyId as string | undefined),
          );
        }
      } else if (
        ['/api/world-pulse/market', '/api/world-pulse/calendar', '/api/world-pulse/profile', '/api/world-pulse/prices', '/api/world-pulse/brief'].includes(path) &&
        request.method === 'POST'
      ) {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new PulseError(400, 'Provide a JSON object.');
        const data = body as Record<string, unknown>;
        if (path.endsWith('/brief')) {
          if (Object.keys(data).some((k) => k !== 'lines')) throw new PulseError(400, 'Provide only lines.');
          reply(response, 200, await service.polishBrief(data.lines));
        } else if (path.endsWith('/profile')) {
          if (Object.keys(data).some((k) => k !== 'symbol')) throw new PulseError(400, 'Provide only symbol.');
          reply(response, 200, await service.companyProfile(data.symbol));
        } else if (path.endsWith('/prices')) {
          if (Object.keys(data).some((k) => k !== 'lookups')) throw new PulseError(400, 'Provide only lookups.');
          reply(response, 200, service.pricesAt(data.lookups));
        } else {
          if (Object.keys(data).some((k) => k !== 'symbols')) throw new PulseError(400, 'Provide only symbols.');
          reply(
            response,
            200,
            path.endsWith('/market')
              ? await service.marketQuotes(data.symbols)
              : await service.marketCalendar(data.symbols),
          );
        }
      } else if (path === '/api/world-pulse/explain' && request.method === 'POST') {
        const body = await readBody(request);
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => key !== 'eventId') ||
          !('eventId' in body) ||
          typeof body.eventId !== 'string' ||
          !/^[a-f0-9]{24}$/.test(body.eventId)
        )
          throw new PulseError(400, 'Provide only a valid eventId.');
        reply(response, 200, await service.explain(body.eventId));
      } else throw new PulseError(404, 'Unknown local endpoint or method.');
    })().catch((error) =>
      reply(response, error instanceof PulseError ? error.status : 500, {
        error:
          error instanceof PulseError ? error.message : 'The local request could not be completed.',
      }),
    );
  };
}
/** The caller loads env with Vite loadEnv; no environment values are exposed to the browser. */
export function worldPulseApiPlugin(env: Record<string, string>): Plugin {
  let service: WorldPulseService | undefined;
  let maritime: MaritimeService | undefined;
  return {
    name: 'world-pulse-local-api',
    configureServer(server) {
      service = new WorldPulseService({
        env,
        storePath: resolve(env.PULSE_DATA_DIR || '.world-pulse', 'pulse.sqlite'),
      });
      maritime = new MaritimeService(env.AISSTREAM_API_KEY, resolve(env.PULSE_DATA_DIR || '.world-pulse','maritime.sqlite'));
      server.middlewares.use(worldPulseMiddleware(service, maritime));
      service.start(); maritime.start();
      server.httpServer?.once('close', () => {service?.stop();maritime?.stop();maritime=undefined;});
    },
    configurePreviewServer(server) {
      service = new WorldPulseService({
        env,
        storePath: resolve(env.PULSE_DATA_DIR || '.world-pulse', 'pulse.sqlite'),
      });
      maritime = new MaritimeService(env.AISSTREAM_API_KEY, resolve(env.PULSE_DATA_DIR || '.world-pulse','maritime.sqlite'));
      server.middlewares.use(worldPulseMiddleware(service, maritime));
      service.start(); maritime.start();
      server.httpServer?.once('close', () => {service?.stop();maritime?.stop();maritime=undefined;});
    },
    closeBundle() {
      service?.stop(); maritime?.stop(); maritime=undefined;
    },
  };
}
