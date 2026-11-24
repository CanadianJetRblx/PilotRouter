import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { BridgeError } from './protocol.mjs';

const fail = (status, code, message, options) => new BridgeError(status, code, message, options);
const unsafeState = (code, message) => fail(409, code, message, { pause: true });
const input = '#input-message';
const send = '#btn-send';
const newChat = '#btn-new-chat';
const studioLog = (event, details = {}) => {
  console.info(JSON.stringify({ time: new Date().toISOString(), component: 'studio', event, ...details }));
};

export function findStudio() {
  const supplied = process.env.ROPILOT_STUDIO_PATH;
  if (supplied) {
    if (!isAbsolute(supplied) || !existsSync(supplied)) {
      throw fail(503, 'studio_path', 'Set ROPILOT_STUDIO_PATH to the full path of the installed Ropilot executable.');
    }
    return supplied;
  }

  const home = homedir();
  let candidates;
  if (process.platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']
    ].filter(Boolean);
    candidates = roots.flatMap(root => ['Ropilot Studio', 'Ropilot', 'ropilot'].map(dir =>
      join(root, dir, 'Ropilot Studio.exe')
    ));
  } else if (process.platform === 'darwin') {
    candidates = ['/Applications', join(home, 'Applications')].map(root =>
      join(root, 'Ropilot Studio.app', 'Contents', 'MacOS', 'Ropilot Studio')
    );
  } else {
    candidates = (process.env.PATH || '').split(delimiter).filter(isAbsolute).flatMap(root =>
      ['ropilot-studio', 'ropilot'].map(name => join(root, name))
    );
  }
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw fail(503, 'studio_missing', 'Ropilot Studio was not found. Set ROPILOT_STUDIO_PATH in your terminal and restart the bridge.');
  }
  return executable;
}

function startStudio(owner) {
  const executable = findStudio();
  const child = spawn(executable, [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows'
  ], {
    shell: false, stdio: ['ignore', 'pipe', 'pipe']
  });
  owner.process = child;
  studioLog('launch', { pid: child.pid });
  child.once('exit', (code, signal) => studioLog('process_exit', { code, signal }));
  return new Promise((resolve, reject) => {
    let logTail = '';
    let settled = false;
    const timer = setTimeout(() => done(fail(503, 'studio_debug', 'Could not connect to Studio. Close any already running Ropilot Studio window and try again.')), 15_000);

    function done(error, endpoint) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', inspect);
      child.stderr.off('data', inspect);
      child.stdout.resume();
      child.stderr.resume();
      if (error) {
        if (child.exitCode === null && child.pid) child.kill();
        reject(error);
      } else resolve(endpoint);
    }

    function inspect(bytes) {
      logTail = (logTail + bytes.toString('utf8')).slice(-4096);
      const match = logTail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);
      if (match) {
        studioLog('debug_endpoint_ready');
        done(null, match[1]);
      }
    }

    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('error', () => done(fail(503, 'studio_launch', 'Ropilot Studio could not launch. Check the executable path.')));
    child.once('exit', () => {
      if (owner.process === child) owner.process = null;
      done(fail(503, 'studio_exit', 'Ropilot Studio closed. If another copy is running, close it and try again.'));
    });
  });
}

const permittedPage = raw => {
  const url = new URL(raw);
  return url.origin === 'https://app.ropilot.ai' ||
    (url.protocol === 'file:' && url.pathname.endsWith('/src/index.html'));
};

async function waitFor(get, timeoutMs, error, signal) {
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const result = await get();
    if (result) return result;
    await delay(160, undefined, { signal });
  } while (Date.now() < deadline);
  throw error;
}

// Use the Studio button's click handler without waiting for a foreground frame.
async function clickStudioButton(locator, timeout = 3_000) {
  await locator.evaluate(button => {
    if (!(button instanceof HTMLElement) || button.matches(':disabled, [aria-disabled="true"]')) {
      throw new Error('The Studio button is disabled.');
    }
    button.click();
  }, undefined, { timeout });
}

