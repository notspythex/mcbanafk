# Minecraft Bot Manager (WispByte compatible)

Runs 4 Java Edition offline-mode accounts on `bananasmp.net:25565`. Each bot joins, runs `/login`, waits for the server to confirm it, runs `/server randomkits`, waits for the transfer, then stays AFK. Optional dashboard with live console.

**Read this first: what has and has not been tested**

| Tested | Not tested |
|---|---|
| 63 automated tests, all passing on Node 22.23.5 (config, state machine, reconnect, dashboard API, Socket.IO, duplicate prevention, stop behaviour, errors) | **Real connection to `bananasmp.net`** (I have no way to reach it) |
| Real Mineflayer clients against a local protocol-level mock server that imitates login + `/server` transfer (4 bots reach AFK, kick reconnects only that bot, Stop All stays quiet) | **WispByte itself** (panel UI, Node switching, port exposure) |
| Dashboard in headless Chromium, desktop and 390px mobile width | Any server version other than 1.20.4 |

The mock server shows the logic is sound. It cannot show that bananasmp.net's login plugin prints the messages this project looks for. Use "Test one bot first" below before running all four.

---

## 1. Files and where they go

Upload **everything inside the ZIP** to the root of your WispByte server (`/home/container/`), keeping the folders:

```text
/home/container/
├── index.js              <- startup file
├── package.json
├── package-lock.json
├── config.json           <- you edit this
├── src/
│   ├── botManager.js     per-bot reconnect policy
│   ├── bot.js            per-bot state machine (Mineflayer)
│   ├── reconnectManager.js   backoff + single timer per bot
│   ├── config.js         validation
│   ├── dashboard.js      Express + Socket.IO
│   └── logger.js         logging + password redaction
├── public/               dashboard (index.html, style.css, app.js)
├── scripts/check.js      preflight check
└── tests/                optional, can be skipped
```

Do **not** upload `node_modules`. Install it on the server (step 4). The most common cause of "startup file not found" is uploading the folder *itself* so files end up in `/home/container/minecraft-bot-manager/index.js`. After upload, `index.js` must be directly in the root of the file manager.

## 2. Configure `config.json`

Open `config.json` and set:

- `login.password`: your Minecraft login password.
- `dashboard.pin`: at least 6 characters.

The app **refuses to start** while either is still `CHANGE_ME`, and tells you why. Prefer not storing secrets in a file? Use environment variables instead (panel Startup/Variables tab): `MC_PASSWORD`, `DASHBOARD_PIN`. They override `config.json`.

Everything else is already set to your requirements. Useful options:

| Key | Meaning |
|---|---|
| `server.version` | `"auto"` detects via server ping. If you see a version error, set it explicitly, e.g. `"1.20.4"`. |
| `reconnect.enabled` | `true` = a dropped bot reconnects by itself (others are NOT touched). `false` = no auto-reconnect at all. |
| `reconnect.delaySeconds` | Base delay before a bot's reconnect (default 15). Old name `groupDelaySeconds` still works. |
| `login.requireConfirmation` | `false` (default now): if no success message is recognised, the bot continues to `/server` after `login.timeoutSeconds`; the server switch proves whether login worked. `true` = strict. |
| `login.resendAfterSeconds` / `maxSends` | If the server shows the login prompt again this many seconds after `/login`, the command is resent (at most `maxSends` times in total, default 2, to stay under the server's attempt limit). |
| `antiVpnFallback` | Used ONLY after the server kicks a bot for proxy/VPN. `enabled`, optional alternate `host`/`port` (e.g. an entry address the staff gave you), and optional `socksProxy` {host, port, username, password} (password can come from env `SOCKS_PASSWORD`). If the fallback route is also blocked, the bot stops (no retry loop). Run `npm install` after updating (adds the `socks` package). |
| `connection.blockedPatterns` | If a kick message contains one of these (default: proxy, vpn), the bot is NOT retried and a clear error is shown. |
| `reconnect.backoffFactor` / `maxDelaySeconds` | Delay doubles each failed round, capped (default 300s). |
| `reconnect.maxAttempts` | `0` = unlimited. |
| `connection.startStaggerSeconds` | Gap between bot joins (default 6). Keep it at 3 or more or the server may throttle you. |
| `destination.confirmPatterns` | Optional. Chat text proving you are on the destination (see section 7). |
| `dashboard.enabled` | `false` runs bots only. |
| `autoStart` | `false` waits for Start in the dashboard. |

## 3. Node.js 22 or newer (fixes the EBADENGINE error)

Mineflayer 4.39.0 declares `engines: node >= 22`, which I confirmed with `npm view`. Node 19.9.0 cannot run it.

I could **not** find WispByte's own documentation for switching Node versions, so I can't give you verified click-by-click steps. WispByte's file paths (`/home/container`) suggest a Pterodactyl-style panel. On those panels the Node version is the **Docker image** chosen on the **Startup** tab. A general guide for that panel family: https://docs.jasmeow.systems/books/pterodactyl-guides/page/changing-docker-containers-images-for-your-servers (not WispByte-specific, so treat it as a hint).

1. Open your server, go to **Startup**.
2. Find the Docker image / Node.js version selector and choose Node.js 22 (or 24).
3. Restart.
4. Verify: the first console line prints `[INFO] Application started (Node 22.x.x)`. If it prints a lower version, the app exits with a clear message instead of failing mysteriously.

If no Node 22+ option exists on your plan, there is no workaround in this project: Mineflayer will not run. In that case ask WispByte support or use a different host.

## 4. Install dependencies and set the startup file

1. **Startup command:** `node index.js` (the root file). Some panels use a "main file" field instead: set it to `index.js`.
2. **Install packages (once):** if the panel does not run `npm install` for you, temporarily set the startup command to:
   `npm ci --omit=dev && node index.js`
   Start the server, wait for the install to finish, then you can change it back to `node index.js`.
3. Optional preflight: `node scripts/check.js` prints Node version, installed packages and config validity.

## 5. Port: how the dashboard fits on one allocated port

You have one public port (12849 on your plan).

- The bots are **outgoing** connections to bananasmp.net. They need no incoming port at all.
- No Minecraft server runs in this container, so nothing competes for your allocated port. The dashboard can use it. HTTP and Minecraft traffic are never mixed on a port here.
- `dashboard.port: "auto"` (default) uses the first of `DASHBOARD_PORT`, `SERVER_PORT`, `PORT`. Pterodactyl-style panels normally set `SERVER_PORT` to the allocated port, but I could not verify that for WispByte. **To be certain, set `"port": 12849` in config.json.**
- The app never falls back to 3000. If no port can be determined, it logs a warning and runs the bots without a dashboard.
- Open `http://<your-server-IP>:12849` (the IP/hostname shown on your panel's Network tab).
- If the port is already used (for example you also run a Minecraft server on 12849), the dashboard fails with a clear error and **the bots keep running**. Then either disable the dashboard (`dashboard.enabled: false`) or run only one of the two.
- I could not verify that WispByte forwards HTTP on that port from the public internet. If the page does not load while the console shows `Dashboard web server listening`, run bots-only; everything works through logs.
- It is plain HTTP, not HTTPS. The PIN travels unencrypted, so use a PIN you use nowhere else.

## 6. Test one bot before all four

1. Set the startup command to: `node index.js --only=SpyGotMace` (or set env `ONLY_BOT=SpyGotMace`). Only that bot starts. The others stay stopped but can still be started from the dashboard.
2. Watch the console. A healthy run looks like:

```text
[INFO] Application started (Node 22.x.x)
[CONNECTING] SpyGotMace
[CONNECTED] SpyGotMace connected to bananasmp.net (server version 1.x.x)
[CHAT] SpyGotMace: <server's login prompt>
[AUTHENTICATING] SpyGotMace
[CHAT] SpyGotMace: <server's success message>
[AUTHENTICATED] SpyGotMace
[SWITCHING] SpyGotMace -> randomkits
[AFK] SpyGotMace successfully joined randomkits (confirmed by login packet)
```

3. Join the server yourself and check that the bot appears in the player list on randomkits.
4. Only then switch the startup command back to `node index.js`.

If it stops at `AUTHENTICATING` and later shows `login not confirmed within 20s`, the server's success message does not match `login.successPatterns`. Look at the `[CHAT]` lines, copy a distinctive fragment of the real success message into `successPatterns` (case-insensitive substring match), and retry.

## 7. How to verify all four are genuinely connected

A bot is shown as AFK only after all of these happened, in order:

1. Mineflayer received the server's join-game packet (not just a TCP connection).
2. `/login` was sent, and a message matching `successPatterns` came back.
3. `/server randomkits` was sent, and the server then sent a new join/respawn packet (the proxy transfer), and the connection stayed up for `settleSeconds`.

Ways to check yourself:

- Dashboard: each card says `AFK`, `Target: randomkits: confirmed`, with a running uptime. Header says `4 of 4 confirmed AFK`.
- Console: four `[AFK] ... successfully joined randomkits` lines.
- In game: `/list` or the player list shows all four usernames.
- Dashboard command box: select a bot and send `/server`. Many proxies answer with the server you are currently on. I can't verify bananasmp.net's wording.

**Honest limitation:** step 3 proves a transfer happened, not the name of the server you landed on, because the Minecraft protocol does not carry it. For name-level proof, find a chat message the server shows on arrival and put a fragment in `destination.confirmPatterns`. When that list is non-empty, AFK is only reported after such a message appears.

## 8. Behaviour reference

- **Per-bot reconnect:** when a bot drops (kick, timeout, error), only that bot is retried. The other bots keep running. Delay = `delaySeconds * backoffFactor^attempt`, capped at `maxDelaySeconds`, with small jitter. A bot's backoff resets after it stays AFK for `stableSeconds`.
- **Stop All / single Stop** never trigger a reconnect. A bot you stopped by hand stays stopped.
- **Proxy/VPN block** ("You can't connect using a proxy or VPN") is treated as fatal for that bot, see Troubleshooting.
- **Wrong password or unregistered account** is treated as fatal for that bot: it is not retried, to avoid lockouts or IP bans.
- **One timer, one instance per bot:** duplicate starts are refused, stale events from old connections are ignored.
- **Passwords** are never printed. Every log line passes through a redactor, and the API never returns config values.
- The process stays up on unexpected errors (they are logged). Ctrl+C / SIGTERM stops bots cleanly.

## 9. Dashboard security

PIN login (stored only as a hash in memory), 12 h session token, lockout after 5 wrong PINs per 10 minutes per IP, strict CSP and security headers, nothing loaded from third-party hosts. Anyone with the PIN can start/stop bots and send chat as them, so keep the URL and PIN private.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `EBADENGINE` or "Node.js ... is too old" | Node below 22. Section 3. |
| `Cannot find module 'mineflayer'` | Dependencies not installed. Section 4. |
| `Cannot find module '/home/container/index.js'` | Files nested in a subfolder. Section 1. |
| `config: login.password is not set` | Edit `config.json` or set `MC_PASSWORD`. |
| `Dashboard could not start ... EADDRINUSE` | Port taken. Section 5. Bots keep running. |
| `connect ECONNREFUSED` / `ETIMEDOUT` | Server down, wrong host/port, or your host blocks outbound connections. |
| Kick: "cannot connect using a proxy or VPN" | The SERVER's anti-VPN filter flags WispByte's datacenter IP. Code cannot change your IP. Ask bananasmp.net staff to whitelist the WispByte IP (shown in the panel), or run the bots from a home PC / a host whose IP isn't flagged. The bot stops retrying instead of hammering the server. |
| `Connection throttled` kick | Raise `connection.startStaggerSeconds`. |
| Version / protocol error | Set `server.version` explicitly. |
| Stuck then `transfer to randomkits not confirmed` | `/server` is not how this network switches, or the server did not respond. Check `[CHAT]` lines. |

## 11. Running the tests yourself

```bash
npm ci
npm test
```

Check that using a bot account on bananasmp.net this way is allowed by its rules; many servers restrict AFK bots or multiple accounts.
