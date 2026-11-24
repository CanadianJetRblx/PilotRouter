import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { makeServer } from '../server.mjs';
import { Studio } from '../studio.mjs';
import { digest, parseChat, parseConfig, readReply } from '../protocol.mjs';

const key = 'test-admin-key-for-bridge-checks-000';
const keyA = 'test-route-a-key-for-bridge-checks-1';
const keyB = 'test-route-b-key-for-bridge-checks-2';
const makeConfig = () => parseConfig({
  queue_limit:1, timeout_ms:5000,
  prompts:{review:'Check the style'},
  routes:[
    {id:'route-a', key_sha256:digest(keyA), project:'Blank A', models:['alpha'], prompt_ids:['review']},
    {id:'route-b', key_sha256:digest(keyB), project:'Blank B', models:['beta'], allow_tools:false}
  ]
});

const functions = [{ type:'function', function:{ name:'lookup', parameters:{ type:'object' } } }];
const baseChat = { messages:[{role:'user', content:'Look up example'}], tools:functions };
const routeA = makeConfig().routes[0];
const profiles = new Map([['route-a',{defaultModel:'alpha', models:['alpha']}]]);
const parse = body => parseChat(body,routeA,profiles,{review:'Check the style'});

test('protocol preserves tool results, applies presets, and rejects invalid calls', () => {
  const request = parse({...baseChat, tool_choice:'required', prompt_id:'review'});
  assert.match(request.prompt, /Check the style/);
  assert.equal(request.model, 'alpha');
  const toolText = '<bridge_tool_calls>[{"name":"lookup","arguments":{"id":"example"}}]</bridge_tool_calls>';
  const reply = readReply('I can look that up.\n\n' + toolText,request,toolText);
  assert.equal(reply.finish,'tool_calls');
  const [call] = reply.message.tool_calls;
  assert.equal(JSON.parse(call.function.arguments).id,'example');
  const followup = parse({...baseChat, messages:[...baseChat.messages,reply.message,{role:'tool',tool_call_id:call.id,content:'Found it'}]});
  assert.match(followup.prompt, /Found it/);
  assert.ok(followup.prompt.includes(call.id));
  assert.throws(() => readReply('<bridge_tool_calls>[{"name":"undeclared","arguments":{}}]</bridge_tool_calls>',request),{code:'invalid_tool_reply'});
  assert.throws(() => parse({...baseChat, model:'beta'}),{code:'model_not_found'});
  assert.throws(() => parse({...baseChat, stream_options:{include_usage:true}}),{code:'invalid_stream_options'});
  assert.throws(() => parse({messages:[{role:'tool',tool_call_id:call.id,content:'Unmatched'}]}),{code:'invalid_messages'});
});

