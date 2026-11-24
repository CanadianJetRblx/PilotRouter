# PilotRouter

PilotRouter gives local apps an OpenAI-style Chat Completions API backed by Ropilot Studio and Ropilot Credits.

> My Subscription Models support coming soon

## Quick start

Requires Node.js 22+ and Ropilot Studio.

```sh
npm ci
npm start
```

1. Open the panel at `http://127.0.0.1:8787/` and click **Open Studio**. If Studio is already running, save your work and close it first.
2. Sign in to Studio, select a dedicated test project, and choose **Ropilot Credits**.
3. Click **Start API** in PilotRouter. Test a prompt in the panel or point your client at `http://127.0.0.1:8787/v1`.

Keep Studio running while using the API. Studio can act on the selected project.

## API

Use `GET /v1/models` to list available models and `POST /v1/chat/completions` to send a request. Use `ropilot-credits` for the route's default model. The API supports streaming, model-specific reasoning effort, and observed Credits usage.

```json
{
  "model": "ropilot-credits",
  "messages": [{"role": "user", "content": "Reply with OK. Do not edit the project or run tools."}]
}
```

## Configuration

| Setting | Purpose |
| --- | --- |
| `npm start -- --port 9000` | Listen on a different loopback port. |
| `ROPILOT_BRIDGE_KEY` | Require API clients to send `Authorization: Bearer <key>`. The local panel needs no key. |
| `ROPILOT_STUDIO_PATH` | Point PilotRouter at the Studio executable if discovery fails. |
| [`bridge.example.json`](bridge.example.json) | Example for scoped client keys, project routing, and prompt presets. Copy it to `bridge.config.json` and use `npm run key` to generate client keys and hashes. |

Ropilot dashboard keys belong in Studio settings or the project's **Folder API Key** field. PilotRouter listens on loopback only.

Run `npm test` to verify the protocol and API authentication. On Linux, set `ROPILOT_TEST_BROWSER` to a Chromium executable to include the Studio fixture.

Made by **CanadianJet (lwklostincanada)**.