async function snapshot(page, mode = '') {
  if (!permittedPage(page.url())) return null;
  return page.evaluate(mode => {
    const app = window.app;
    if (typeof app?.isUseRopilotCreditsEnabled !== 'function') return null;
    const chat = app.activeChat;
    const projectId = String(app.activeProjectId || '');
    const projects = Array.isArray(app.projects) ? app.projects : [];
    const project = projects.find(item => item.id === projectId);
    const menu = mode === 'catalog' ? app.composerDropdowns?.getComposerModelMenuData?.() : null;
    const models = Object.entries(menu?.providerOptions ?? {}).flatMap(([provider, options]) =>
      menu.providerAccess?.[provider]?.locked ? [] :
        options.filter(option => !option.disabled).map(option => ({ id: option.value, name: option.label }))
    );
    const messages = mode === 'turn' && Array.isArray(chat?.timeline) ? chat.timeline : [];
    const usage = mode === 'turn' ? chat?.activities?.findLast(item => item?.kind === 'context-window.updated')?.payload : null;
    const tokens = Number.isSafeInteger(usage?.lastInputTokens) && usage.lastInputTokens >= 0 &&
      Number.isSafeInteger(usage?.lastOutputTokens) && usage.lastOutputTokens >= 0 ? {
        prompt_tokens: usage.lastInputTokens, completion_tokens: usage.lastOutputTokens,
        total_tokens: usage.lastInputTokens + usage.lastOutputTokens,
        ...(Number.isSafeInteger(usage.lastCachedInputTokens) && usage.lastCachedInputTokens >= 0 ? {
          prompt_tokens_details: { cached_tokens: usage.lastCachedInputTokens }
        } : {}),
        ...(Number.isSafeInteger(usage.lastReasoningOutputTokens) && usage.lastReasoningOutputTokens >= 0 ? {
          completion_tokens_details: { reasoning_tokens: usage.lastReasoningOutputTokens }
        } : {})
      } : null;
    const costMeta = chat && mode === 'turn' ? app.getStoredTurnActionCostMeta?.(chat.id) : null;
    const liveCost = costMeta?.actionCostBalanceType === 'managed_ai_credits' ? app.getTurnActionCost?.(chat.id) : null;
    const saved = messages.findLast(item =>
      ['assistant','emit'].includes(item?.type) && item?.actionCostBalanceType === 'managed_ai_credits'
    )?.actionCost;
    const cost = Number.isFinite(liveCost) && liveCost >= 0 ? liveCost :
      Number.isFinite(saved) && saved > 0 ? saved : null;
    return {
      projectId,
      projectName: String(project?.name || 'Selected project'),
      projectKeyPresent: typeof project?.apiKey === 'string' && !!project.apiKey.trim(),
      projects: mode === 'catalog' ? projects.map(item => ({
        id: item.id, name: item.name, keyPresent: typeof item.apiKey === 'string' && !!item.apiKey.trim()
      })) : [],
      chatId: String(chat?.id || ''),
      credits: app.isUseRopilotCreditsEnabled() === true,
      model: String(app.selectedModel || document.querySelector('#model-select')?.value || ''),
      chatModel: String(chat?.model || ''),
      models,
      busy: !!(chat && app.isChatProcessing(chat.id)),
      creditWall: !!document.getElementById('credits-inline-card'),
      cost,
      tokens,
      messages: messages.filter(item => ['user','assistant','emit','error','status'].includes(item?.type)).map(item => ({
        type: item.type, id: item.id,
        content: typeof item.content === 'string' ? item.content : '',
        label: item.type === 'status' ? String(item.text || '').slice(0, 180) : '',
        finalized: item.finalized === true,
        work: item.type === 'status' && Boolean(item.command || item.commandOutput)
      }))
    };
  }, mode);
}

export class Studio {
  process = null;
  browser = null;
  #launching = null;
  #endpoint = null;

