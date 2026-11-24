import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Studio } from './studio.mjs';
import {
  BridgeError, DEFAULT_MODEL, authRoute, digest, generateKey, loadConfig, parseConfig, parseChat, readReply
} from './protocol.mjs';

const MAX_BYTES = 192_000;
const ASSETS = new Map([
  ['/', ['panel.html','text/html']],
  ['/panel.css', ['panel.css','text/css']],
  ['/panel.js', ['panel.js','text/javascript']],
  ...[400, 500, 700].map(weight => [
    '/fonts/ubuntu-' + weight + '.woff2',
    ['node_modules/@fontsource/ubuntu/files/ubuntu-latin-' + weight + '-normal.woff2', 'font/woff2']
  ])
]);
const fail = (status, code, message) => new BridgeError(status, code, message);
const errorObject = error => ({
  message: error.message,
  code: error.code,
  type: error.status === 429 ? 'rate_limit_error' : error.status >= 500 ? 'server_error' : 'invalid_request_error'
});
const modelObject = (id, name) => ({
  id, name, object:'model', created:0, owned_by:'ropilot-studio'
});
const blankUsage = () => ({requests:0, succeeded:0, failed:0, canceled:0, reported_credits:0, unreported_cost_requests:0});

async function readJSON(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
    throw fail(415, 'content_type', 'Use Content-Type: application/json.');
  }
  if (Number(req.headers['content-length'] || 0) > MAX_BYTES) throw fail(413, 'body_size', 'The request is too large.');
  const parts = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BYTES) throw fail(413, 'body_size', 'The request is too large.');
    parts.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(parts));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw fail(400, 'invalid_json', 'Use a valid JSON object.');
  }
}

function bindProfiles(state, routes) {
  const menu = new Map(state.models.map(item => [item.id, item.name]));
  const all = [...menu.keys()];
  const profiles = new Map([['admin', {
    projectId:state.projectId, projectName:state.projectName, modelNames:menu, models:all,
    defaultModel:menu.has(state.model) ? state.model : all[0], requireProjectKey:false
  }]]);
  for (const route of routes) {
    const projects = state.projects.filter(project => project.name === route.project);
    if (projects.length !== 1) {
      throw fail(409, 'route_project', 'Route ' + route.id + ' needs exactly one Studio project named "' + route.project + '".');
    }
    const project = projects[0];
    if (route.requireProjectKey && !project.keyPresent) {
      throw fail(409, 'route_project_key', 'Set the Folder API Key for the Studio project used by route ' + route.id + '.');
    }
    if (route.models.some(model => !menu.has(model))) {
      throw fail(409, 'route_models', 'Route ' + route.id + ' lists a model that Studio does not offer. Check the Studio picker.');
    }
    profiles.set(route.id, {
      projectId:project.id, projectName:project.name, modelNames:menu, models:route.models,
      defaultModel:route.defaultModel, requireProjectKey:route.requireProjectKey
    });
  }
  return profiles;
}