test('API bearer authentication can be enabled without exposing panel endpoints', async () => {
  for (const secret of [undefined, key]) {
    const server = makeServer({ studio: {}, secret });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const models = origin + '/v1/models';
      assert.equal((await fetch(models)).status, secret ? 401 : 200);
      assert.equal((await fetch(models, { headers:{ Authorization:'Bearer invalid' } })).status, 401);
      if (secret) {
        assert.equal((await fetch(models, { headers:{ Authorization:'Bearer ' + secret } })).status, 200);
      }
      assert.equal((await fetch(origin + '/panel-api/status')).status, 403);
      assert.equal((await fetch(origin + '/panel-api/studio/open', {
        method: 'POST',
        headers:{ Origin:origin, 'Sec-Fetch-Site':'cross-site' }
      })).status, 403);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
});

const browser = process.env.ROPILOT_TEST_BROWSER;
test('HTTP routes, Studio projects, browser panel, streaming, and billing observation', {
  timeout:35_000, skip:!browser || !existsSync(browser)
}, async t => {
  const directory = await mkdtemp(join(tmpdir(),'ropilot-v2-test-'));
  const src = join(directory,'src');
  await mkdir(src);
  const page = join(src,'index.html');
  await writeFile(page, `<!doctype html>
    <button id="btn-new-chat">New Chat</button>
    <select id="model-select"><option>alpha</option><option>beta</option><option>locked</option></select>
    <select id="reasoning-level-select"><option>low</option><option>medium</option><option disabled>high</option></select>
    <textarea id="input-message"></textarea>
    <button id="btn-send">Send</button>
    <script>
    let n = 0;
    window.app = {
      projects:[{id:'a',name:'Blank A',apiKey:'fixture-credential-a'},{id:'b',name:'Blank B',apiKey:'fixture-credential-b'}],
      activeProjectId:'a',
      activeChat:{ id:'old', timeline:[{type:'assistant',content:'unrelated old answer'}] },
      selectedModel:'alpha',
      credits:false, busy:false, charge:null,
      composerDropdowns:{ getComposerModelMenuData() {
        return { providerOptions:{ main:[{value:'alpha',label:'Alpha'},{value:'beta',label:'Beta'}], locked:[{value:'locked', label:'Locked'}] },
          providerAccess:{locked:{locked:true}} };
      }},
      isUseRopilotCreditsEnabled(){return this.credits},
      isChatProcessing(){return this.busy},
      getStoredTurnActionCostMeta(){return this.charge === null ? null : {actionCostBalanceType:'managed_ai_credits'}},
      getTurnActionCost(){return this.charge},
      createNewChatInProject(id){
        this.activeProjectId = id;
        this.activeChat = {id:'chat-' + ++n, timeline:[], activities:[]};
        this.charge = null;
        document.querySelector('textarea').value = '';
      }
    };
    const select = document.querySelector('#model-select');
    select.onchange = () => {app.selectedModel = select.value};
    document.querySelector('#btn-new-chat').onclick = () => app.createNewChatInProject(app.activeProjectId);
    const send = document.querySelector('#btn-send');
    send.onclick = () => {
      const content = document.querySelector('textarea').value;
      const chat = app.activeChat;
      chat.model = app.selectedModel;
      app.busy = true;
      send.classList.add('stop-mode');
      chat.timeline.push({type:'user', content});
      const activity = {type:'status', id:'task', text:'Reading Studio', command:'fixture'};
      chat.timeline.push(activity);
      setTimeout(() => {
        if (!content.includes('<bridge_tool_calls>') || content.includes('Found it')) {
          const evidence = app.activeProjectId + ' ' + app.selectedModel + ' ' + document.querySelector('#reasoning-level-select').value;
          chat.timeline.push({type:'assistant', content:'Reply via ' + evidence});
        }
        setTimeout(() => {
          if (content.includes('<bridge_tool_calls>') && !content.includes('Found it')) {
            chat.timeline.push({type:'assistant', content:'<bridge_tool_calls>[{"name":"lookup","arguments":{"id":"example"}}]</bridge_tool_calls>'});
          } else {
            chat.timeline.push({type:'assistant', content:content.includes('Found it') ? 'Tool result received' : 'Done'});
          }
          activity.finalized = true;
          app.busy = false;
          send.classList.remove('stop-mode');
          chat.activities.push({kind:'context-window.updated', payload:{lastInputTokens:14,lastOutputTokens:6}});
          if (!content.includes('omit charge')) setTimeout(() => {app.charge = 0.25}, 350);
        }, 450);
      }, 140);
    };
    </script>`);
  const launcher = join(directory,'fixture-chromium');
  await writeFile(launcher, `#!/bin/sh\nexec '${browser}' --headless --no-sandbox --disable-gpu --user-data-dir='${join(directory,'browser')}' "$@" '${pathToFileURL(page)}'\n`,{mode:0o700});
  const previousPath = process.env.ROPILOT_STUDIO_PATH;
  process.env.ROPILOT_STUDIO_PATH = launcher;
  const studio = new Studio();
  const server = makeServer({studio,secret:key,config:makeConfig()});
  t.after(async () => {
    if (previousPath === undefined) delete process.env.ROPILOT_STUDIO_PATH;
    else process.env.ROPILOT_STUDIO_PATH = previousPath;
    const child = studio.process;
    studio.close();
    server.closeAllConnections();
    server.close();
    if (child?.exitCode === null) await once(child,'exit');
    await rm(directory,{recursive:true,force:true,maxRetries:5});
  });

  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const request = (path, token=key, {method='GET', body, origin}={}) => fetch(url + path,{
    method, headers:{
      Authorization:'Bearer ' + token,
      ...(origin ? {Origin:origin} : {}),
      ...(body ? {'Content-Type':'application/json'} : {})
    }, body:body ? JSON.stringify(body) : undefined
  });
  const control = (path, token) => request(path,token,{method:'POST'});
  const chat = (token,body) => request('/v1/chat/completions',token,{method:'POST',body});
  const status = token => request('/status',token).then(r => r.json());

  assert.equal((await request('/status','bad-key')).status,401);
  assert.equal((await request('/status',key,{origin:'https://unrelated.invalid'})).status,403);
  assert.equal((await control('/api/start',keyA)).status,403);
  assert.equal((await chat(keyA,{prompt:'paused'})).status,503);
  const opened = await control('/studio/open');
  assert.equal(opened.status,200,JSON.stringify(await opened.json()));
  assert.equal((await control('/api/start')).status,409);

  const window = await studio.page();
  await window.evaluate(() => {
    app.credits = true;
    delete app.projects[0].apiKey;
  });
  let response = await control('/api/start');
  assert.equal((await response.json()).error.code,'route_project_key');
  await window.evaluate(() => {app.projects[0].apiKey = 'fixture-credential-a'});
  response = await control('/api/start');
  assert.equal(response.status,200,JSON.stringify(await response.json()));

  const getModels = token => request('/v1/models',token).then(r => r.json()).then(r => r.data.map(model => model.id));
  assert.deepEqual(await getModels(keyA),['ropilot-credits','alpha']);
  assert.deepEqual(await getModels(keyB),['ropilot-credits','beta']);
  assert.deepEqual(await getModels(key),['ropilot-credits','alpha','beta']);
  assert.equal((await request('/v1/models/beta',keyA)).status,404);
  assert.deepEqual((await request('/v1/prompts',keyA).then(r => r.json())).data,[{id:'review',object:'prompt'}]);
  assert.equal((await chat(keyA,{model:'beta',prompt:'wrong route'})).status,404);
  assert.equal((await chat(keyB,{...baseChat})).status,403);
  assert.equal((await chat(keyA,{prompt:'cannot use high',reasoning_effort:'high'})).status,400);

  const streamed = await chat(keyB,{
    model:'beta',prompt:'hello world',reasoning_effort:'medium',stream:true,
    stream_options:{include_usage:true},ropilot_events:true
  });
  assert.equal(streamed.status,200);
  assert.match(streamed.headers.get('content-type'),/text\/event-stream/);
  await window.waitForFunction(() => app.busy);
  const queued = chat(keyA,{prompt:'omit charge',prompt_id:'review',reasoning_effort:'low'});
  await new Promise(resolve => setTimeout(resolve,60));
  assert.equal((await status(keyA)).queued,1);
  assert.equal((await chat(keyA,{prompt:'too many queued'})).status,429);
  const frames = (await streamed.text()).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => frame.slice(6));
  assert.equal(frames.pop(),'[DONE]');
  const chunks = frames.map(JSON.parse);
  assert.equal(chunks.map(chunk => chunk.choices[0]?.delta.content || '').join(''),'Reply via b beta medium\n\nDone');
  assert.ok(chunks.some(chunk => chunk.ropilot?.activity?.status === 'running'));
  assert.deepEqual(chunks.at(-1).usage,{prompt_tokens:14,completion_tokens:6,total_tokens:20});
  assert.equal(chunks.at(-1).ropilot.credits_charged,0.25);
  const completion = await (await queued).json();
  assert.match(completion.choices[0].message.content,/Reply via a alpha low/);
  assert.equal(completion.ropilot.credits_charged,null);

  const toolResponse = await chat(keyA,{...baseChat,tool_choice:'required',stream:true});
  const toolEvents = (await toolResponse.text()).split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
  const call = toolEvents.find(frame => frame.choices[0]?.delta.tool_calls)?.choices[0].delta.tool_calls[0];
  assert.equal(call.function.name,'lookup');
  assert.equal(toolEvents.at(-1).choices[0].finish_reason,'tool_calls');
  const {index,...clientCall} = call;
  assert.equal(index,0);
  const followup = await chat(keyA,{...baseChat,messages:[...baseChat.messages,
    {role:'assistant',content:null,tool_calls:[clientCall]},
    {role:'tool',tool_call_id:call.id,content:'Found it'}
  ]});
  assert.match((await followup.json()).choices[0].message.content,/Tool result received/);
  const routeUsage = await request('/v1/usage',keyA).then(r => r.json());
  assert.equal(routeUsage.reported_credits,0.5);
  assert.equal(routeUsage.unreported_cost_requests,2);

  const panel = await window.context().newPage();
  await panel.goto(url);
  await panel.getByRole('button',{name:'Check connection'}).click();
  await panel.locator('#model option[value="alpha"]').waitFor({state:'attached'});
  await panel.getByRole('combobox',{name:'Model',exact:true}).click();
  await panel.getByRole('option',{name:'alpha',exact:true}).click();
  await panel.locator('#prompt').fill('test from panel');
  await panel.getByRole('button',{name:'Send prompt'}).click();
  await panel.waitForFunction(() => document.querySelector('#reply').textContent.includes('Done'));
  await panel.waitForFunction(() => document.querySelector('#usage').textContent.includes('0.25'));
  await panel.close();

  await window.evaluate(() => {delete app.projects[1].apiKey});
  const lostKey = await chat(keyB,{prompt:'do not fall back'});
  assert.equal((await lostKey.json()).error.code,'project_key_missing');
  assert.equal((await status(keyB)).enabled,false);
  assert.equal((await control('/api/pause')).status,200);
});
