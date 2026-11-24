const get = selector => document.querySelector(selector);
const state = get('#state');
const reply = get('#reply');
const usage = get('#usage');
const routes = get('#routes');
const model = get('#model');
const preset = get('#preset');
const thinking = get('#thinking');
const buttons = [...document.querySelectorAll('button')];
const dropdowns = new Map([model, thinking, preset].map(select => [select, customDropdown(select)]));
get('#url').textContent = location.origin + '/v1';
const port = get('#port');
port.value = location.port || '80';
if (new URLSearchParams(location.hash.slice(1)).has('key')) {
  history.replaceState(null, '', location.pathname + location.search);
}
try { sessionStorage.removeItem('pilotrouter.key'); } catch {}

get('#port-form').addEventListener('submit', event => {
  event.preventDefault();
  const target = new URL('http://127.0.0.1:' + port.valueAsNumber + '/');
  if (target.origin === location.origin) run(async () => {});
  else location.assign(target.href);
});

function notify(notice, message, tone = 'info') {
  const content = document.createElement('span');
  content.textContent = message;
  notice.dataset.tone = tone;
  notice.replaceChildren(content);
}

async function api(path, method = 'GET', body) {
  const response = await fetch('/panel-api' + path, {
    method,
    headers: body ? {'Content-Type':'application/json'} : undefined,
    body:body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error((await response.json()).error?.message || 'Request failed.');
  return response;
}

function options(select, items, defaultValue, defaultName) {
  const previous = select.value;
  select.replaceChildren(new Option(defaultName, defaultValue), ...items.map(item => new Option(item.name || item.id, item.id)));
  if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
  dropdowns.get(select).sync();
}

function customDropdown(select) {
  const label = select.labels[0];
  const trigger = document.createElement('button');
  const list = document.createElement('div');
  trigger.type = 'button';
  trigger.id = select.id + '-trigger';
  trigger.className = 'dropdown-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-expanded', 'false');
  label.id = select.id + '-label';
  label.htmlFor = trigger.id;
  trigger.setAttribute('aria-labelledby', label.id);
  const hint = select.getAttribute('aria-describedby');
  if (hint) trigger.setAttribute('aria-describedby', hint);
  list.id = select.id + '-options';
  list.className = 'dropdown-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', label.id);
  list.hidden = true;
  trigger.setAttribute('aria-controls', list.id);
  select.hidden = true;
  select.after(trigger, list);
  let active = 0;

  function highlight(index) {
    active = Math.max(0, Math.min(index, list.children.length - 1));
    const item = list.children[active];
    if (!item) return;
    list.querySelector('.active')?.classList.remove('active');
    item.classList.add('active');
    trigger.setAttribute('aria-activedescendant', item.id);
    item.scrollIntoView({block:'nearest'});
  }

  function close() {
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
  }

  function sync() {
    close();
    trigger.textContent = select.selectedOptions[0]?.textContent ?? '';
    list.replaceChildren(...Array.from(select.options, (option, index) => {
      const item = document.createElement('div');
      item.id = list.id + '-' + index;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.textContent = option.textContent;
      item.addEventListener('click', () => choose(index));
      return item;
    }));
  }

  function choose(index) {
    select.selectedIndex = index;
    select.dispatchEvent(new Event('change', {bubbles:true}));
  }

  function open() {
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    highlight(select.selectedIndex);
  }

  select.addEventListener('change', sync);
  trigger.addEventListener('click', () => list.hidden ? open() : close());
  trigger.addEventListener('blur', close);
  list.addEventListener('mousedown', event => event.preventDefault());
  trigger.addEventListener('keydown', event => {
    const {key} = event;
    if (list.hidden) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        open();
      }
      return;
    }
    switch (key) {
      case 'ArrowDown': highlight(active + 1); break;
      case 'ArrowUp': highlight(active - 1); break;
      case 'Home': highlight(0); break;
      case 'End': highlight(list.children.length - 1); break;
      case 'Enter':
      case ' ': choose(active); break;
      case 'Escape': close(); break;
      default: return;
    }
    event.preventDefault();
  });
  sync();
  return {sync};
}

