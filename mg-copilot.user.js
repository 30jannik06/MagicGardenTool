// ==UserScript==
// @name         Magic Garden Co-Pilot
// @namespace    mg-copilot
// @version      1.0
// @description  Ernte-Timer, ROI-Rechner und Session-Stats für magicgarden.gg
// @match        https://magicgarden.gg/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/30jannik06/MagicGardenTool/main/mg-copilot.user.js
// @downloadURL  https://raw.githubusercontent.com/30jannik06/MagicGardenTool/main/mg-copilot.user.js
// ==/UserScript==
(function() {
    if (window.mgDashboard) window.mgDashboard.destroy();

    // 1. Settings & Persistence
    const savedConfig = JSON.parse(localStorage.getItem('mg_copilot_cfg') || '{}');
    const cfg = Object.assign({
        top: 16,
        left: Math.max(16, window.innerWidth - 380),
        opacity: 0.95,
        sound: true,
        desktopNotify: false,
        sortBy: 'time',
        minimized: false
    }, savedConfig);

    const saveCfg = () => localStorage.setItem('mg_copilot_cfg', JSON.stringify(cfg));

    // Desktop Notification Permissions
    if (cfg.desktopNotify && Notification.permission !== "granted") {
        Notification.requestPermission();
    }

    // 2. Audio Engine (Web Audio API) — created lazily on first user gesture
    // so browsers don't autoplay-block it (a context created at load time
    // often starts 'suspended' and swallows the first ready-chime silently).
    let audioCtx = null;
    function ensureAudioCtx() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return audioCtx;
    }
    window.addEventListener('pointerdown', ensureAudioCtx, { once: true });
    window.addEventListener('keydown', ensureAudioCtx, { once: true });

    function playChime() {
        if (!cfg.sound) return;
        const ctx = ensureAudioCtx();
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.12); // G5
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.25);
    }

    // 3. Game Metadata & ROI Database
    const PLANT_DATA = {
        Carrot: { seedCost: 10, growTimeSec: 5, baseSell: 20, slots: 1 },
        Strawberry: { seedCost: 50, growTimeSec: 10, baseSell: 20, slots: 5 }, // 5 Wellen
        Cabbage: { seedCost: 20, growTimeSec: 35, baseSell: 42, slots: 1 },
        Beet: { seedCost: 210, growTimeSec: 60, baseSell: 314, slots: 1 },
        FavaBean: { seedCost: 100, growTimeSec: 120, baseSell: 40, slots: 8 }
    };

    const origDocTitle = document.title;

    // 4. UI Shell
    const hud = document.createElement('div');
    hud.id = 'mg-copilot';
    Object.assign(hud.style, {
        position: 'fixed',
        top: `${cfg.top}px`,
        left: `${cfg.left}px`,
        width: '360px',
        backgroundColor: `rgba(15, 23, 42, ${cfg.opacity})`,
        color: '#f8fafc',
        fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
        fontSize: '14px',
        lineHeight: '1.4',
        borderRadius: '12px',
        padding: '14px',
        boxShadow: '0 12px 35px rgba(0,0,0,0.65)',
        border: '1px solid rgba(255,255,255,0.12)',
        zIndex: '9999999',
        backdropFilter: 'blur(8px)',
        userSelect: 'none'
    });

    hud.innerHTML = `
        <div id="mg-header" style="display:flex; justify-content:space-between; align-items:center; cursor:grab; padding-bottom:10px; border-bottom:1px solid #334155;">
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-weight:700; font-size:16px; color:#38bdf8;">⚡ Co-Pilot</span>
                <span id="mg-coins" style="color:#facc15; font-size:14px; font-weight:700;">🪙 --</span>
                <span id="mg-identity" title="Erkennung deiner eigenen Spieler-Identität" style="font-size:11px; color:#f59e0b;">⏳ Identität...</span>
            </div>
            <div style="display:flex; gap:6px;">
                <button id="mg-btn-min" style="background:#1e293b; color:#cbd5e1; border:1px solid #475569; border-radius:5px; width:26px; height:26px; cursor:pointer; font-size:14px;">_</button>
                <button id="mg-btn-close" style="background:#ef4444; color:#fff; border:none; border-radius:5px; width:26px; height:26px; cursor:pointer; font-weight:bold; font-size:14px;">✕</button>
            </div>
        </div>

        <div id="mg-body" style="display:${cfg.minimized ? 'none' : 'block'}; margin-top:12px;">
            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:4px; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #1e293b;">
                <button class="mg-tab-btn" data-tab="timers" style="background:#0284c7; color:#fff; border:none; border-radius:6px; padding:8px 2px; cursor:pointer; font-size:11px; font-weight:600;">🌱 Beete</button>
                <button class="mg-tab-btn" data-tab="shop" style="background:#1e293b; color:#cbd5e1; border:none; border-radius:6px; padding:8px 2px; cursor:pointer; font-size:11px; font-weight:600;">🛒 Kauf</button>
                <button class="mg-tab-btn" data-tab="stats" style="background:#1e293b; color:#cbd5e1; border:none; border-radius:6px; padding:8px 2px; cursor:pointer; font-size:11px; font-weight:600;">📊 Stats</button>
                <button class="mg-tab-btn" data-tab="cfg" style="background:#1e293b; color:#cbd5e1; border:none; border-radius:6px; padding:8px 2px; cursor:pointer; font-size:11px; font-weight:600;">⚙️ Setup</button>
            </div>

            <!-- Tab 1: Timers -->
            <div id="mg-tab-timers" style="max-height:55vh; overflow-y:auto; display:flex; flex-direction:column; gap:7px;"></div>

            <!-- Tab 2: Smart Shopping -->
            <div id="mg-tab-shop" style="display:none; max-height:55vh; overflow-y:auto; flex-direction:column; gap:8px;"></div>

            <!-- Tab 3: Analytics -->
            <div id="mg-tab-stats" style="display:none; flex-direction:column; gap:8px;"></div>

            <!-- Tab 4: Config -->
            <div id="mg-tab-cfg" style="display:none; flex-direction:column; gap:14px;">
                <label style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Transparenz</span>
                    <input id="mg-cfg-opacity" type="range" min="0.4" max="1" step="0.05" value="${cfg.opacity}" style="width:120px;">
                </label>
                <label style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Desktop-Push</span>
                    <input id="mg-cfg-notify" type="checkbox" ${cfg.desktopNotify ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer;">
                </label>
                <label style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Audio-Alerts</span>
                    <input id="mg-cfg-sound" type="checkbox" ${cfg.sound ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer;">
                </label>
                <label style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Sortierung</span>
                    <select id="mg-cfg-sort" style="background:#1e293b; color:#f8fafc; border:1px solid #475569; border-radius:5px; font-size:13px; padding:4px 6px;">
                        <option value="time" ${cfg.sortBy === 'time' ? 'selected' : ''}>Restzeit</option>
                        <option value="slot" ${cfg.sortBy === 'slot' ? 'selected' : ''}>Slot-ID</option>
                    </select>
                </label>
            </div>
        </div>
    `;
    document.body.appendChild(hud);

    // 5. State Management
    const notifiedTiles = new Set();
    const domRows = new Map();

    // Monkey-patch WebSocket.prototype.send once, keep the original around
    // so destroy() can fully restore it instead of leaving a dangling patch.
    const origWSSend = WebSocket.prototype.send;
    let wsPatchInstalled = false;

    window.mgDashboard = {
        state: {
            tileObjects: {},
            inventory: [],
            coins: 0,
            serverTime: 0,
            syncLocalTime: 0,
            sessionStartCoins: null,
            sessionStartTime: Date.now(),
            totalIdleSeconds: 0,
            myUserId: null,
            myUserSlotIndex: null
        },
        intervalId: null,
        destroy() {
            if (this.intervalId) clearInterval(this.intervalId);
            window.removeEventListener('keydown', this._keyListener);
            window.removeEventListener('pointerdown', ensureAudioCtx);
            window.removeEventListener('keydown', ensureAudioCtx);
            if (this._wsListener && window.mgBot && window.mgBot.ws) {
                window.mgBot.ws.removeEventListener('message', this._wsListener);
            }
            if (wsPatchInstalled) {
                WebSocket.prototype.send = origWSSend;
                wsPatchInstalled = false;
            }
            document.title = origDocTitle;
            hud.remove();
            window.mgDashboard = null;
            console.log("%c[Co-Pilot] Beendet.", "color:#ef4444;");
        }
    };

    // 6. Drag & Drop
    const header = document.getElementById('mg-header');
    let isDragging = false, startX, startY;
    header.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        startX = e.clientX - hud.offsetLeft;
        startY = e.clientY - hud.offsetTop;
    };
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        hud.style.left = `${Math.max(0, Math.min(window.innerWidth - hud.offsetWidth, e.clientX - startX))}px`;
        hud.style.top = `${Math.max(0, Math.min(window.innerHeight - hud.offsetHeight, e.clientY - startY))}px`;
    });
    window.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        cfg.left = hud.offsetLeft;
        cfg.top = hud.offsetTop;
        saveCfg();
    });

    // 7. Tab Routing & Settings Listener
    document.getElementById('mg-btn-close').onclick = () => window.mgDashboard.destroy();
    const bodyEl = document.getElementById('mg-body');
    document.getElementById('mg-btn-min').onclick = () => {
        cfg.minimized = !cfg.minimized;
        bodyEl.style.display = cfg.minimized ? 'none' : 'block';
        saveCfg();
    };

    hud.querySelectorAll('.mg-tab-btn').forEach(btn => {
        btn.onclick = () => {
            const target = btn.dataset.tab;
            hud.querySelectorAll('.mg-tab-btn').forEach(b => {
                b.style.background = '#1e293b';
                b.style.color = '#cbd5e1';
            });
            btn.style.background = '#0284c7';
            btn.style.color = '#fff';
            ['timers', 'shop', 'stats', 'cfg'].forEach(t => {
                document.getElementById(`mg-tab-${t}`).style.display = (t === target) ? 'flex' : 'none';
            });
        };
    });

    document.getElementById('mg-cfg-opacity').oninput = (e) => {
        cfg.opacity = e.target.value;
        hud.style.backgroundColor = `rgba(15, 23, 42, ${cfg.opacity})`;
        saveCfg();
    };
    document.getElementById('mg-cfg-sound').onchange = (e) => {
        cfg.sound = e.target.checked;
        saveCfg();
    };
    document.getElementById('mg-cfg-sort').onchange = (e) => {
        cfg.sortBy = e.target.value;
        saveCfg();
    };
    const shopTab = document.getElementById('mg-tab-shop');
    shopTab.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn || btn.disabled) return;
        if (btn.dataset.action === 'sell-all') sellAllCrops();
    });

    const timerContainer = document.getElementById('mg-tab-timers');
    timerContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn || btn.disabled) return;
        if (btn.dataset.action === 'harvest-all') {
            if (pendingHarvestTimers.size > 0) stopAllHarvesting();
            else harvestAllReady();
        }
    });

    document.getElementById('mg-cfg-notify').onchange = (e) => {
        cfg.desktopNotify = e.target.checked;
        if (cfg.desktopNotify && Notification.permission !== "granted") {
            Notification.requestPermission();
        }
        saveCfg();
    };

    // Hotkey: H
    window.mgDashboard._keyListener = (e) => {
        if (e.key.toLowerCase() === 'h' && !['INPUT', 'SELECT'].includes(document.activeElement.tagName)) {
            hud.style.display = hud.style.display === 'none' ? 'block' : 'none';
        }
    };
    window.addEventListener('keydown', window.mgDashboard._keyListener);

    // 8. Player identity — the room broadcasts EVERY connected player's
    // garden/coins/inventory under userSlots/<index>, not just yours. Without
    // filtering by your own slot, the HUD randomly flips between whichever
    // player's data happened to update last (confirmed by testing in a
    // multi-player lobby). There is no reliable static index: the same
    // account can land in a different userSlots index each time it joins a
    // room. The only stable handle is the account's own userId, read off the
    // app's own Jotai state (the same technique the open-source
    // MG-CommunityHub / garden-companion userscripts use: scan React Fiber
    // for the jotai <Provider> store, or fall back to briefly patching every
    // cached atom's write() to capture the store's (get,set) the next time
    // anything writes to it).
    function getAtomCache() {
        return window.jotaiAtomCache && window.jotaiAtomCache.cache;
    }

    function findAtomByLabel(label) {
        const cache = getAtomCache();
        if (!cache) return null;
        for (const atom of cache.values()) {
            if (atom && atom.debugLabel === label) return atom;
        }
        return null;
    }

    function findStoreViaFiber() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook || !hook.renderers || !hook.renderers.size) return null;
        for (const [rid] of hook.renderers) {
            const roots = hook.getFiberRoots && hook.getFiberRoots(rid);
            if (!roots) continue;
            for (const root of roots) {
                const seen = new Set();
                const stack = [root.current];
                while (stack.length) {
                    const f = stack.pop();
                    if (!f || seen.has(f)) continue;
                    seen.add(f);
                    const v = f.pendingProps && f.pendingProps.value;
                    if (v && typeof v.get === "function" && typeof v.set === "function" && typeof v.sub === "function") {
                        return v;
                    }
                    if (f.child) stack.push(f.child);
                    if (f.sibling) stack.push(f.sibling);
                    if (f.alternate) stack.push(f.alternate);
                }
            }
        }
        return null;
    }

    async function captureStoreViaWriteOnce() {
        const cache = getAtomCache();
        if (!cache) return null;
        let capturedGet = null, capturedSet = null;
        const patched = [];
        for (const atom of cache.values()) {
            if (!atom || typeof atom.write !== "function" || atom.__mgOrigWrite) continue;
            const orig = atom.write;
            atom.__mgOrigWrite = orig;
            atom.write = function(get, set, ...args) {
                if (!capturedSet) { capturedGet = get; capturedSet = set; }
                return orig.call(this, get, set, ...args);
            };
            patched.push(atom);
        }
        const restore = () => { for (const a of patched) { if (a.__mgOrigWrite) { a.write = a.__mgOrigWrite; delete a.__mgOrigWrite; } } };
        try { window.dispatchEvent(new Event('visibilitychange')); } catch (e) {}
        const t0 = Date.now();
        while (!capturedSet && Date.now() - t0 < 5000) {
            await new Promise(r => setTimeout(r, 50));
        }
        restore();
        return capturedSet ? { get: capturedGet, set: capturedSet } : null;
    }

    async function resolveMyIdentity() {
        let store = findStoreViaFiber();
        if (!store) store = await captureStoreViaWriteOnce();
        const idEl = () => document.getElementById('mg-identity');
        if (!store) {
            console.warn("[Co-Pilot] Konnte Spieler-Identität nicht ermitteln (Jotai-Store nicht erreichbar). Coins/Beete bleiben leer, bis das klappt.");
            const el = idEl(); if (el) { el.innerText = '✕ Identität fehlgeschlagen'; el.style.color = '#f87171'; }
            return;
        }
        const playerAtom = findAtomByLabel('playerAtom');
        const player = playerAtom ? store.get(playerAtom) : null;
        const myUserId = player && (player.userId || player.id || player.discordUserId || player.databaseUserId);
        if (!myUserId) {
            console.warn("[Co-Pilot] playerAtom lieferte keine userId.");
            const el = idEl(); if (el) { el.innerText = '✕ Identität fehlgeschlagen'; el.style.color = '#f87171'; }
            return;
        }
        window.mgDashboard.state.myUserId = String(myUserId);
        const okEl = idEl(); if (okEl) { okEl.innerText = '✓ Identität OK'; okEl.style.color = '#4ade80'; }
        console.log(`%c[Co-Pilot] Eigene userId erkannt: ${myUserId}`, "color:#4ade80;font-weight:bold;");
    }

    // 9. WebSocket Interceptor (read-only: observes server frames, never sends)
    function mergeTileObjects(target, patch) {
        Object.assign(target, patch);
    }

    const onGameMessage = (event) => {
        try {
            const msg = JSON.parse(event.data);

            if (msg.type === "QuinoaCommandResult" && msg.ok === false && msg.code === "invalid_sequence") {
                console.warn("[Co-Pilot] Befehl wegen invalid_sequence abgelehnt:", msg.requestId, msg.commandType);
                return;
            }

            if (msg.type !== "RoomFrame" || !msg.state || !msg.state.patches) return;
            const state = window.mgDashboard.state;

            for (const patch of msg.state.patches) {
                const p = patch.path || "";
                if (p.endsWith("currentTime")) {
                    state.serverTime = patch.value;
                    state.syncLocalTime = performance.now();
                }

                const val = patch.value;
                if (val === undefined || val === null) continue;

                // Every connected player's garden/coins/inventory flows
                // through userSlots/<index> — filter to OUR slot only.
                const slotMatch = p.match(/userSlots\/(\d+)/);
                if (slotMatch) {
                    const slotIdx = slotMatch[1];
                    // A full/partial slot replace sometimes carries its own
                    // userId alongside .data — whenever we see it, (re)lock
                    // onto that index. This is what lets us recover after a
                    // reconnect where the index may have shifted.
                    if (val.userId && state.myUserId && String(val.userId) === state.myUserId) {
                        state.myUserSlotIndex = slotIdx;
                    }
                    if (state.myUserSlotIndex === null || slotIdx !== state.myUserSlotIndex) {
                        continue; // not our data — skip entirely
                    }
                }

                const extract = val.data || val;

                // Full-sync and single-tile patches both funnel through
                // mergeTileObjects so a full snapshot can never race a
                // partial patch and clobber it (or vice versa).
                if (extract.garden && extract.garden.tileObjects) {
                    mergeTileObjects(state.tileObjects, extract.garden.tileObjects);
                }
                if (extract.coinsCount !== undefined) {
                    if (state.sessionStartCoins === null) {
                        state.sessionStartCoins = extract.coinsCount;
                    }
                    state.coins = extract.coinsCount;
                }
                if (extract.inventory && extract.inventory.items) {
                    state.inventory = extract.inventory.items;
                }

                if (p.includes("/garden/tileObjects/")) {
                    const parts = p.split("/");
                    const idx = parts.indexOf("tileObjects");
                    const tileId = parts[idx + 1];
                    if (tileId && parts.length === idx + 2) {
                        mergeTileObjects(state.tileObjects, { [tileId]: val });
                    }
                }
            }
        } catch (e) {}
    };

    window.mgDashboard._wsListener = onGameMessage;
    if (window.mgBot && window.mgBot.ws) window.mgBot.ws.addEventListener('message', onGameMessage);

    // 8b. Command sequencer — the server accepts a QuinoaCommand only when
    // its commandSequence is exactly (last command the server executed) + 1;
    // anything stale or duplicate is dropped silently, no error, just a
    // timeout on the sender's side. The real game client keeps its own
    // private counter for its own commands, with no idea we exist, so a
    // second independent counter (what we had before) inevitably drifts and
    // collides with it. The fix: stop counting locally and instead
    // OVERWRITE the commandSequence on every outgoing QuinoaCommand — ours
    // AND the game client's own — right before it hits the wire, using the
    // server's actually-confirmed frontier as the source of truth. One
    // numbering authority, no collision possible — IN THEORY. In practice,
    // the "frontier" we could actually read (RoomFrame's top-level
    // executedCommandSequence, and MagicCircle_RoomConnection's mirror of
    // it) turned out to track the outer "Room" scope's own counter (movement,
    // Teleport, game selection), not the separate "Quinoa" sub-scope counter
    // that HarvestCrop/SellAllCrops actually use. Confirmed by testing: it
    // stayed stuck at a stale low value and, worse, overwriting the real
    // client's own outgoing commands with it broke normal gameplay actions
    // too (a real command got renumbered to something wrong and rejected).
    // Reverted to the safer, non-invasive approach: never touch what the
    // real client sends, only track the highest commandSequence it uses and
    // continue from there for our own commands. This still risks the
    // original two-counter drift between us and the real client, but can
    // never break the player's own actions — a command failing is much
    // better than the player's own clicks silently not working.
    let lastSeenCommandSequence = 0;

    WebSocket.prototype.send = function(data) {
        if (!this._hudBound) {
            this._hudBound = true;
            this.addEventListener('message', onGameMessage);
            window.mgBot = window.mgBot || {};
            window.mgBot.ws = this;
        }
        try {
            const msg = JSON.parse(data);
            if (msg && msg.type === "QuinoaCommand" && typeof msg.commandSequence === "number") {
                lastSeenCommandSequence = Math.max(lastSeenCommandSequence, msg.commandSequence);
            }
        } catch (e) {}
        return origWSSend.call(this, data);
    };
    wsPatchInstalled = true;

    // 8c. Outgoing commands. commandSequence is a placeholder; the
    // continues from the highest commandSequence we've observed on any
    // outgoing QuinoaCommand (ours or the real client's).
    function sendQuinoaCommand(command) {
        const ws = window.mgBot && window.mgBot.ws;
        if (!ws || ws.readyState !== 1) {
            console.warn("[Co-Pilot] Keine aktive Verbindung, Befehl nicht gesendet.");
            return;
        }
        const msg = {
            scopePath: ["Room", "Quinoa"],
            type: "QuinoaCommand",
            requestId: crypto.randomUUID(),
            commandSequence: ++lastSeenCommandSequence,
            command
        };
        ws.send(JSON.stringify(msg));
        console.log("%c[Co-Pilot] Befehl gesendet:", "color:#f472b6;", msg);
    }

    function harvestTile(tileId, slotsIndex) {
        // cropItemId is unknown to us — the game never sends it in the
        // state sync we observe, only the client itself has it. A freshly
        // generated UUID works: the server assigns it to the produce and
        // we never need to read it back (confirmed against garden-companion's
        // own instant-harvest implementation).
        sendQuinoaCommand({
            type: "HarvestCrop",
            slot: Number(tileId),
            slotsIndex: slotsIndex,
            cropItemId: crypto.randomUUID()
        });
    }

    function sellAllCrops() {
        sendQuinoaCommand({ type: "SellAllCrops" });
    }

    function readySlotsOf(plant, now) {
        if (!plant.slots || plant.slots.length === 0) return [{ slotId: 0 }];
        return plant.slots.filter(s => s.endTime <= now);
    }

    // Timer IDs for staggered harvest commands still waiting to fire, so a
    // running sweep can be cancelled instead of always running to completion.
    const pendingHarvestTimers = new Set();

    function scheduleHarvest(tileId, slotsIndex, delay) {
        const id = setTimeout(() => {
            pendingHarvestTimers.delete(id);
            harvestTile(tileId, slotsIndex);
        }, delay);
        pendingHarvestTimers.add(id);
    }

    function stopAllHarvesting() {
        for (const id of pendingHarvestTimers) clearTimeout(id);
        const count = pendingHarvestTimers.size;
        pendingHarvestTimers.clear();
        console.log(`%c[Co-Pilot] Ernte gestoppt: ${count} ausstehende Befehle verworfen.`, "color:#f87171;font-weight:bold;");
    }

    function harvestAllReady() {
        const state = window.mgDashboard.state;
        const now = state.serverTime + (performance.now() - state.syncLocalTime);
        const jobs = [];
        for (const [tileId, plant] of Object.entries(state.tileObjects)) {
            for (const slot of readySlotsOf(plant, now)) {
                jobs.push({ tileId, slotsIndex: slot.slotId ?? 0 });
            }
        }
        if (jobs.length === 0) return;
        // Space every command out with human-scale jitter instead of firing
        // a burst of identical-timestamp requests, which is an obvious tell
        // for a scripted sweep and also more likely to trip the server's own
        // rate limiting than a steady trickle.
        let delay = 0;
        for (const job of jobs) {
            delay += 180 + Math.random() * 320;
            scheduleHarvest(job.tileId, job.slotsIndex, delay);
        }
        console.log(`%c[Co-Pilot] Alles ernten: ${jobs.length} Felder eingeplant.`, "color:#4ade80;font-weight:bold;");
    }

    // 9. Main Processing & Render Loop
    window.mgDashboard.intervalId = setInterval(() => {
        const state = window.mgDashboard.state;
        if (state.serverTime === 0) return;

        const now = state.serverTime + (performance.now() - state.syncLocalTime);
        const tiles = Object.entries(state.tileObjects);

        document.getElementById('mg-coins').innerText = `🪙 ${state.coins.toLocaleString()}`;

        // Aktive Reihen ermitteln
        const activeIds = new Set(tiles.map(([id]) => id));
        for (const [id, row] of domRows.entries()) {
            if (!activeIds.has(id)) {
                row.remove();
                domRows.delete(id);
                notifiedTiles.delete(id);
            }
        }

        let readyCount = 0;
        let readySlotCount = 0;
        let minRemainingSecs = Infinity;

        const parsed = tiles.map(([tileId, plant]) => {
            let endTime = plant.maturedAt || 0;
            let startTime = plant.plantedAt || 0;
            let currentSlot = 1, totalSlots = 1;

            if (plant.slots && plant.slots.length > 0) {
                totalSlots = plant.slots.length;
                const nextSlot = plant.slots.find(s => s.endTime > now);
                if (nextSlot) {
                    endTime = nextSlot.endTime;
                    startTime = nextSlot.startTime;
                    currentSlot = (nextSlot.slotId ?? 0) + 1;
                } else {
                    const last = plant.slots[plant.slots.length - 1];
                    endTime = last.endTime;
                    startTime = last.startTime;
                    currentSlot = totalSlots;
                }
                readySlotCount += plant.slots.filter(s => s.endTime <= now).length;
            }

            const diff = endTime - now;
            const isReady = diff <= 0;
            const secs = Math.max(0, Math.ceil(diff / 1000));

            if (isReady) {
                readyCount++;
                state.totalIdleSeconds += 0.25; // 250ms Intervall = 0.25s Idle Waste
            } else {
                minRemainingSecs = Math.min(minRemainingSecs, secs);
            }

            return { tileId, plant, endTime, startTime, currentSlot, totalSlots, diff, isReady, secs };
        });

        // Tab-Titel Update
        if (readyCount > 0) {
            document.title = `[🔔 ${readyCount} REIF!] Magic Garden`;
        } else if (minRemainingSecs !== Infinity) {
            document.title = `[⏳ ${minRemainingSecs}s] Magic Garden`;
        } else {
            document.title = origDocTitle;
        }

        // Sortierung
        if (cfg.sortBy === 'time') {
            parsed.sort((a, b) => a.diff - b.diff);
        } else {
            parsed.sort((a, b) => Number(a.tileId) - Number(b.tileId));
        }

        // TAB 1: Timers Rendering
        let harvestAllBtn = document.getElementById('mg-harvest-all-btn');
        if (!harvestAllBtn) {
            harvestAllBtn = document.createElement('button');
            harvestAllBtn.id = 'mg-harvest-all-btn';
            harvestAllBtn.dataset.action = 'harvest-all';
            harvestAllBtn.style.cssText = "background:#22c55e; color:#0f172a; border:none; border-radius:6px; padding:10px; cursor:pointer; font-weight:700; font-size:13px;";
            timerContainer.appendChild(harvestAllBtn);
        }
        const harvesting = pendingHarvestTimers.size > 0;
        harvestAllBtn.disabled = !harvesting && readySlotCount === 0;
        harvestAllBtn.style.opacity = harvestAllBtn.disabled ? '0.5' : '1';
        harvestAllBtn.style.cursor = harvestAllBtn.disabled ? 'default' : 'pointer';
        harvestAllBtn.style.background = harvesting ? '#ef4444' : '#22c55e';
        harvestAllBtn.style.color = harvesting ? '#fff' : '#0f172a';
        harvestAllBtn.innerText = harvesting
            ? `⏹ Ernten stoppen (${pendingHarvestTimers.size} ausstehend)`
            : `🌾 Alles ernten (${readySlotCount})`;
        timerContainer.insertBefore(harvestAllBtn, timerContainer.firstChild);

        for (const item of parsed) {
            const statusText = item.isReady ? 'REIF!' : `${item.secs}s`;

            // Alerts feuern
            if (item.isReady && !notifiedTiles.has(item.tileId)) {
                notifiedTiles.add(item.tileId);
                playChime();
                if (cfg.desktopNotify && Notification.permission === "granted" && document.hidden) {
                    new Notification("🌱 Ernte bereit!", {
                        body: `Feld #${item.tileId} (${item.plant.species}) kann geerntet werden!`,
                        silent: true
                    });
                }
            } else if (!item.isReady) {
                notifiedTiles.delete(item.tileId);
            }

            const totalDuration = item.endTime - item.startTime;
            const progress = totalDuration > 0 ? Math.min(100, Math.max(0, ((now - item.startTime) / totalDuration) * 100)) : (item.isReady ? 100 : 0);

            let row = domRows.get(item.tileId);
            if (!row) {
                row = document.createElement('div');
                row.style.cssText = "position:relative; overflow:hidden; min-height:44px; box-sizing:border-box; border-radius:8px; border:1px solid #334155; background:#1e293b; padding:12px 14px;";
                row.innerHTML = `
                    <div class="mg-p" style="position:absolute; left:0; top:0; bottom:0; width:0%; transition:width 0.25s linear; pointer-events:none;"></div>
                    <div style="position:relative; display:flex; justify-content:space-between; align-items:center; z-index:1; gap:10px; height:100%;">
                        <span class="mg-t" style="font-weight:600; font-size:14px; text-shadow:0 1px 3px rgba(0,0,0,0.9);"></span>
                        <span style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                            <button class="mg-harvest-btn" style="display:none; background:#22c55e; color:#0f172a; border:none; border-radius:5px; padding:6px 12px; font-size:12px; font-weight:700; cursor:pointer;">Ernten</button>
                            <span class="mg-v" style="font-weight:700; font-size:15px; text-shadow:0 1px 3px rgba(0,0,0,0.9);"></span>
                        </span>
                    </div>
                `;
                // Looked up fresh at click time (not captured from `item`
                // here) because this row is reused across renders — the
                // closure below would otherwise keep using the slot index
                // from the moment the row was first created.
                row.querySelector('.mg-harvest-btn').onclick = () => {
                    const plant = window.mgDashboard.state.tileObjects[item.tileId];
                    if (!plant) return;
                    const t = window.mgDashboard.state.serverTime + (performance.now() - window.mgDashboard.state.syncLocalTime);
                    const readySlots = readySlotsOf(plant, t);
                    if (readySlots.length === 0) return;
                    // Multi-slot plants (Blueberry, Strawberry, FavaBean, ...)
                    // can have several slots ready at once — harvest every
                    // ready slot, spaced out so it doesn't look like a burst.
                    let delay = 0;
                    for (const s of readySlots) {
                        delay += 180 + Math.random() * 320;
                        scheduleHarvest(item.tileId, s.slotId ?? 0, delay);
                    }
                };
                timerContainer.appendChild(row);
                domRows.set(item.tileId, row);
            }

            const tEl = row.querySelector('.mg-t');
            const vEl = row.querySelector('.mg-v');
            const pEl = row.querySelector('.mg-p');
            const hBtn = row.querySelector('.mg-harvest-btn');

            const label = `#${item.tileId} ${item.plant.species}` + (item.totalSlots > 1 ? ` (${item.currentSlot}/${item.totalSlots})` : '');
            if (tEl.innerText !== label) tEl.innerText = label;

            if (vEl.innerText !== statusText) {
                vEl.innerText = statusText;
                vEl.style.color = item.isReady ? '#4ade80' : '#38bdf8';
                row.style.borderColor = item.isReady ? '#22c55e' : '#334155';
            }
            hBtn.style.display = item.isReady ? 'inline-block' : 'none';
            pEl.style.width = `${progress}%`;
            pEl.style.background = item.isReady ? 'rgba(34, 197, 94, 0.22)' : 'rgba(56, 189, 248, 0.18)';
        }

        // TAB 2: Smart Shopping
        if (shopTab && shopTab.style.display !== 'none') {
            const seedItems = state.inventory.filter(i => i.itemType === 'Seed');
            const totalSeeds = seedItems.reduce((acc, s) => acc + (s.quantity || 1), 0);
            const activePlots = tiles.length;
            // Kein geratener Zielwert mehr: zeigt nur den beobachteten Bestand
            // relativ zu den tatsächlich aktiven Beeten, statt eine erfundene
            // Kapazitätsannahme (z.B. "12 Slots") als Empfehlung auszugeben.
            const seedsPerPlot = activePlots > 0 ? (totalSeeds / activePlots).toFixed(1) : '–';

            const sellableCount = state.inventory.filter(i => i.itemType === 'Produce').length;
            let shopHtml = `
                <button data-action="sell-all" ${sellableCount === 0 ? 'disabled' : ''} style="background:${sellableCount === 0 ? '#334155' : '#facc15'}; color:${sellableCount === 0 ? '#64748b' : '#0f172a'}; border:none; border-radius:6px; padding:10px; cursor:${sellableCount === 0 ? 'default' : 'pointer'}; font-weight:700; font-size:13px;">
                    🪙 Alle Ernte verkaufen (${sellableCount})
                </button>
                <div style="background:#1e293b; padding:10px 12px; border-radius:7px; border:1px solid #334155;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                        <span style="color:#94a3b8;">Aktive Beete</span>
                        <b>${activePlots}</b>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#94a3b8;">Samen im Vorrat</span>
                        <b style="color:#38bdf8;">${totalSeeds}</b>
                    </div>
                    <div style="border-top:1px solid #334155; padding-top:8px; display:flex; justify-content:space-between;">
                        <span>Samen je Beet</span>
                        <b style="color:#facc15;">${seedsPerPlot}</b>
                    </div>
                </div>
                <div style="font-weight:700; color:#f1f5f9; font-size:14px; margin-top:4px;">Sorten-Effizienz (ROI)</div>
            `;

            for (const [species, data] of Object.entries(PLANT_DATA)) {
                const totalRevenue = data.baseSell * data.slots;
                const netProfit = totalRevenue - data.seedCost;
                const profitPerMin = Math.round((netProfit / (data.growTimeSec / 60)));
                const canAfford = Math.floor(state.coins / data.seedCost);

                shopHtml += `
                    <div style="background:#1e293b; padding:9px 12px; border-radius:6px; border:1px solid #334155; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <b style="font-size:14px;">${species}</b> <span style="color:#94a3b8; font-size:12px;">(${data.seedCost}🪙)</span>
                            <div style="color:#4ade80; font-size:12px; margin-top:2px;">+${profitPerMin} 🪙/Min Profit</div>
                        </div>
                        <div style="text-align:right;">
                            <span style="color:#cbd5e1; font-size:12px;">Kaufbar<br><b style="font-size:14px; color:#f8fafc;">${canAfford}x</b></span>
                        </div>
                    </div>
                `;
            }
            shopTab.innerHTML = shopHtml;
        }

        // TAB 3: Statistics & Analytics
        const statsTab = document.getElementById('mg-tab-stats');
        if (statsTab && statsTab.style.display !== 'none') {
            const sessionMin = Math.max(0.1, (Date.now() - state.sessionStartTime) / 60000);
            const netCoins = state.sessionStartCoins !== null ? (state.coins - state.sessionStartCoins) : 0;
            const coinsPerHour = Math.round((netCoins / sessionMin) * 60);

            statsTab.innerHTML = `
                <div style="background:#1e293b; padding:12px; border-radius:7px; border:1px solid #334155; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:#94a3b8;">Session-Dauer</span>
                        <b>${Math.round(sessionMin)} Min</b>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:#94a3b8;">Netto-Gewinn</span>
                        <b style="color:${netCoins >= 0 ? '#4ade80' : '#ef4444'};">${netCoins >= 0 ? '+' : ''}${netCoins.toLocaleString()} 🪙</b>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:#94a3b8;">Coins / Stunde</span>
                        <b style="color:#38bdf8;">~${coinsPerHour.toLocaleString()} 🪙/h</b>
                    </div>
                    <div style="border-top:1px solid #334155; padding-top:8px; display:flex; justify-content:space-between;">
                        <span style="color:#f87171;">Idle-Zeit (Verlust)</span>
                        <b style="color:#f87171;">${Math.round(state.totalIdleSeconds)}s</b>
                    </div>
                </div>
            `;
        }
    }, 250);

    // Wartet bis zu 20s auf den Jotai-Atom-Cache, bevor die Identitäts-Auflösung versucht wird.
    // Nötig für Tampermonkey (automatischer Start bei jedem Seitenaufruf, @run-at document-idle):
    // anders als beim manuellen Konsolen-Paste (wo man ohnehin erst einfügt, sobald das Spiel
    // sichtbar läuft) kann der Cache beim Start dieses Scripts noch nicht existieren.
    (async function waitForAtomCacheThenResolve() {
        const t0 = Date.now();
        while (!getAtomCache() && Date.now() - t0 < 20000) {
            await new Promise(r => setTimeout(r, 300));
        }
        if (window.mgDashboard) resolveMyIdentity();
    })();

    console.log("%c[OverGarden Co-Pilot] Vollständig geladen! Drücke 'H' zum Ein-/Ausblenden.", "color:#38bdf8; font-weight:bold; font-size:12px;");
})();