  async #connect() {
    if (!this.browser?.isConnected()) {
      if (!this.#launching) {
        const reattach = Boolean(this.process && this.#endpoint);
        if (reattach) studioLog('debug_reattach');
        const endpoint = reattach ? Promise.resolve(this.#endpoint) : startStudio(this);
        this.#launching = endpoint
          .then(async endpoint => {
            this.#endpoint = endpoint;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                return await chromium.connectOverCDP(endpoint, {
                  timeout: 12_000,
                  noDefaults: true
                });
              } catch (error) {
                const message = error.message || '';
                const reason = message.match(/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)\b/)?.[0]
                  || (error.name === 'TimeoutError' ? 'timeout' : 'protocol_error');
                studioLog('debug_attach_failed', { attempt, reason });
                if (!this.process || attempt === 3) throw error;
                await delay(attempt * 500);
              }
            }
          })
          .then(browser => {
            this.browser = browser;
            studioLog('debug_attached');
            browser.once('disconnected', () => studioLog('debug_disconnected'));
          })
          .catch(error => {
            // Keep an existing Studio session and any open work on attach failure.
            if (!reattach) this.close();
            if (error instanceof BridgeError) throw error;
            throw fail(503, 'studio_debug', 'Could not attach to Studio. Check the bridge terminal and retry Open Studio.');
          })
          .finally(() => { this.#launching = null; });
      }
      await this.#launching;
    }
  }

  async open() {
    const launchingFresh = !this.process;
    await this.#connect();
    // The desktop window can load before sign-in exposes the composer.
    await waitFor(
      () => this.window(),
      30_000,
      fail(503, 'studio_window', 'Studio connected but its app window did not load. Check the Studio window and try again.')
    );
    studioLog('window_ready');
    return launchingFresh;
  }

  window() {
    return this.browser?.contexts().flatMap(context => context.pages()).find(page => permittedPage(page.url()));
  }

  async page() {
    if (!this.browser?.isConnected() && this.process && this.#endpoint) await this.#connect();
    if (!this.browser?.isConnected()) return null;
    const pages = this.browser.contexts().flatMap(context => context.pages());
    for (const page of pages) {
      if (!permittedPage(page.url())) continue;
      if (await page.locator(newChat).count().catch(() => 0)) {
        page.setDefaultTimeout(3_000);
        return page;
      }
    }
    return null;
  }

  async arm() {
    const page = await this.page();
    if (!page) {
      if (this.window()) throw fail(409, 'project_required', 'Finish signing in and select a blank Ropilot project first.');
      throw fail(503, 'studio_window', 'Open Ropilot Studio from the bridge first.');
    }
    const state = await snapshot(page, 'catalog');
    if (!state?.projectId || !await page.locator(newChat).isVisible()) {
      throw fail(409, 'project_required', 'Finish signing in and select a blank Ropilot project first.');
    }
    if (state.busy) throw fail(409, 'studio_busy', 'Wait for the current Studio response to finish.');
    if (!state.credits) throw fail(409, 'credits_disabled', 'Select Ropilot Credits in the Studio model picker first.');
    if (!state.models.length) throw fail(503, 'models_unavailable', 'Studio did not expose its Credits model catalog.');
    return state;
  }

  async complete(request, timeoutMs, signal, onUpdate) {
    const { prompt, profile, model, reasoning } = request;
    const page = await this.page();
    if (!page) throw fail(503, 'studio_window', 'Ropilot Studio is closed. Open Studio and enable the API again.', { pause: true });
    const check = (state, chatId = '') => {
      if (!state?.credits) throw unsafeState('credits_disabled', 'Ropilot Credits is no longer selected.');
      if (chatId && (state.chatId !== chatId || state.projectId !== profile.projectId)) {
        throw unsafeState('studio_changed', 'The Studio chat or project changed during the request.');
      }
      if (chatId && profile.requireProjectKey && !state.projectKeyPresent) {
        throw unsafeState('project_key_missing', 'The configured project lost its folder API key. Reconfigure Studio before sending.');
      }
    };
    const previous = await snapshot(page, 'catalog');
    check(previous);
    if (previous.busy) throw unsafeState('studio_busy', 'A Studio request is still running. Check Studio and enable the API again.');
    if (!previous.models.some(item => item.id === model)) {
      throw fail(404, 'model_not_found', 'Studio no longer lists this model as selectable.');
    }
    const target = previous.projects.find(project => project.id === profile.projectId);
    if (!target || (profile.requireProjectKey && !target.keyPresent)) {
      throw unsafeState('project_key_missing', 'The configured project or its folder key is missing.');
    }
    signal?.throwIfAborted();
    if (previous.projectId === profile.projectId) {
      await clickStudioButton(page.locator(newChat));
    } else {
      await page.evaluate(id => window.app.createNewChatInProject(id), profile.projectId);
    }
    const fresh = await waitFor(async () => {
      const current = await snapshot(page, 'turn');
      check(current);
      return current.projectId === profile.projectId && current.chatId && current.chatId !== previous.chatId &&
        current.messages.length === 0 && current;
    }, 8_000, fail(503, 'new_chat', 'Studio could not open a fresh chat in the routed project.', { pause: true }), signal);
    check(fresh, fresh.chatId);

    // Use the same select change handlers as the visible model picker.
    const selected = await page.evaluate(({ model, reasoning }) => {
      const app = window.app;
      const select = document.getElementById('model-select');
      const current = app.composerDropdowns?.getComposerModelMenuData?.();
      const allowed = Object.entries(current?.providerOptions ?? {}).some(([provider, options]) =>
        !current.providerAccess?.[provider]?.locked && options.some(item => item.value === model && !item.disabled)
      );
      if (!allowed || !select) return 'model';
      if (select.value !== model) {
        select.value = model;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (String(app.selectedModel || select.value) !== model) return 'model';
      if (reasoning) {
        const effort = document.getElementById('reasoning-level-select');
        if (!effort || !Array.from(effort.options).some(option => option.value === reasoning && !option.disabled && !option.hidden)) {
          return 'reasoning';
        }
        effort.value = reasoning;
        effort.dispatchEvent(new Event('change', { bubbles: true }));
        if (effort.value !== reasoning) return 'reasoning';
      }
      return 'ok';
    }, { model, reasoning });
    if (selected === 'model') throw fail(404, 'model_not_found', 'Studio rejected the requested model.');
    if (selected === 'reasoning') throw fail(400, 'reasoning_unavailable', 'The model or plan does not offer this reasoning effort.');

    const composer = page.locator(input);
    if (await composer.inputValue() !== '') throw unsafeState('studio_draft', 'The fresh chat has a draft. Clear it in Studio and try again.');
    signal?.throwIfAborted();
    await composer.fill(prompt);
    const current = await snapshot(page, 'turn');
    check(current, fresh.chatId);
    if (current.busy || current.messages.length || current.model !== model || await composer.inputValue() !== prompt) {
      throw unsafeState('studio_changed', 'The fresh chat, model, or draft changed before submission.');
    }
    signal?.throwIfAborted();
    await clickStudioButton(page.locator(send));

    let quietSince;
    let sentText = '';
    let observedCost = false;
    let observation = null;
    const work = new Map();
    const deadline = fail(504, 'studio_timeout', 'Studio did not finish in time. Check the current Studio chat before enabling the API again.', { pause: true });
    try {
      return await waitFor(async () => {
        const update = await snapshot(page, 'turn');
        check(update, fresh.chatId);
        const users = update.messages.filter(item => item.type === 'user');
        if (users.length > 1 || (users.length && users[0].content.trim() !== prompt.trim())) {
          throw unsafeState('studio_changed', 'Another message was entered in the Studio chat.');
        }
        observedCost ||= update.cost > 0;
        observation = {
          model,
          credits_charged: observedCost ? update.cost : null,
          cost_status: observedCost && update.cost !== null ? 'observed' : 'unavailable',
          usage: update.tokens
        };
        if (update.creditWall) throw fail(402, 'credits_required', 'Studio displayed its Ropilot Credits limit.');
        if (!update.busy && users.length && update.chatModel && update.chatModel !== model) {
          throw unsafeState('model_changed', 'Studio changed the requested model during submission.');
        }
        if (request.ropilotEvents) for (const item of update.messages) {
          if (item.type !== 'status' || !item.id || !item.label || item.label === 'Thinking' || !item.work) continue;
          const activity = { label: item.label, status: item.finalized ? 'completed' : 'running' };
          if (work.get(item.id)?.status !== activity.status || work.get(item.id)?.label !== activity.label) {
            work.set(item.id, activity);
            onUpdate?.({ activity });
          }
        }
        const outputBlocks = update.messages.filter(item => item.type === 'assistant' || item.type === 'emit')
          .map(item => item.content.trim()).filter(Boolean);
        const output = outputBlocks.join('\n\n');
        const hasError = update.messages.some(item => item.type === 'error');
        if (request.stream && !request.useFunctions && users.length === 1 && !hasError) {
          if (!output.startsWith(sentText)) throw fail(502, 'studio_reply_changed', 'Studio revised text that had already been streamed.');
          if (output.length > sentText.length) onUpdate?.({ text: output.slice(sentText.length) });
          sentText = output;
        }
        if (update.busy || users.length !== 1 || (!output && !hasError)) {
          quietSince = null;
          return null;
        }
        quietSince ??= Date.now();
        // Credit events sometimes arrive shortly after Studio signals completion.
        if (Date.now() - quietSince < 1200) return null;
        if (hasError) throw fail(502, 'studio_reply', 'Studio reported an error. Open the latest Studio chat for details.');
        return { text: output, finalText: outputBlocks.at(-1), ...observation, activities: [...work.values()] };
      }, timeoutMs, deadline, signal);
    } catch (error) {
      if (error instanceof BridgeError) error.observation = observation;
      if (signal?.aborted || error === deadline || error.code === 'credits_required') {
        // Stop via Studio only when the request still owns the active chat.
        const state = await snapshot(page).catch(() => null);
        if (state?.chatId === fresh.chatId && state.projectId === profile.projectId && (state.busy || state.creditWall)) {
          await clickStudioButton(page.locator(send + '.stop-mode'), 750).catch(() => {});
        }
      }
      if (signal?.aborted) throw fail(499, 'disconnected', 'The client disconnected.', { pause:true, observation });
      throw error;
    }
  }

  close() {
    if (this.process?.exitCode === null) this.process.kill();
    this.process = null;
    this.browser = null;
    this.#endpoint = null;
  }
}
