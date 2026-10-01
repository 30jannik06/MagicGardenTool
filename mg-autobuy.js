(function() {
    if (window.mgAutoBuy) window.mgAutoBuy.destroy();

    // Eigenständiges Zusatz-Script, unabhängig von mg-copilot.js / mg-weather-forecast.js ladbar.
    // Kauft konfigurierte Shop-Items automatisch, sobald sie verfügbar sind — gedacht für
    // Situationen in denen man den Restock-Alarm verpasst (z.B. nicht am PC), nicht als Ersatz
    // für bewusstes Einkaufen teurer/limitierter Dinge.
    //
    // Kauf-Befehlsformat (PurchaseShopItem) stammt aus garden-companion's shop-alarms.ts
    // ("Buy all"-Button), scopePath/Sequencer-Technik aus mg-copilot.js (nur beobachten, nie
    // echte Client-Befehle umschreiben — siehe websocket-game-protocol-reverse-engineering.md).

    const CFG_KEY = 'mg_autobuy_cfg';
    const cfg = Object.assign({ targets: [], enabled: true, minimized: false }, JSON.parse(localStorage.getItem(CFG_KEY) || '{}'));
    const saveCfg = () => localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    const hasTarget = (shop, id) => cfg.targets.some(t => t.shop === shop && t.id === id);

    const SHOP_TABS = [
        ['tool', 'Tool'], ['seed', 'Seed'], ['egg', 'Egg'], ['decor', 'Decor'],
        ['snow', 'Snow'], ['thunder', 'Thunder'], ['dawn', 'Dawn'], ['amber', 'Amber'], ['rain', 'Rain']
    ];
    let activeShopTab = 'tool';
    let latestGame = null;
    let unsubscribe = null;

    // Welches Feld im Kauf-Befehl die Item-Identität trägt, je nach Kategorie. 'species' ist das
    // Spiel-eigene Feld für Samen (nicht 'seedId' — bestätigt über garden-companion's ITEM_KEYS).
    const ITEM_KEYS = ['species', 'eggId', 'toolId', 'decorId'];
    const SHOP_ITEM_TYPES = { seed: 'Seed', egg: 'Egg', decor: 'Decor', tool: 'Tool' };

    function itemType(item, shop) {
        if (item && item.itemType) return item.itemType;
        return SHOP_ITEM_TYPES[shop] || (item && item.eggId ? 'Egg' : item && item.decorId ? 'Decor' : item && item.toolId ? 'Tool' : 'Seed');
    }
    function itemId(item) {
        for (const key of ITEM_KEYS) if (item && item[key]) return String(item[key]);
        return '';
    }
    function itemPayload(item, shop) {
        const payload = { itemType: itemType(item, shop) };
        for (const key of ITEM_KEYS) if (item && item[key]) payload[key] = item[key];
        return payload;
    }

    // 1. UI Shell
    const panel = document.createElement('div');
    panel.id = 'mg-autobuy';
    Object.assign(panel.style, {
        position: 'fixed',
        top: '16px',
        right: '310px',
        width: '320px',
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        color: '#f8fafc',
        fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        lineHeight: '1.4',
        borderRadius: '12px',
        padding: '12px 14px',
        boxShadow: '0 12px 35px rgba(0,0,0,0.65)',
        border: '1px solid rgba(255,255,255,0.12)',
        zIndex: '9999997',
        backdropFilter: 'blur(8px)',
        userSelect: 'none'
    });
    panel.innerHTML = `
        <div id="mgab-header" style="display:flex; justify-content:space-between; align-items:center; cursor:grab; padding-bottom:8px; border-bottom:1px solid #334155;">
            <span style="font-weight:700; font-size:14px; color:#38bdf8;">🛒 Auto-Buy</span>
            <span style="display:flex; gap:6px;">
                <button id="mgab-toggle" style="background:${cfg.enabled ? '#22c55e' : '#475569'}; color:#0f172a; border:none; border-radius:5px; padding:3px 8px; cursor:pointer; font-weight:700; font-size:11px;">${cfg.enabled ? 'AN' : 'AUS'}</button>
                <button id="mgab-min" style="background:#1e293b; color:#cbd5e1; border:1px solid #475569; border-radius:5px; width:22px; height:22px; cursor:pointer; font-size:13px;">_</button>
                <button id="mgab-close" style="background:#ef4444; color:#fff; border:none; border-radius:5px; width:22px; height:22px; cursor:pointer; font-weight:bold; font-size:12px;">✕</button>
            </span>
        </div>
        <div id="mgab-body" style="display:${cfg.minimized ? 'none' : 'block'};">
            <div id="mgab-tabs" style="margin-top:10px; display:flex; flex-wrap:wrap; gap:4px;"></div>
            <div id="mgab-items" style="margin-top:8px; display:flex; flex-direction:column; gap:4px; max-height:32vh; overflow-y:auto;"></div>
            <div id="mgab-log" style="margin-top:8px; font-size:11px; color:#64748b; max-height:14vh; overflow-y:auto; display:flex; flex-direction:column-reverse; gap:2px;"></div>
        </div>
    `;
    document.body.appendChild(panel);

    // Drag & Drop
    const header = document.getElementById('mgab-header');
    let dragging = false, startX, startY;
    header.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        startX = e.clientX - panel.offsetLeft;
        startY = e.clientY - panel.offsetTop;
    };
    const onMouseMove = (e) => {
        if (!dragging) return;
        panel.style.left = `${Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - startX))}px`;
        panel.style.top = `${Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - startY))}px`;
        panel.style.right = 'auto';
    };
    const onMouseUp = () => { dragging = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    function log(msg, color) {
        const el = document.getElementById('mgab-log');
        if (!el) return;
        const row = document.createElement('div');
        row.style.color = color || '#94a3b8';
        row.innerText = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ${msg}`;
        el.insertBefore(row, el.firstChild);
        while (el.children.length > 20) el.removeChild(el.lastChild);
    }

    function renderTabs() {
        const el = document.getElementById('mgab-tabs');
        if (!el) return;
        el.innerHTML = SHOP_TABS.map(([id, label]) => {
            const count = cfg.targets.filter(t => t.shop === id).length;
            return `<button data-tab="${id}" style="background:${activeShopTab === id ? '#0284c7' : '#1e293b'}; color:${activeShopTab === id ? '#fff' : '#cbd5e1'}; border:none; border-radius:5px; padding:5px 8px; cursor:pointer; font-size:11px; font-weight:600;">${label}${count ? ` (${count})` : ''}</button>`;
        }).join('');
        el.querySelectorAll('[data-tab]').forEach(btn => {
            btn.onclick = () => { activeShopTab = btn.dataset.tab; renderTabs(); renderItems(); };
        });
    }

    // Items werden ausschließlich aus den Live-Shop-Daten gerendert (kein Freitext mehr nötig) —
    // das Spiel listet die komplette Kategorie auch bei initialStock:0, also bleibt die Liste
    // vollständig statt nur das gerade Verfügbare zu zeigen.
    function renderItems() {
        const el = document.getElementById('mgab-items');
        if (!el) return;
        const data = latestGame && latestGame.shops && latestGame.shops[activeShopTab];
        const items = Array.isArray(data && data.inventory) ? data.inventory : [];
        if (!items.length) {
            el.innerHTML = `<div style="color:#64748b; font-size:12px; padding:4px 2px;">Warte auf Shop-Daten...</div>`;
            return;
        }
        el.innerHTML = items.map(item => {
            const id = itemId(item);
            const checked = hasTarget(activeShopTab, id);
            return `
                <label style="display:flex; justify-content:space-between; align-items:center; background:#1e293b; border:1px solid #334155; border-radius:7px; padding:6px 10px; cursor:pointer;">
                    <span>${id}</span>
                    <span style="display:flex; align-items:center; gap:8px;">
                        <span style="color:#64748b; font-size:11px;">${item.initialStock ?? 0}x</span>
                        <input type="checkbox" data-item="${id}" ${checked ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
                    </span>
                </label>
            `;
        }).join('');
        el.querySelectorAll('[data-item]').forEach(box => {
            box.onchange = () => {
                const id = box.dataset.item;
                if (box.checked) { if (!hasTarget(activeShopTab, id)) cfg.targets.push({ shop: activeShopTab, id }); }
                else cfg.targets = cfg.targets.filter(t => !(t.shop === activeShopTab && t.id === id));
                saveCfg();
                renderTabs();
            };
        });
    }

    renderTabs();
    renderItems();

    document.getElementById('mgab-close').onclick = () => window.mgAutoBuy.destroy();
    document.getElementById('mgab-min').onclick = () => {
        cfg.minimized = !cfg.minimized;
        document.getElementById('mgab-body').style.display = cfg.minimized ? 'none' : 'block';
        saveCfg();
    };
    document.getElementById('mgab-toggle').onclick = (e) => {
        cfg.enabled = !cfg.enabled;
        saveCfg();
        e.target.style.background = cfg.enabled ? '#22c55e' : '#475569';
        e.target.innerText = cfg.enabled ? 'AN' : 'AUS';
        log(cfg.enabled ? 'Auto-Buy aktiviert.' : 'Auto-Buy pausiert.', '#facc15');
    };

    // 2. State & Kauf-Logik
    // Pro Shop gemerkt, bei welchem secondsUntilRestock-Wert zuletzt gekauft wurde, damit nicht
    // bei jedem Tick innerhalb desselben Restock-Fensters erneut gekauft wird.
    const boughtSinceRestock = new Set();
    let lastRestockClock = new Map();

    const origWSSend = WebSocket.prototype.send;
    let wsPatchInstalled = false;
    let lastSeenCommandSequence = 0;
    const pendingLabels = new Map();

    // Statt auf den nächsten ws.send() zu warten, um an die Socket-Referenz zu kommen (fragil —
    // klappt nur wenn zufällig schon irgendwas gesendet wurde), lesen wir sie direkt über die
    // offizielle, sofort verfügbare Property der Spiel-Verbindung (bestätigt in garden-companion's
    // types.ts: RoomConnection.currentWebSocket).
    function getSocket() {
        const connection = window.MagicCircle_RoomConnection;
        return (connection && connection.currentWebSocket) || (window.mgBot && window.mgBot.ws) || null;
    }

    function ensureListener(ws) {
        if (!ws || ws._mgabListenerBound) return;
        ws._mgabListenerBound = true;
        ws.addEventListener('message', onGameMessage);
        window.mgBot = window.mgBot || {};
        window.mgBot.ws = ws;
    }

    function onGameMessage(event) {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'QuinoaCommandResult' && pendingLabels.has(msg.requestId)) {
                const label = pendingLabels.get(msg.requestId);
                pendingLabels.delete(msg.requestId);
                if (msg.ok === false) log(`✕ Kauf fehlgeschlagen: ${label} (${msg.code || 'unbekannt'})`, '#f87171');
                else log(`✓ Gekauft: ${label}`, '#4ade80');
            }
        } catch (e) {}
    }

    WebSocket.prototype.send = function(data) {
        ensureListener(this);
        try {
            const msg = JSON.parse(data);
            if (msg && msg.type === 'QuinoaCommand' && typeof msg.commandSequence === 'number') {
                lastSeenCommandSequence = Math.max(lastSeenCommandSequence, msg.commandSequence);
            }
        } catch (e) {}
        return origWSSend.call(this, data);
    };
    wsPatchInstalled = true;

    function sendQuinoaCommand(command, label) {
        const ws = getSocket();
        ensureListener(ws);
        if (!ws || ws.readyState !== 1) {
            log('Keine aktive Verbindung, Kauf nicht gesendet.', '#f87171');
            return;
        }
        const requestId = crypto.randomUUID();
        if (label) pendingLabels.set(requestId, label);
        const msg = {
            scopePath: ['Room', 'Quinoa'],
            type: 'QuinoaCommand',
            requestId,
            commandSequence: ++lastSeenCommandSequence,
            command
        };
        ws.send(JSON.stringify(msg));
    }

    function tryBuy(target, liveItem, shop) {
        // Es wird immer die volle zum Zeitpunkt des Restocks ausgewiesene Stückzahl gekauft
        // (initialStock), nicht eine fest eingetragene Menge — Restock-Mengen variieren pro Zyklus.
        const quantity = Math.max(1, Number(liveItem.initialStock) || 1);
        const label = `${target.id} ×${quantity} (${shop})`;
        log(`→ Kaufe ${label} ...`, '#f472b6');
        sendQuinoaCommand({
            type: 'PurchaseShopItem',
            shop,
            viewMode: 'list',
            item: itemPayload(liveItem, shop),
            ...(quantity === 1 ? {} : { quantity })
        }, label);
    }

    function processShops() {
        if (!cfg.enabled || !latestGame || !latestGame.shops) return;
        for (const [shop, data] of Object.entries(latestGame.shops)) {
            const items = Array.isArray(data && data.inventory) ? data.inventory : [];
            const seconds = Number(data && data.secondsUntilRestock);
            const restocked = Number.isFinite(seconds) && lastRestockClock.has(shop) && seconds > lastRestockClock.get(shop);
            if (Number.isFinite(seconds)) lastRestockClock.set(shop, seconds);

            // Restock erkannt — Merker für diesen Shop verwerfen, damit neu verfügbare Items
            // wieder gekauft werden dürfen. Der Merker selbst trägt KEINE sich ändernde Zahl mehr
            // (vorher: secondsUntilRestock im Schlüssel — der zählt jede Sekunde runter, wodurch
            // der Schlüssel nie stabil war und jeden Tick wie "neu" aussah => Dauerspam).
            if (restocked) {
                for (const key of [...boughtSinceRestock]) if (key.startsWith(`${shop}:`)) boughtSinceRestock.delete(key);
            }

            for (const target of cfg.targets) {
                if (target.shop !== shop) continue;
                const live = items.find(it => itemId(it) === target.id);
                const stock = live ? (Number(live.initialStock) || 0) : 0;
                if (stock <= 0) continue; // gerade nicht vorrätig
                const key = `${shop}:${target.id}`;
                if (boughtSinceRestock.has(key)) continue;
                boughtSinceRestock.add(key);
                tryBuy(target, live, shop);
            }
        }
    }

    window.mgAutoBuy = {
        destroy() {
            if (this.intervalId) clearInterval(this.intervalId);
            if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (e) {} }
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            if (wsPatchInstalled) { WebSocket.prototype.send = origWSSend; wsPatchInstalled = false; }
            panel.remove();
            window.mgAutoBuy = null;
            console.log('%c[Auto-Buy] Beendet.', 'color:#ef4444;');
        }
    };

    const connection = window.MagicCircle_RoomConnection;
    if (!connection || typeof connection.subscribeToPatches !== 'function') {
        log('✕ MagicCircle_RoomConnection nicht gefunden.', '#f87171');
    } else {
        const maybeUnsub = connection.subscribeToPatches((_patches, fullState) => {
            latestGame = (fullState && fullState.child && fullState.child.data) || null;
        });
        if (typeof maybeUnsub === 'function') unsubscribe = maybeUnsub;
    }

    window.mgAutoBuy.intervalId = setInterval(() => {
        ensureListener(getSocket());
        processShops();
        renderItems();
    }, 1000);

    console.log('%c[Auto-Buy] Geladen. Items im Panel über die Checkboxen auswählen.', 'color:#38bdf8; font-weight:bold;');
})();