export function makeServer({ studio, secret, config = parseConfig({}) }) {
  const admin = {
    id:'admin', keyHash:secret ? Buffer.from(digest(secret), 'hex') : null, allowTools:true, rpm:60,
    promptIds:Object.keys(config.prompts)
  };
  if (admin.keyHash && config.routes.some(route => route.keyHash.equals(admin.keyHash))) {
    throw new Error('The admin key must differ from every scoped API key.');
  }
  let profiles = new Map();
  let studioCatalog = [];
  let setup = false;
  let active = null;
  const queue = [];
  const counters = new Map([admin, ...config.routes].map(route => [
    route.id, {times:[], usage:blankUsage()}
  ]));
  const started = new Date().toISOString();

  function status(route) {
    const profile = profiles.get(route.id);
    return {
      enabled: !!profile, project:profile?.projectName ?? null, busy:!!(setup || active),
      queued:queue.length, default_model:profile?.defaultModel ?? null,
      ...(route.id === 'admin' ? { studio_models:studioCatalog, routes:config.routes.map(configured => ({
        id:configured.id, project:configured.project, enabled:profiles.has(configured.id)
      })) } : {})
    };
  }

  function rejectQueued(message) {
    for (const job of queue.splice(0)) job.reject(fail(503, 'api_paused', message));
  }
  function count(job, outcome, observation) {
    const usage = counters.get(job.route.id).usage;
    usage.requests++;
    usage[outcome]++;
    if (typeof observation?.credits_charged === 'number') usage.reported_credits += observation.credits_charged;
    else usage.unreported_cost_requests++;
  }
  async function pump() {
    if (active || !queue.length || !profiles.size) return;
    const job = queue.shift();
    active = job;
    try {
      job.controller.signal.throwIfAborted();
      const answer = await studio.complete(job.chat, config.timeoutMs, job.controller.signal, job.onUpdate);
      let result;
      try { result = readReply(answer.text, job.chat, answer.finalText); }
      catch (err) { err.observation = answer; throw err; }
      count(job, 'succeeded', answer);
      job.resolve({ ...result, answer });
    } catch (raw) {
      const disconnected = job.controller.signal.aborted;
      const err = raw instanceof BridgeError ? raw : fail(502, 'studio_connection', 'Could not read the reply from Studio.');
      count(job, disconnected ? 'canceled' : 'failed', raw.observation);
      // A disconnect may leave a desktop turn running. Re-arm explicitly before
      // sending queued work into the same Studio session.
      if (disconnected || err.pause || !(raw instanceof BridgeError)) {
        profiles = new Map();
        rejectQueued('The API paused after the Studio session changed. Enable it again from the control panel.');
      }
      job.reject(err);
    } finally {
      active = null;
      void pump();
    }
  }
  function execute(job) {
    return new Promise((resolve, reject) => {
      const pending = { ...job, resolve, reject };
      const signal = pending.controller.signal;
      let timer;
      const remove = error => {
        const index = queue.indexOf(pending);
        if (index >= 0) {
          queue.splice(index, 1);
          reject(error);
        }
      };
      const onAbort = () => remove(fail(499, 'disconnected', 'The client disconnected.'));
      signal.addEventListener('abort', onAbort, {once:true});
      if (active || queue.length) {
        timer = setTimeout(() => remove(fail(503, 'queue_timeout', 'The request waited too long in the Studio queue.')), 30_000);
      }
      const clean = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      pending.resolve = value => { clean(); resolve(value); };
      pending.reject = error => { clean(); reject(error); };
      queue.push(pending);
      void pump();
    });
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    const requestId = 'req_' + randomUUID().replaceAll('-', '');
    const host = '127.0.0.1:' + server.address().port;
    const {method, headers} = req;
    let {url} = req;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    let streamWriter;
    function json(code, payload) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify(payload));
    }

    try {
      if (headers.host !== host || (headers.origin && headers.origin !== 'http://' + host)) {
        throw fail(403, 'local_only', 'Use the local 127.0.0.1 address printed in the terminal.');
      }
      const asset = ASSETS.get(url);
      if (method === 'GET' && asset) {
        const [file, type] = asset;
        const data = await readFile(new URL(file, import.meta.url));
        res.writeHead(200, {'Content-Type': type.startsWith('text/') ? type + '; charset=utf-8' : type});
        res.end(data);
        return;
      }
      const panelRequest = url.startsWith('/panel-api/');
      if (panelRequest) {
        const origin = 'http://' + host;
        if (headers['sec-fetch-site'] !== 'same-origin' || (method !== 'GET' && headers.origin !== origin)) {
          throw fail(403, 'panel_origin', 'Open the local PilotRouter panel to use this endpoint.');
        }
        url = url.slice('/panel-api'.length);
      }
      const route = panelRequest || (!secret && headers.authorization === undefined)
        ? admin
        : authRoute(headers.authorization, secret ? admin : null, config.routes);
      if (!route) throw fail(401, 'invalid_api_key', 'Provide a valid API key as a Bearer token.');
      if (method === 'GET' && url === '/status') {
        return json(200, { ...status(route), ...(panelRequest ? {api_key_required: Boolean(secret)} : {}) });
      }
      if (method === 'GET' && url === '/v1/usage') {
        const usage = counters.get(route.id).usage;
        return json(200, { object:'ropilot_bridge.usage', route:route.id, since:started, ...usage });
      }
      if (method === 'GET' && url === '/v1/prompts') {
        return json(200, {object:'list', data:route.promptIds.map(id => ({id, object:'prompt'}))});
      }
      if (method === 'GET' && (url === '/v1/models' || url.startsWith('/v1/models/'))) {
        const profile = profiles.get(route.id);
        const models = profile ? [modelObject(DEFAULT_MODEL, 'Route default'), ...profile.models.map(id =>
          modelObject(id, profile.modelNames.get(id))
        )] : [];
        if (url === '/v1/models') return json(200, {object:'list', data:models});
        const model = models.find(item => item.id === url.slice('/v1/models/'.length));
        if (!model) throw fail(404, 'model_not_found', 'This model is unavailable on this key route.');
        return json(200, model);
      }
      if (method === 'POST' && ['/studio/open','/api/start','/api/pause'].includes(url)) {
        if (route.id !== 'admin') throw fail(403, 'admin_only', 'Use the local PilotRouter panel for this action.');
        if (setup) throw fail(409, 'bridge_busy', 'Wait for Studio setup to finish.');
        if (url === '/api/pause') {
          profiles = new Map();
          rejectQueued('The API was paused.');
          return json(200, status(route));
        }
        if (active) throw fail(409, 'bridge_busy', 'Wait for the current Studio turn to finish.');
        setup = true;
        const setupStarted = Date.now();
        let outcome = 'ok';
        try {
          if (url === '/studio/open') {
            if (await studio.open()) {
              studioCatalog = [];
              profiles = new Map();
            }
          } else {
            profiles = new Map();
            const state = await studio.arm();
            studioCatalog = state.models;
            profiles = bindProfiles(state, config.routes);
          }
        } catch (error) {
          outcome = error instanceof BridgeError ? error.code : 'internal_error';
          throw error;
        } finally {
          setup = false;
          console.info(JSON.stringify({
            time: new Date().toISOString(), component: 'bridge', event: 'setup',
            requestId, action: url, outcome, durationMs: Date.now() - setupStarted
          }));
        }
        return json(200, status(route));
      }
      if (method !== 'POST' || url !== '/v1/chat/completions') throw fail(404, 'route', 'Endpoint not found.');
      const body = await readJSON(req);
      if (res.destroyed) return;
      if (setup) throw fail(409, 'bridge_busy', 'Wait for Studio setup to finish.');
      if (!profiles.has(route.id)) throw fail(503, 'api_paused', 'Enable the API from the bridge panel first.');
      const chat = parseChat(body, route, profiles, config.prompts);
      if (active && queue.length >= config.queueLimit) {
        res.setHeader('Retry-After','2');
        throw fail(429, 'queue_full', 'The Studio queue is full.');
      }
      const limits = counters.get(route.id);
      const now = Date.now();
      limits.times = limits.times.filter(time => time > now - 60_000);
      if (limits.times.length >= route.rpm) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limits.times[0] + 60_000 - now) / 1000))));
        throw fail(429, 'rate_limit', 'This bridge key has reached its requests-per-minute limit.');
      }
      limits.times.push(now);
      const created = Math.floor(now / 1000);
      const base = {id:'chatcmpl-' + randomUUID().replaceAll('-', ''), created, model:chat.model};
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      res.on('close', disconnect);
      let heartbeat;
      let streamed = '';
      const writeln = (value, signal = true) => {
        if (res.destroyed || res.writableEnded) return;
        if (!res.write(value) && signal && res.writableLength > 256_000) controller.abort();
      };
      const sse = payload => writeln('data: ' + JSON.stringify(payload) + '\n\n');
      const chunk = (choices, extra = {}) => sse({
        ...base, object:'chat.completion.chunk', choices, ...(chat.includeUsage ? {usage:null} : {}), ...extra
      });
      function ensureStream() {
        if (res.headersSent) return;
        res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8', 'X-Accel-Buffering':'no'});
        streamWriter = sse;
        chunk([{index:0, delta:{role:'assistant'}, finish_reason:null}]);
        heartbeat = setInterval(() => writeln(': keep-alive\n\n'), 12_000);
      }
      try {
        if (chat.stream) {
          // Start the HTTP stream for queued callers too, once validation passes.
          ensureStream();
        }
        const result = await execute({
          route, chat, controller,
          onUpdate: event => {
            if (!chat.stream) return;
            if (event.text) {
              streamed += event.text;
              chunk([{index:0, delta:{content:event.text}, finish_reason:null}]);
            } else if (event.activity && chat.ropilotEvents) {
              chunk([], {ropilot:{activity:event.activity}});
            }
          }
        });
        if (res.destroyed) return;
        const {message, finish, answer} = result;
        const ropilot = {
          route:route.id, credits_charged:answer.credits_charged ?? null,
          cost_status:answer.cost_status || 'unavailable',
          usage_source:answer.usage ? 'studio_token_snapshot' : null,
          ...(chat.ropilotEvents ? {activities:answer.activities || []} : {})
        };
        if (!chat.stream) {
          return json(200, {...base, object:'chat.completion',
            choices:[{index:0, message, finish_reason:finish}], usage:answer.usage ?? null, ropilot});
        }
        if (message.tool_calls) {
          const calls = message.tool_calls.map((call, index) => ({index, ...call}));
          chunk([{index:0, delta:{tool_calls:calls}, finish_reason:null}]);
        } else if (message.content.length > streamed.length) {
          chunk([{index:0, delta:{content:message.content.slice(streamed.length)}, finish_reason:null}]);
        }
        chunk([{index:0, delta:{}, finish_reason:finish}], chat.includeUsage ? {} : {ropilot});
        if (chat.includeUsage) chunk([], {usage:answer.usage ?? null, ropilot});
        writeln('data: [DONE]\n\n', false);
        res.end();
      } finally {
        clearInterval(heartbeat);
        res.off('close', disconnect);
      }
    } catch (raw) {
      const error = raw instanceof BridgeError ? raw : fail(500, 'internal_error', 'The bridge could not handle the request.');
      if (!(raw instanceof BridgeError)) console.error('Bridge request failed:', raw?.code || raw?.name);
      const payload = {error:errorObject(error)};
      if (error.observation) payload.ropilot = {
        credits_charged:error.observation.credits_charged ?? null, cost_status:error.observation.cost_status || 'unavailable'
      };
      if (streamWriter && !res.destroyed) {
        streamWriter(payload);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (error.status === 413 && !res.destroyed) {
        res.setHeader('Connection', 'close');
        req.resume();
      }
      json(error.status, payload);
    }
  });
  return server;
}

