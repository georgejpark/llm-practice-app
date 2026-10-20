# Running llm-practice-app on Proxmox

Self-hosting notes for the homelab (Proxmox VE hosts `pve5` and `pve2`). Everything below was derived from the code in this repository; `file:line` references point at it.

## Cloud-dependency verdict: NONE

| Question | Answer | Evidence |
|---|---|---|
| Cloud infrastructure (compute, storage, queue, database, managed service)? | **None.** One Node.js process that listens on a TCP port and serves static files from `public/`. No database, no queue, no object storage, no cloud SDK. | `src/server.js:10` (`app.listen(config.port, ...)`), `src/app.js:16` (`express.static(... 'public')`), `package.json:13-18` (the only dependencies are `@anthropic-ai/sdk`, `dotenv`, `express`, `openai`) |
| Outbound calls? | **One, to the selected model provider over HTTPS.** | `src/llm/anthropic.js:9` (`new Anthropic({ apiKey, maxRetries: 0 })`) and `:16` (`client.messages.create`); `src/llm/openai.js:8` (`new OpenAI({ apiKey, maxRetries: 0 })`) and `:15` (`client.chat.completions.create`); the adapter is chosen from `LLM_PROVIDER` in `src/llm/index.js:7-16` |
| Is that a cloud dependency? | **No.** Anthropic and OpenAI are paid SaaS APIs billed per token. Nothing is deployed to, stored in, or managed by a cloud account, and the service runs anywhere Node 20 runs. | same lines as above |
| Can the model be local too? | **Yes, with no code change.** The code never passes a base URL to either SDK constructor (`src/llm/anthropic.js:9`, `src/llm/openai.js:8`), so both SDKs fall back to their environment variables: `OPENAI_BASE_URL` (openai-node 4.80.0, `src/index.ts`, client constructor: `baseURL = Core.readEnv('OPENAI_BASE_URL')`, default `https://api.openai.com/v1`) and `ANTHROPIC_BASE_URL` (Anthropic TypeScript SDK client option `baseURL`, read from that variable when not passed). Point `OPENAI_BASE_URL` at an OpenAI-compatible server such as vLLM or Ollama and set `LLM_PROVIDER=openai`. | `.env.example:1-10` lists the related variable names |

The tests are fully offline: `test/app.test.js:8-24` injects a fake provider, `createProvider` is never called, and `src/llm/anthropic.js:8` / `src/llm/openai.js:7` only throw when a real adapter is built. So `npm test` needs neither a key nor a network.

## What it needs to run

| Need | Value | Evidence |
|---|---|---|
| Runtime | Node.js 20 or newer. Debian 13 "trixie" ships `nodejs` 20.19.2, which qualifies, so no third-party repo is needed. | `package.json:12` (`"engines": { "node": ">=20" }`) |
| Dependencies | `npm install` (the repo has no lockfile yet; `express`, `dotenv`, `@anthropic-ai/sdk ^0.50.0`, `openai ^4.80.0`) | `package.json:13-18` |
| Listening port | `PORT`, default **3000/tcp**, all interfaces | `src/config.js:12`, `src/server.js:10` |
| Outbound | HTTPS 443 to `api.anthropic.com` or `api.openai.com`; or plain HTTP on the LAN to a local model server | `src/llm/anthropic.js:9`, `src/llm/openai.js:8` |
| Environment variables read by the app | `LLM_PROVIDER`, `PORT`, `REQUEST_TIMEOUT_MS`, `MAX_RETRIES`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | `src/config.js:11-23` |
| Environment variables read by the SDKs | `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` (optional, only for a local server) | SDK constructors, see the verdict table |
| Required secret | `ANTHROPIC_API_KEY` for the default provider, or `OPENAI_API_KEY` when `LLM_PROVIDER=openai`. Startup throws without it. | `src/llm/anthropic.js:8`, `src/llm/openai.js:7` |
| `.env` file | Loaded from the working directory by `dotenv`; variables already in the environment win over the file | `src/config.js:1` |
| State on disk | None. Conversation history is held by the browser page and sent with every request. | `public/index.html:30` and `:62`, `src/routes/ask.js:11` |
| Shutdown | Handles `SIGINT`/`SIGTERM`, finishes in-flight requests, hard exit after 5 s | `src/server.js:15-21` |
| Footprint | Small: Express plus two SDK clients, under 150 MB RSS, idle CPU between requests | measured in the test plan below |

## Proxmox plan

One small **unprivileged LXC on pve5** (Proxmox VE 9.2, 2x Xeon Platinum 8168, 30 GiB RAM, NVMe ZFS pool `nvmepool`; already hosts CT 100 `pulse` and CT 101 `rea`). pve2 would work just as well; pve5 is chosen so pve2 stays free for the GPU model server described below. No GPU is needed by this app itself.