function showStatus(status) {
  get('#api-auth').textContent = status.api_key_required ? 'Required for API clients' : 'Optional for API clients';
  state.textContent = status.enabled ? 'API running' : 'API paused';
  state.classList.toggle('live', status.enabled);
  routes.replaceChildren(...(status.routes || []).map(route => {
    const li = document.createElement('li');
    li.textContent = route.id + ' → ' + route.project + (route.enabled ? '' : ' (paused)');
    return li;
  }));
  routes.hidden = !routes.childElementCount;
}

async function refresh() {
  const [status, models, prompts] = await Promise.all(['/status','/v1/models','/v1/prompts'].map(path =>
    api(path).then(response => response.json())
  ));
  showStatus(status);
  options(model, models.data.filter(item => item.id !== 'ropilot-credits'), 'ropilot-credits', 'Route default');
  options(preset, prompts.data, '', 'None');
  return status;
}

async function run(action, success = '', notice = get('#notice')) {
  buttons.forEach(button => { button.disabled = true; });
  notify(notice, 'Working…');
  try {
    await action();
    const status = await refresh();
    notify(notice, success || (status.project ? 'Connected to ' + status.project + '.' : 'Bridge connected.'), 'success');
  } catch (error) {
    const message = error.message;
    try { showStatus(await api('/status').then(response => response.json())); } catch {}
    notify(notice, message, 'error');
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function showUsage(data) {
  const credits = data.ropilot?.credits_charged;
  const tokens = data.usage?.total_tokens;
  usage.textContent = [
    typeof credits === 'number' ? credits + ' Ropilot Credits observed' : 'Credit charge unavailable',
    typeof tokens === 'number' ? tokens + ' tokens reported' : null
  ].filter(Boolean).join(' · ');
}

async function renderStream(response) {
  let buffer = '';
  let complete = false;
  for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += text;
    let next;
    while ((next = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0,next);
      buffer = buffer.slice(next + 2);
      if (!frame.startsWith('data: ')) continue;
      const data = frame.slice(6);
      if (data === '[DONE]') { complete = true; break; }
      const event = JSON.parse(data);
      if (event.ropilot) showUsage(event);
      if (event.error) throw new Error(event.error.message);
      reply.textContent += event.choices?.[0]?.delta?.content || '';
    }
    if (complete) break;
  }
  if (!complete) throw new Error('The reply stream ended early.');
}

get('#refresh').addEventListener('click', () => run(async () => {}));
const actionMessages = {
  '/studio/open': 'Studio is open. Sign in, choose a blank project and select Ropilot Credits.',
  '/api/start': 'API started.',
  '/api/pause': 'API paused.'
};
for (const button of document.querySelectorAll('[data-route]')) {
  const path = button.dataset.route;
  button.addEventListener('click', () => run(() => api(path, 'POST'), actionMessages[path]));
}
get('#test').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    reply.hidden = false;
    reply.textContent = '';
    usage.textContent = '';
    const stream = get('#stream').checked;
    const response = await api('/v1/chat/completions', 'POST', {
      model:model.value, prompt:get('#prompt').value, stream,
      ...(thinking.value ? {reasoning_effort:thinking.value} : {}),
      ...(preset.value ? {prompt_id:preset.value} : {}),
      ...(stream ? {stream_options:{include_usage:true}} : {})
    });
    if (stream) await renderStream(response);
    else {
      const data = await response.json();
      reply.textContent = data.choices[0].message.content;
      showUsage(data);
    }
  }, 'Reply received.', get('#test-notice'));
});

refresh().catch(error => {
  state.textContent = 'Disconnected';
  get('#api-auth').textContent = 'Unavailable';
  notify(get('#notice'), error.message, 'error');
});
