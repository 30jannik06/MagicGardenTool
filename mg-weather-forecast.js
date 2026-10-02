// ==UserScript==
// @name         MG Weather Forecast
// @namespace    mg-weather-forecast
// @version      1.0
// @description  Zeigt aktuelles und kommendes Wetter (inkl. Mond-Events) für magicgarden.gg
// @match        https://magicgarden.gg/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function() {
    if (window.mgWeather) window.mgWeather.destroy();

    // Wartet bis zu `timeoutMs` darauf, dass `check()` wahr zurückgibt, und ruft dann `onReady()`.
    // Nötig weil Tampermonkey das Script automatisch bei jedem Seitenaufruf startet — anders als
    // beim manuellen Konsolen-Paste (wo man ohnehin erst einfügt, wenn das Spiel sichtbar lädt)
    // kann die Spiel-eigene Verbindung beim Start dieses Scripts noch fehlen.
    function waitFor(check, onReady, { timeoutMs = 20000, intervalMs = 300 } = {}) {
        const start = Date.now();
        (function poll() {
            if (check()) { onReady(); return; }
            if (Date.now() - start > timeoutMs) {
                console.warn('[Wetter-Forecast] Timeout — MagicCircle_RoomConnection nicht gefunden.');
                return;
            }
            setTimeout(poll, intervalMs);
        })();
    }

    // Eigenständiges Zusatz-Script, unabhängig vom Co-Pilot (mg-copilot.js) ladbar.
    // Zeigt nicht nur das naechste Wetter, sondern mehrere kommende Events mit Uhrzeit.
    //
    // Datenquelle: window.MagicCircle_RoomConnection.subscribeToPatches() — eine offizielle
    // Methode der Spiel-eigenen Verbindung (kein eigener Patch-Parser noetig). Seit Bundle 1141
    // ist Wetter server-seitig vorberechnet und kommt direkt im State an:
    //   game.weather          -> aktueller Wetter-Typ (string) oder "" bei Normalwetter
    //   game.weatherWindow     -> { weatherId, startsAtMs, endsAtMs } der laufenden Phase
    //   game.weatherForecast   -> Array kommender Phasen, gleiche Form, startsAtMs in der Zukunft
    // Mond-Events (Dawn/AmberMoon) laufen teils als groupId:"Lunar" mit weatherId:null, weil das
    // Spiel bewusst nicht vorab verraet welches der beiden es wird.

    const WEATHER_NAMES = {
        Rain: 'Regen',
        Frost: 'Schnee',
        Thunderstorm: 'Gewitter',
        Dawn: 'Morgendämmerung',
        AmberMoon: 'Bernsteinmond'
    };
    const WEATHER_ICONS = {
        Rain: '🌧️',
        Frost: '❄️',
        Thunderstorm: '⛈️',
        Dawn: '🌅',
        AmberMoon: '🌕'
    };
    const LUNAR_IDS = new Set(['Dawn', 'AmberMoon']);

    function labelFor(weatherId, groupId) {
        const lunar = groupId === 'Lunar' || (weatherId && LUNAR_IDS.has(weatherId));
        if (!weatherId && lunar) return { icon: '🌙', text: 'Mond-Event' };
        return { icon: WEATHER_ICONS[weatherId] || '🌦️', text: WEATHER_NAMES[weatherId] || weatherId || 'Unbekannt' };
    }

    function formatCountdown(ms) {
        if (ms <= 0) return 'jetzt';
        const totalSec = Math.ceil(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function formatClock(ms) {
        const d = new Date(ms);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // 1. UI Shell — bewusst schlank gehalten, eigenes Panel statt in den Co-Pilot integriert,
    // damit beide Scripts unabhängig voneinander geladen/entladen werden können.
    const panel = document.createElement('div');
    panel.id = 'mg-weather-forecast';
    Object.assign(panel.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        width: '280px',
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        color: '#f8fafc',
        fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        lineHeight: '1.4',
        borderRadius: '12px',
        padding: '12px 14px',
        boxShadow: '0 12px 35px rgba(0,0,0,0.65)',
        border: '1px solid rgba(255,255,255,0.12)',
        zIndex: '9999998',
        backdropFilter: 'blur(8px)',
        userSelect: 'none'
    });
    panel.innerHTML = `
        <div id="mgw-header" style="display:flex; justify-content:space-between; align-items:center; cursor:grab; padding-bottom:8px; border-bottom:1px solid #334155;">
            <span style="font-weight:700; font-size:14px; color:#38bdf8;">🌦️ Wetter-Forecast</span>
            <button id="mgw-close" style="background:#ef4444; color:#fff; border:none; border-radius:5px; width:22px; height:22px; cursor:pointer; font-weight:bold; font-size:12px;">✕</button>
        </div>
        <div id="mgw-current" style="margin-top:10px; padding:8px 10px; background:#1e293b; border-radius:8px; border:1px solid #334155;"></div>
        <div id="mgw-upcoming" style="margin-top:8px; display:flex; flex-direction:column; gap:6px;"></div>
    `;
    document.body.appendChild(panel);
    document.getElementById('mgw-close').onclick = () => window.mgWeather.destroy();

    // Drag & Drop
    const header = document.getElementById('mgw-header');
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

    // 2. State
    let latestGame = null;
    let unsubscribe = null;

    window.mgWeather = {
        destroy() {
            if (this.intervalId) clearInterval(this.intervalId);
            if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (e) {} }
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            panel.remove();
            window.mgWeather = null;
            console.log('%c[Wetter-Forecast] Beendet.', 'color:#ef4444;');
        }
    };

    // 3. Datenquelle anbinden — wartet, falls die Verbindung beim Start noch nicht existiert.
    waitFor(
        () => window.MagicCircle_RoomConnection && typeof window.MagicCircle_RoomConnection.subscribeToPatches === 'function',
        () => {
            if (!window.mgWeather) return; // zwischenzeitlich via destroy() beendet
            const maybeUnsub = window.MagicCircle_RoomConnection.subscribeToPatches((_patches, fullState) => {
                latestGame = (fullState && fullState.child && fullState.child.data) || null;
            });
            if (typeof maybeUnsub === 'function') unsubscribe = maybeUnsub;
        }
    );

    // 4. Render Loop
    window.mgWeather.intervalId = setInterval(() => {
        const curEl = document.getElementById('mgw-current');
        const upEl = document.getElementById('mgw-upcoming');
        if (!curEl || !upEl) return;

        if (!latestGame) {
            curEl.innerText = '⏳ Warte auf Spieldaten...';
            curEl.style.color = '#94a3b8';
            upEl.innerHTML = '';
            return;
        }

        const now = Date.now();

        // Aktuelles Wetter
        const win = latestGame.weatherWindow;
        if (win && win.endsAtMs && win.endsAtMs > now) {
            const { icon, text } = labelFor(win.weatherId, win.groupId);
            curEl.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:700;">${icon} ${text}</span>
                    <span style="color:#4ade80; font-weight:700;">${formatCountdown(win.endsAtMs - now)}</span>
                </div>
                <div style="color:#64748b; font-size:11px; margin-top:2px;">endet um ${formatClock(win.endsAtMs)}</div>
            `;
            curEl.style.color = '';
        } else {
            curEl.innerHTML = `<span style="color:#94a3b8;">☀️ Kein Wetter-Event aktiv</span>`;
        }

        // Kommende Events
        const forecast = Array.isArray(latestGame.weatherForecast) ? latestGame.weatherForecast : [];
        const upcoming = forecast
            .filter(e => typeof e.startsAtMs === 'number' && e.startsAtMs > now)
            .sort((a, b) => a.startsAtMs - b.startsAtMs)
            .slice(0, 5);

        if (upcoming.length === 0) {
            upEl.innerHTML = `<div style="color:#64748b; font-size:12px; padding:4px 2px;">Keine weiteren Events bekannt</div>`;
        } else {
            upEl.innerHTML = upcoming.map(e => {
                const { icon, text } = labelFor(e.weatherId, e.groupId);
                return `
                    <div style="display:flex; justify-content:space-between; align-items:center; background:#1e293b; border:1px solid #334155; border-radius:7px; padding:6px 10px;">
                        <span>${icon} ${text}</span>
                        <span style="text-align:right;">
                            <div style="color:#38bdf8; font-weight:700; font-size:12px;">${formatCountdown(e.startsAtMs - now)}</div>
                            <div style="color:#64748b; font-size:10px;">${formatClock(e.startsAtMs)}</div>
                        </span>
                    </div>
                `;
            }).join('');
        }
    }, 1000);

    console.log('%c[Wetter-Forecast] Geladen. Läuft unabhängig vom Co-Pilot.', 'color:#38bdf8; font-weight:bold;');
})();