| Setting | Value |
|---|---|
| CT ID / hostname | **102** / `llmapp` |
| Template | `debian-13-standard_13.6-1_amd64.tar.zst` (already on pve5 as `local:vztmpl/...`, the same one CT 101 was built from) |
| Cores / RAM / swap | 2 / 1024 MB / 512 MB |
| Root disk | 8 GB on `nvmepool` (Node 20 + `node_modules` is well under 1 GB) |
| Network | `vmbr0`, DHCP. Read the lease with `pct exec 102 -- hostname -I`, then reserve it in the gateway. |
| Unprivileged | yes, with `nesting=1` so systemd and npm behave |
| App user / path | `app` / `/opt/llm-practice-app` |
| Exposed port | 3000/tcp on the LAN only; no reverse proxy or TLS in this plan |
| Autostart | `onboot 1`, plus a systemd unit inside the container |

### 1. Create the container (run on the pve5 host as root: `ssh pve5`)

```bash
pct create 102 local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --hostname llmapp --tags llm --unprivileged 1 --features nesting=1 \
  --cores 2 --memory 1024 --swap 512 --rootfs nvmepool:8 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp,firewall=1 \
  --ostype debian --onboot 1 --timezone host --start 1
```

### 2. Install Node and the app (run inside the container: `pct enter 102` on pve5, you are root there)

The clone works as written once the GitHub repository is public; for a private repository use a deploy key or copy the tree in with `pct push`.

```bash
apt-get update && apt-get install -y nodejs npm git curl
git clone https://github.com/georgejpark/llm-practice-app.git /opt/llm-practice-app
useradd -r -d /opt/llm-practice-app -s /usr/sbin/nologin app
chown -R app:app /opt/llm-practice-app
cd /opt/llm-practice-app && runuser -u app -- npm install
```

### 3. Configure (still inside the container)

Copy the template and put the real key in it with an editor. The file holds the secret, so it stays owner-only and must never be committed or pasted anywhere.

```bash
cd /opt/llm-practice-app && cp .env.example .env && chown app:app .env && chmod 600 .env
nano /opt/llm-practice-app/.env
```

Keep `LLM_PROVIDER=anthropic`, set `ANTHROPIC_API_KEY`, and leave `ANTHROPIC_MODEL=claude-opus-5-5` (or set `claude-sonnet-5-5` / `claude-haiku-5-5` for a cheaper model). Delete the `OPENAI_*` lines when using Claude; the `sk-...` placeholders in the template are not valid values.

### 4. Run it as a service (still inside the container)

```bash
cat > /etc/systemd/system/llm-practice-app.service <<'EOF'
[Unit]
Description=llm-practice-app (Node.js LLM question-answering service)
After=network-online.target
Wants=network-online.target

[Service]
User=app
WorkingDirectory=/opt/llm-practice-app
EnvironmentFile=/opt/llm-practice-app/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/opt/llm-practice-app

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now llm-practice-app
systemctl status llm-practice-app --no-pager
```

Then, back on pve5, take a snapshot of the working state: `pct snapshot 102 provisioned`.

### Local model instead of the paid API (optional, later)

pve2 is the GPU host, planned with 2x NVIDIA CMP 170HX (GA100, Ampere, 8 GB HBM2e each as shipped, so pick a model that fits in 8 GB: a 7B or 8B model at 4-bit). Either server speaks the OpenAI chat-completions API, so the app only needs four variables changed in `/opt/llm-practice-app/.env` on CT 102, then `systemctl restart llm-practice-app`:

- **Ollama on pve2** (`192.168.1.132`), started with `OLLAMA_HOST=0.0.0.0` so it listens on the LAN, after `ollama pull llama3.1:8b`:
  `LLM_PROVIDER=openai`, `OPENAI_BASE_URL=http://192.168.1.132:11434/v1`, `OPENAI_MODEL=llama3.1:8b`, `OPENAI_API_KEY=local`
- **vLLM on pve2**, started with `--model Qwen/Qwen2.5-7B-Instruct-AWQ --max-model-len 4096 --host 0.0.0.0 --port 8000`:
  `LLM_PROVIDER=openai`, `OPENAI_BASE_URL=http://192.168.1.132:8000/v1`, `OPENAI_MODEL=Qwen/Qwen2.5-7B-Instruct-AWQ`, `OPENAI_API_KEY=local`

`OPENAI_API_KEY` must be non-empty because `src/llm/openai.js:7` refuses to build the adapter without one; local servers ignore its value. `ANTHROPIC_BASE_URL` is the equivalent knob for an Anthropic-compatible local endpoint, but the two servers above speak the OpenAI shape, so use the OpenAI adapter.

### Remove it

On pve5: `pct stop 102 && pct destroy 102 --purge`.

## Test plan

Run steps 1-7 inside the container (`ssh pve5`, then `pct enter 102`). Steps 8-10 run on pve5 or the Mac as noted. Expected results come from the code and the test suite.