async function main() {
  if (process.argv[2] === '--generate-key') {
    const key = generateKey();
    console.log('Client key: ' + key + '\nkey_sha256: ' + digest(key));
    return;
  }
  const secret = process.env.ROPILOT_BRIDGE_KEY;
  if (secret && !/^[\w.~:-]{24,128}$/.test(secret)) throw new Error('Set a URL-safe ROPILOT_BRIDGE_KEY of 24–128 characters.');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port')) {
    throw new Error('Usage: npm start -- --port <port>');
  }
  const portText = args[1] ?? (process.env.ROPILOT_BRIDGE_PORT || '8787');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error('Choose a port from 1 to 65535.');
  const config = await loadConfig(process.env.ROPILOT_BRIDGE_CONFIG || new URL('bridge.config.json', import.meta.url));
  const studio = new Studio();
  const server = makeServer({studio, secret, config});
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'This port is in use. Set ROPILOT_BRIDGE_PORT.' : 'The bridge could not start.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const origin = 'http://127.0.0.1:' + port;
    console.log('Open PilotRouter: ' + origin + '/' +
      '\nBase URL: ' + origin + '/v1\nAPI key: ' + (secret ? 'required' : 'optional') +
      '\nConfigured client routes: ' + config.routes.length);
  });
  for (const sig of ['SIGINT','SIGTERM']) process.once(sig, () => {
    studio.close();
    server.close();
    server.closeAllConnections();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