1. **Offline tests pass.** Expect `# pass 13` and `# fail 0` (8 HTTP tests in `test/app.test.js`, 5 unit tests in `test/retry.test.js`).
   ```bash
   cd /opt/llm-practice-app && runuser -u app -- npm test
   ```
2. **Service is up and reports the provider.** Expect `active`, then `{"ok":true,"provider":"anthropic","model":"claude-opus-5-5"}` (`src/routes/ask.js:18-20`).
   ```bash
   systemctl is-active llm-practice-app
   curl -s http://127.0.0.1:3000/api/health
   ```
3. **Validation rejects bad input before any tokens are spent.** Expect HTTP 400 three times, with the messages from `src/middleware/validate.js:9`, `:12` and `:24`. The service log must show no `llm retry` or `error` line for these.
   ```bash
   curl -s -X POST http://127.0.0.1:3000/api/ask -H 'content-type: application/json' -d '{"question":""}'
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/ask -H 'content-type: application/json' \
     -d "{\"question\":\"$(head -c 4001 /dev/zero | tr '\0' x)\"}"
   curl -s -X POST http://127.0.0.1:3000/api/ask -H 'content-type: application/json' \
     -d '{"question":"hi","history":[{"role":"system","content":"x"}]}'
   ```
4. **Real round trip (spends a few hundred tokens).** Expect HTTP 200 with `answer`, `provider: "anthropic"`, `model`, `usage.inputTokens`, `usage.outputTokens` and `latencyMs`, and one log line `<request id> POST /api/ask 200 <n>ms` (`src/middleware/errors.js:11`).
   ```bash
   curl -s -X POST http://127.0.0.1:3000/api/ask -H 'content-type: application/json' \
     -d '{"question":"In one sentence, what is a Kubernetes operator?"}'
   journalctl -u llm-practice-app -n 3 --no-pager
   ```
5. **Timeout and retry path.** A throwaway instance on port 3001 with a 1 ms per-attempt timeout and one retry (inline variables win over `.env`, `src/config.js:1`). Expect a log line `llm retry 1 after 500ms: ...` (`src/llm/index.js:39-40`), exactly two attempts, and a JSON 5xx reply with the generic message and a `requestId` (`src/middleware/errors.js:24-27`). The status is 504 when the SDK's abort error is recognised as a timeout and 502 otherwise (`src/llm/anthropic.js:55-58`); both mean the timeout fired and the retry budget was spent.
   ```bash
   cd /opt/llm-practice-app
   REQUEST_TIMEOUT_MS=1 MAX_RETRIES=1 PORT=3001 node src/server.js &
   sleep 1
   curl -s -X POST http://127.0.0.1:3001/api/ask -H 'content-type: application/json' -d '{"question":"hi"}'
   kill %1
   ```
6. **Bad key is not retried and not leaked.** Expect HTTP 500 with `"error":"The assistant is unavailable right now. Please try again."` and a `requestId`, a log line `error 500: anthropic: invalid API key` (`src/llm/anthropic.js:46-47`), and no `llm retry` line.
   ```bash
   cd /opt/llm-practice-app
   ANTHROPIC_API_KEY=not-a-real-key PORT=3001 node src/server.js &
   sleep 1
   curl -s -X POST http://127.0.0.1:3001/api/ask -H 'content-type: application/json' -d '{"question":"hi"}'
   kill %1
   ```
7. **Graceful shutdown and footprint.** Expect `SIGTERM received, shutting down` followed by a new `listening on http://localhost:3000 (provider=anthropic, model=claude-opus-5-5)` line (`src/server.js:11` and `:17`), and a node RSS under 150 MB.
   ```bash
   systemctl restart llm-practice-app && sleep 1 && journalctl -u llm-practice-app -n 4 --no-pager
   ps -o rss=,cmd= -C node
   ```
8. **Reachable from the LAN (Mac terminal).** Expect the same health JSON as step 2.
   ```bash
   curl -s "http://$(ssh pve5 'pct exec 102 -- hostname -I' | awk '{print $1}'):3000/api/health"
   ```
   Then open `http://<that address>:3000/` in a browser, ask two questions in a row, and confirm the second answer can refer to the first (history is sent with every request, `public/index.html:57`).
9. **Survives a reboot (on pve5).** Expect `active`.
   ```bash
   pct reboot 102 && sleep 15 && pct exec 102 -- systemctl is-active llm-practice-app
   ```
10. **Local model variant (only after the pve2 model server exists).** From CT 102, `curl -s http://192.168.1.132:11434/v1/models` must list the pulled model; after switching `.env` as described above and restarting, step 2 must report `"provider":"openai"` with the local model name and step 4 must return an answer with non-zero `usage` and no `llm retry` lines.

Sign-off: steps 1-9 green with the paid provider. Step 10 is optional and depends on the GPU host.
