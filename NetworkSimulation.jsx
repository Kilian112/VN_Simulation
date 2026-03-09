import React, {useState, useEffect, useRef, useCallback} from 'react';
import {LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer} from 'recharts';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const CANVAS_W = 900;
const CANVAS_H = 560;

const NETWORK_PRESETS = {
    'Wi-Fi 6': {radius: 150, maxUsers: 20,  peakThroughput: 9600,    latency: 2,   type: 'wifi'},
    'Wi-Fi 7': {radius: 175, maxUsers: 25,  peakThroughput: 46000,   latency: 1,   type: 'wifi'},
    'Wi-Fi 8': {radius: 200, maxUsers: 30,  peakThroughput: 100000,  latency: 0.5, type: 'wifi'},
    '4G':      {radius: 280, maxUsers: 60,  peakThroughput: 100,     latency: 30,  type: 'cellular'},
    '5G':      {radius: 240, maxUsers: 120, peakThroughput: 20000,   latency: 5,   type: 'cellular'},
    '6G':      {radius: 320, maxUsers: 180, peakThroughput: 1000000, latency: 0.1, type: 'cellular'},
};

const SPEED_PX        = {slow: 25, medium: 70, fast: 160};
const SIM_MULTIPLIERS = [0.5, 1, 2, 5];

const WIFI_COLORS = ['#3b82f6', '#60a5fa', '#2563eb', '#1d4ed8', '#818cf8'];
const CELL_COLORS = ['#f59e0b', '#fb923c', '#fbbf24', '#d97706', '#f97316'];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function fmtMbps(mbps) {
    if (mbps >= 1e6) return (mbps / 1e6).toFixed(2) + ' Tbps';
    if (mbps >= 1000) return (mbps / 1000).toFixed(2) + ' Gbps';
    return mbps.toFixed(1) + ' Mbps';
}

function euclidDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** SVG path for a pie-slice sector */
function wedgePath(cx, cy, r, startDeg, endDeg) {
    const s  = startDeg * Math.PI / 180;
    const e  = endDeg   * Math.PI / 180;
    const x1 = cx + r * Math.cos(s);
    const y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e);
    const y2 = cy + r * Math.sin(e);
    return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

/** Device dot color by type + state */
function getDeviceColor(d) {
    if (d.state === 'rejected') return '#ef4444';
    if (d.deviceType === 'vr') {
        if (d.state === 'downloading') return '#c084fc';
        if (d.state === 'connected')   return '#a855f7';
        return '#581c87'; // unconnected
    }
    // normal
    if (d.state === 'connected') return '#22d3ee';
    return '#164e63'; // unconnected
}

function makeStations(count, presetKey) {
    const p       = NETWORK_PRESETS[presetKey];
    const palette = p.type === 'wifi' ? WIFI_COLORS : CELL_COLORS;
    const cols    = Math.ceil(Math.sqrt(count));
    const rows    = Math.ceil(count / cols);
    const cellW   = CANVAS_W / cols;
    const cellH   = CANVAS_H / rows;
    return Array.from({length: count}, (_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return {
            id:             i,
            x:              cellW * col + cellW * 0.2 + Math.random() * cellW * 0.6,
            y:              cellH * row + cellH * 0.2 + Math.random() * cellH * 0.6,
            radius:         p.radius,
            maxUsers:       p.maxUsers,
            peakThroughput: p.peakThroughput,
            latency:        p.latency,
            type:           p.type,
            color:          palette[i % palette.length],
            congested:      false,
        };
    });
}

function makeDevices(count, vrRatio) {
    return Array.from({length: count}, (_, i) => {
        const angle = Math.random() * Math.PI * 2;
        const isVR  = Math.random() < vrRatio;
        const profile = isVR ? null
            : ['light', 'medium', 'heavy'][Math.floor(Math.random() * 3)];
        const profileBase = profile === 'light'  ? 0.5 + Math.random() * 4.5
                          : profile === 'medium' ? 5   + Math.random() * 45
                          : profile === 'heavy'  ? 50  + Math.random() * 150
                          : 0; // VR uses vrBgLoad
        return {
            id:               i,
            x:                Math.random() * CANVAS_W,
            y:                Math.random() * CANVAS_H,
            vx:               Math.cos(angle),
            vy:               Math.sin(angle),
            deviceType:       isVR ? 'vr' : 'normal',
            profile,
            profileBase,
            connectedTo:      null,
            connectedSector:  null,   // 0/1/2 for cellular, null for wifi
            state:            'unconnected',
            downloadProgress: 0,
            downloadComplete: !isVR,  // normal devices skip download
            resumingDownload: false,
            demandedMbps:     0,
            allocatedMbps:    0,
            throttled:        false,
            demandTarget:     profileBase,
            demandTimer:      Math.random() * 2,
        };
    });
}

// ─────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────

export default function NetworkSimulation() {
    const [networkType,  setNetworkType]  = useState('5G');
    const [stationCount, setStationCount] = useState(3);
    const [deviceCount,  setDeviceCount]  = useState(15);
    const [moveSpeed,    setMoveSpeed]    = useState('medium');
    const [appDlSize,    setAppDlSize]    = useState(100);  // MB
    const [vrBgLoad,     setVrBgLoad]     = useState(100);  // Mbps
    const [vrRatio,      setVrRatio]      = useState(0.3);  // 0–1
    const [simMult,      setSimMult]      = useState(1);
    const [paused,       setPaused]       = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);

    const stationsRef     = useRef([]);
    const devicesRef      = useRef([]);
    const rafRef          = useRef(null);
    const lastTsRef       = useRef(null);
    const metricsTimerRef = useRef(0);
    const metricsHistRef  = useRef([]);
    const canvasRef       = useRef(null);

    const [snapshot,       setSnapshot]       = useState({stations: [], devices: []});
    const [metricsHistory, setMetricsHistory] = useState([]);

    const settingsRef = useRef({});
    settingsRef.current = {networkType, moveSpeed, appDlSize, vrBgLoad, vrRatio, simMult};

    const preset = NETWORK_PRESETS[networkType];

    // ── Init / reset ──
    const initSim = useCallback(() => {
        stationsRef.current     = makeStations(stationCount, networkType);
        devicesRef.current      = makeDevices(deviceCount, vrRatio);
        metricsHistRef.current  = [];
        metricsTimerRef.current = 0;
        setMetricsHistory([]);
        setSnapshot({
            stations: stationsRef.current.map(s => ({...s})),
            devices:  devicesRef.current.map(d => ({...d})),
        });
    }, [stationCount, deviceCount, networkType, vrRatio]);

    useEffect(() => { initSim(); }, [initSim]);

    // ── Simulation step ──
    const step = useCallback((rawDelta) => {
        const {moveSpeed, appDlSize, vrBgLoad, simMult} = settingsRef.current;
        const dt      = Math.min(rawDelta, 0.1) * simMult;
        const speedPx = SPEED_PX[moveSpeed];
        const stations = stationsRef.current;
        const devices  = devicesRef.current;

        // 1. Move & bounce
        for (const d of devices) {
            d.x += d.vx * speedPx * dt;
            d.y += d.vy * speedPx * dt;
            if (d.x < 8)            { d.x = 8;            d.vx =  Math.abs(d.vx); }
            if (d.x > CANVAS_W - 8) { d.x = CANVAS_W - 8; d.vx = -Math.abs(d.vx); }
            if (d.y < 8)            { d.y = 8;            d.vy =  Math.abs(d.vy); }
            if (d.y > CANVAS_H - 8) { d.y = CANVAS_H - 8; d.vy = -Math.abs(d.vy); }
        }

        // 2. Periodically randomise demand targets
        for (const d of devices) {
            d.demandTimer -= dt;
            if (d.demandTimer <= 0) {
                d.demandTimer = 1 + Math.random() * 2;
                if (d.deviceType === 'vr' && d.downloadComplete) {
                    d.demandTarget = vrBgLoad * (0.8 + Math.random() * 0.4);
                } else if (d.deviceType === 'normal') {
                    d.demandTarget = d.profileBase * (0.85 + Math.random() * 0.3);
                }
            }
        }

        // 3. Assign devices to nearest station / sector (greedy closest-first)
        const slotsTaken = new Map();
        for (const s of stations) {
            if (s.type === 'cellular') {
                slotsTaken.set(`${s.id}-0`, 0);
                slotsTaken.set(`${s.id}-1`, 0);
                slotsTaken.set(`${s.id}-2`, 0);
            } else {
                slotsTaken.set(`${s.id}`, 0);
            }
        }

        const withNearest = devices.map(d => {
            let best = null, bestDist = Infinity, bestSector = null;
            for (const s of stations) {
                const dist = euclidDist(d, s);
                if (dist < s.radius && dist < bestDist) {
                    best = s; bestDist = dist;
                    if (s.type === 'cellular') {
                        const ang = (Math.atan2(d.y - s.y, d.x - s.x) * 180 / Math.PI + 360) % 360;
                        bestSector = Math.floor(ang / 120);
                    } else {
                        bestSector = null;
                    }
                }
            }
            return {d, best, bestDist, bestSector};
        });
        withNearest.sort((a, b) => a.bestDist - b.bestDist);

        for (const {d, best, bestSector} of withNearest) {
            if (!best) {
                if (d.state === 'downloading' && d.downloadProgress > 0) d.resumingDownload = true;
                d.connectedTo = null; d.connectedSector = null;
                d.state = 'unconnected'; d.demandedMbps = 0; d.throttled = false;
                continue;
            }

            const slotKey = best.type === 'cellular' ? `${best.id}-${bestSector}` : `${best.id}`;
            const slotCap = best.type === 'cellular' ? Math.floor(best.maxUsers / 3) : best.maxUsers;
            const taken   = slotsTaken.get(slotKey);

            d.connectedTo = best.id; d.connectedSector = bestSector;

            if (taken < slotCap) {
                slotsTaken.set(slotKey, taken + 1);
                if (d.state === 'unconnected' || d.state === 'rejected') {
                    if (d.downloadComplete) {
                        d.state = 'connected';
                        if (d.demandedMbps < 0.01) {
                            const init = d.deviceType === 'vr'
                                ? vrBgLoad * (0.9 + Math.random() * 0.2)
                                : d.profileBase;
                            d.demandedMbps = init; d.demandTarget = init;
                        }
                    } else {
                        d.state = 'downloading';
                        d.resumingDownload = d.downloadProgress > 0;
                    }
                }
            } else {
                d.state = 'rejected'; d.demandedMbps = 0; d.throttled = false;
            }
        }

        // Smooth demand towards target for active devices
        for (const d of devices) {
            if (d.state === 'downloading') {
                d.demandedMbps = 1e7; // downloading wants max bandwidth
            } else if (d.state === 'connected') {
                const lerp = Math.min(1, dt * 1.5);
                d.demandedMbps += (d.demandTarget - d.demandedMbps) * lerp;
                if (d.demandedMbps < 0.01) d.demandedMbps = 0.01;
            } else {
                d.demandedMbps = 0;
            }
        }

        // 4. Proportional bandwidth allocation per group
        const groups = new Map();
        for (const s of stations) {
            if (s.type === 'cellular') {
                for (let sec = 0; sec < 3; sec++) {
                    groups.set(`${s.id}-${sec}`, {devices: [], capacity: s.peakThroughput / 3});
                }
            } else {
                groups.set(`${s.id}`, {devices: [], capacity: s.peakThroughput});
            }
        }
        for (const d of devices) {
            if (d.state !== 'connected' && d.state !== 'downloading') continue;
            const key = d.connectedSector !== null
                ? `${d.connectedTo}-${d.connectedSector}` : `${d.connectedTo}`;
            groups.get(key)?.devices.push(d);
        }
        const congestedStationIds = new Set();
        for (const [, grp] of groups) {
            const total    = grp.devices.reduce((s, d) => s + d.demandedMbps, 0);
            const congested = total > grp.capacity * 1.02 && grp.devices.length > 0;
            for (const d of grp.devices) {
                d.allocatedMbps = congested && total > 0
                    ? (d.demandedMbps / total) * grp.capacity
                    : Math.min(d.demandedMbps, grp.capacity);
                d.throttled = congested;
                if (congested) congestedStationIds.add(d.connectedTo);
            }
        }
        for (const s of stations) {
            s.congested = congestedStationIds.has(s.id);
        }

        // 5. Advance VR downloads
        for (const d of devices) {
            if (d.state !== 'downloading') continue;
            const mbRecv = (d.allocatedMbps / 8) * dt;
            d.downloadProgress = Math.min(1, d.downloadProgress + mbRecv / appDlSize);
            if (d.downloadProgress >= 1) {
                d.state = 'connected'; d.downloadComplete = true; d.resumingDownload = false;
                const init = vrBgLoad * (0.9 + Math.random() * 0.2);
                d.demandedMbps = init; d.demandTarget = init;
            }
        }

        // 6. Metrics
        metricsTimerRef.current += rawDelta;
        if (metricsTimerRef.current >= 0.5) {
            metricsTimerRef.current = 0;
            const totalAlloc = devices.reduce((s, d) => s + d.allocatedMbps, 0);
            const entry = {t: metricsHistRef.current.length, load: Math.round(totalAlloc * 10) / 10};
            metricsHistRef.current = [...metricsHistRef.current.slice(-59), entry];
            setMetricsHistory([...metricsHistRef.current]);
        }
    }, []); // reads all settings from settingsRef

    // ── Animation loop ──
    useEffect(() => {
        if (paused || settingsOpen) { lastTsRef.current = null; return; }
        let renderTimer = 0;
        const loop = (ts) => {
            if (lastTsRef.current === null) lastTsRef.current = ts;
            const rawDelta = (ts - lastTsRef.current) / 1000;
            lastTsRef.current = ts;
            step(rawDelta);
            renderTimer += rawDelta;
            if (renderTimer >= 0.033) {
                renderTimer = 0;
                setSnapshot({
                    stations: stationsRef.current.map(s => ({...s})),
                    devices:  devicesRef.current.map(d => ({...d})),
                });
            }
            rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
        return () => { cancelAnimationFrame(rafRef.current); lastTsRef.current = null; };
    }, [paused, settingsOpen, step]);

    // ── Canvas drawing: connection lines + device dots ──
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        const {devices, stations} = snapshot;
        const stById = new Map(stations.map(s => [s.id, s]));

        // Connection lines
        for (const d of devices) {
            if (d.connectedTo === null || d.state === 'rejected') continue;
            const s = stById.get(d.connectedTo);
            if (!s) continue;
            ctx.beginPath();
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(s.x, s.y);
            ctx.strokeStyle = s.color;
            ctx.globalAlpha = d.throttled ? 0.07 : 0.22;
            ctx.lineWidth   = 0.7;
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Device dots
        for (const d of devices) {
            const color = getDeviceColor(d);
            const r     = 5;
            const alpha = d.throttled ? 0.4 : 0.9;

            // Glow ring for active / downloading (not throttled)
            if ((d.state === 'connected' || d.state === 'downloading') && !d.throttled) {
                ctx.beginPath();
                ctx.arc(d.x, d.y, r + 4, 0, 2 * Math.PI);
                ctx.strokeStyle = color;
                ctx.globalAlpha = 0.18;
                ctx.lineWidth   = 0.8;
                ctx.stroke();
            }

            // Dot
            ctx.beginPath();
            ctx.arc(d.x, d.y, r, 0, 2 * Math.PI);
            ctx.fillStyle   = color;
            ctx.globalAlpha = alpha;
            ctx.fill();
            ctx.globalAlpha = 1;

            // Download progress bar
            if (d.state === 'downloading') {
                const bw = 16, bh = 2.5, bx = d.x - 8, by = d.y + r + 2;
                ctx.fillStyle = '#1e3a5f';
                ctx.fillRect(bx, by, bw, bh);
                // orange = resuming, blue = fresh download
                ctx.fillStyle = d.resumingDownload ? '#f59e0b' : '#3b82f6';
                ctx.fillRect(bx, by, bw * d.downloadProgress, bh);
            }
        }
        ctx.globalAlpha = 1;
    }, [snapshot]);

    // ── Derived display values ──
    const {stations, devices} = snapshot;
    const activeConns    = devices.filter(d => d.state === 'connected' || d.state === 'downloading').length;
    const rejectedCount  = devices.filter(d => d.state === 'rejected').length;
    const totalAllocated = devices.reduce((s, d) => s + d.allocatedMbps, 0);
    const totalCapacity  = stations.reduce((s, st) => s + st.peakThroughput, 0);
    const loadPct        = totalCapacity > 0 ? (totalAllocated / totalCapacity) * 100 : 0;

    const stationStats = stations.map(s => {
        const myDevices = devices.filter(d => d.connectedTo === s.id);
        const accepted  = myDevices.filter(d => d.state !== 'rejected').length;
        const rejected  = myDevices.filter(d => d.state === 'rejected').length;
        const load      = myDevices.reduce((a, d) => a + d.allocatedMbps, 0);
        const congested = myDevices.some(d => d.throttled);
        let sectorStats = null;
        if (s.type === 'cellular') {
            sectorStats = [0, 1, 2].map(sec => {
                const sd = myDevices.filter(d => d.connectedSector === sec && d.state !== 'rejected');
                return {
                    count:     sd.length,
                    load:      sd.reduce((a, d) => a + d.allocatedMbps, 0),
                    congested: sd.some(d => d.throttled),
                };
            });
        }
        return {...s, accepted, rejected, load, congested, sectorStats};
    });

    // ─────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────
    return (
        <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden select-none">

            {/* ── Header ── */}
            <header className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-700 shrink-0">
                <h1 className="text-base font-bold text-blue-400 tracking-wide">Network Traffic Simulation</h1>
                <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs hidden sm:block">
                        {networkType} &middot; {stationCount} stations &middot; {deviceCount} devices &middot; {simMult}x
                    </span>
                    <button
                        onClick={() => setPaused(p => !p)}
                        className={`px-3 py-1 rounded font-medium text-xs ${paused ? 'bg-green-600 hover:bg-green-500' : 'bg-yellow-600 hover:bg-yellow-500'}`}
                    >
                        {paused ? 'Resume' : 'Pause'}
                    </button>
                    <button
                        onClick={() => setSettingsOpen(o => !o)}
                        className={`px-3 py-1 rounded font-medium text-xs ${settingsOpen ? 'bg-blue-700' : 'bg-gray-700 hover:bg-gray-600'}`}
                    >
                        Settings
                    </button>
                    <button
                        onClick={initSim}
                        className="px-3 py-1 rounded font-medium text-xs bg-gray-700 hover:bg-gray-600"
                    >
                        Reset
                    </button>
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden">

                {/* ── Settings Sidebar ── */}
                {settingsOpen && (
                    <aside className="w-64 bg-gray-900 border-r border-gray-700 p-4 overflow-y-auto shrink-0">
                        <p className="text-xs text-yellow-400 mb-3 font-medium">Simulation paused while settings open</p>

                        <SettingLabel label="Network Type">
                            <select value={networkType} onChange={e => setNetworkType(e.target.value)} className={selectCls}>
                                {Object.keys(NETWORK_PRESETS).map(k => <option key={k}>{k}</option>)}
                            </select>
                            <div className="text-xs text-gray-500 mt-2 bg-gray-800 rounded p-2 space-y-0.5">
                                <div>Type: <span className="text-gray-300">{preset.type}</span></div>
                                <div>Coverage radius: <span className="text-gray-300">{preset.radius} units</span></div>
                                <div>Max users/station: <span className="text-gray-300">{preset.maxUsers}</span></div>
                                <div>Peak throughput: <span className="text-gray-300">{fmtMbps(preset.peakThroughput)}</span></div>
                                <div>Latency: <span className="text-gray-300">{preset.latency} ms</span></div>
                            </div>
                        </SettingLabel>

                        <SettingLabel label={`Base Stations: ${stationCount}`}>
                            <input type="range" min={1} max={5} value={stationCount}
                                onChange={e => setStationCount(+e.target.value)} className="w-full accent-blue-500" />
                        </SettingLabel>

                        <SettingLabel label={`Devices: ${deviceCount}`}>
                            <input type="range" min={1} max={500} value={deviceCount}
                                onChange={e => setDeviceCount(+e.target.value)} className="w-full accent-blue-500" />
                        </SettingLabel>

                        <SettingLabel label={`VR Device Ratio: ${Math.round(vrRatio * 100)}%`}>
                            <input type="range" min={0} max={100} value={Math.round(vrRatio * 100)}
                                onChange={e => setVrRatio(+e.target.value / 100)} className="w-full accent-purple-500" />
                        </SettingLabel>

                        <SettingLabel label="Movement Speed">
                            <select value={moveSpeed} onChange={e => setMoveSpeed(e.target.value)} className={selectCls}>
                                <option value="slow">Slow</option>
                                <option value="medium">Medium</option>
                                <option value="fast">Fast</option>
                            </select>
                        </SettingLabel>

                        <SettingLabel label={`App Download Size: ${appDlSize} MB`}>
                            <input type="range" min={10} max={1000} step={10} value={appDlSize}
                                onChange={e => setAppDlSize(+e.target.value)} className="w-full accent-blue-500" />
                        </SettingLabel>

                        <SettingLabel label={`VR Background Load: ${vrBgLoad} Mbps`}>
                            <input type="range" min={10} max={500} step={5} value={vrBgLoad}
                                onChange={e => setVrBgLoad(+e.target.value)} className="w-full accent-purple-500" />
                        </SettingLabel>

                        <SettingLabel label="Simulation Speed">
                            <div className="flex gap-1">
                                {SIM_MULTIPLIERS.map(m => (
                                    <button key={m} onClick={() => setSimMult(m)}
                                        className={`flex-1 py-1 rounded text-xs font-bold ${simMult === m ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}>
                                        {m}x
                                    </button>
                                ))}
                            </div>
                        </SettingLabel>

                        <button
                            onClick={() => { initSim(); setSettingsOpen(false); }}
                            className="w-full mt-3 py-2 bg-blue-700 hover:bg-blue-600 rounded text-sm font-semibold"
                        >
                            Apply &amp; Resume
                        </button>
                    </aside>
                )}

                {/* ── Right column: canvas + metrics ── */}
                <div className="flex-1 flex flex-col overflow-hidden">

                    {/* ── Canvas area: SVG layer + canvas overlay ── */}
                    <div className="flex-1 overflow-hidden relative">

                        {/* SVG layer — coverage areas + station icons/labels only */}
                        <svg
                            viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
                            className="w-full h-full absolute inset-0"
                            style={{background: 'radial-gradient(ellipse at 50% 40%, #0d1b2a 0%, #050c14 100%)'}}
                        >
                            {/* Coverage areas */}
                            {stationStats.map(s => (
                                <g key={`cov-${s.id}`}>
                                    {s.type === 'cellular' ? (
                                        // Three 120° sector wedges
                                        [0, 1, 2].map(sec => (
                                            <path key={sec}
                                                d={wedgePath(s.x, s.y, s.radius, sec * 120, sec * 120 + 120)}
                                                fill={s.color}
                                                fillOpacity={s.sectorStats?.[sec]?.congested ? 0.22 : [0.13, 0.09, 0.11][sec]}
                                                stroke={s.color} strokeOpacity={0.22} strokeWidth={0.8}
                                            />
                                        ))
                                    ) : (
                                        <>
                                            <circle cx={s.x} cy={s.y} r={s.radius}
                                                fill={s.color} fillOpacity={0.06}
                                                stroke={s.color} strokeOpacity={0.2} strokeWidth={1} strokeDasharray="5 4" />
                                            <circle cx={s.x} cy={s.y} r={s.radius * 0.5}
                                                fill="none" stroke={s.color} strokeOpacity={0.08} strokeWidth={0.8} />
                                        </>
                                    )}
                                </g>
                            ))}

                            {/* Station icons + labels */}
                            {stationStats.map(s => {
                                const iy = s.y; // vertical anchor for icon
                                return (
                                    <g key={`sta-${s.id}`}>

                                        {s.type === 'wifi' ? (
                                            // Wi-Fi icon: 3 upward arcs + center dot
                                            <>
                                                {[16, 11, 6].map((r, i) => {
                                                    const half = Math.PI / 3; // 60°
                                                    const sa   = 3 * Math.PI / 2 - half;
                                                    const ea   = 3 * Math.PI / 2 + half;
                                                    const x1   = s.x + r * Math.cos(sa);
                                                    const y1   = iy  + r * Math.sin(sa);
                                                    const x2   = s.x + r * Math.cos(ea);
                                                    const y2   = iy  + r * Math.sin(ea);
                                                    return (
                                                        <path key={i}
                                                            d={`M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`}
                                                            fill="none" stroke={s.color}
                                                            strokeWidth={2.2 - i * 0.4} strokeOpacity={0.95 - i * 0.1}
                                                            strokeLinecap="round"
                                                        />
                                                    );
                                                })}
                                                <circle cx={s.x} cy={iy} r={2.5} fill={s.color} fillOpacity={0.95} />
                                            </>
                                        ) : (
                                            // Cellular tower icon: vertical mast + angled crossbars + base
                                            <>
                                                <line x1={s.x}      y1={iy - 22} x2={s.x}      y2={iy + 8}
                                                    stroke={s.color} strokeWidth={2.5} strokeOpacity={0.9} strokeLinecap="round" />
                                                <line x1={s.x}      y1={iy - 16} x2={s.x - 12} y2={iy - 8}
                                                    stroke={s.color} strokeWidth={1.5} strokeOpacity={0.85} strokeLinecap="round" />
                                                <line x1={s.x}      y1={iy - 16} x2={s.x + 12} y2={iy - 8}
                                                    stroke={s.color} strokeWidth={1.5} strokeOpacity={0.85} strokeLinecap="round" />
                                                <line x1={s.x}      y1={iy - 4}  x2={s.x - 8}  y2={iy + 2}
                                                    stroke={s.color} strokeWidth={1.5} strokeOpacity={0.7} strokeLinecap="round" />
                                                <line x1={s.x}      y1={iy - 4}  x2={s.x + 8}  y2={iy + 2}
                                                    stroke={s.color} strokeWidth={1.5} strokeOpacity={0.7} strokeLinecap="round" />
                                                <line x1={s.x - 8}  y1={iy + 8}  x2={s.x + 8}  y2={iy + 8}
                                                    stroke={s.color} strokeWidth={2}   strokeOpacity={0.6} strokeLinecap="round" />
                                            </>
                                        )}

                                        {/* Congestion warning ring */}
                                        {s.congested && (
                                            <circle cx={s.x} cy={iy - 7} r={24}
                                                fill="none" stroke="#ef4444"
                                                strokeWidth={1.5} strokeOpacity={0.75} strokeDasharray="3 3" />
                                        )}

                                        {/* Connected / capacity */}
                                        <text x={s.x} y={iy + 28} textAnchor="middle"
                                            fontSize={11} fontWeight="bold" fill={s.color} fontFamily="monospace">
                                            {s.accepted}/{s.maxUsers}
                                        </text>
                                        {s.rejected > 0 && (
                                            <text x={s.x} y={iy + 40} textAnchor="middle"
                                                fontSize={9} fill="#f87171" fontFamily="monospace">
                                                +{s.rejected} ovld
                                            </text>
                                        )}
                                        <text x={s.x} y={s.rejected > 0 ? iy + 52 : iy + 40}
                                            textAnchor="middle" fontSize={9} fill="#9ca3af" fontFamily="monospace">
                                            {fmtMbps(s.load)}
                                        </text>

                                        {/* Per-sector load labels (cellular only) */}
                                        {s.type === 'cellular' && s.sectorStats && s.sectorStats.map((sec, i) => {
                                            const midAngle = (i * 120 + 60) * Math.PI / 180;
                                            const lx = s.x + s.radius * 0.52 * Math.cos(midAngle);
                                            const ly = s.y + s.radius * 0.52 * Math.sin(midAngle);
                                            return (
                                                <text key={i} x={lx} y={ly} textAnchor="middle"
                                                    fontSize={8} fill={sec.congested ? '#f87171' : '#d1d5db'}
                                                    fontFamily="monospace">
                                                    {sec.count}u {fmtMbps(sec.load)}
                                                </text>
                                            );
                                        })}
                                    </g>
                                );
                            })}
                        </svg>

                        {/* Canvas layer — connection lines + device dots */}
                        <canvas
                            ref={canvasRef}
                            width={CANVAS_W}
                            height={CANVAS_H}
                            className="w-full h-full absolute inset-0 pointer-events-none"
                            style={{background: 'transparent'}}
                        />
                    </div>

                    {/* ── Metrics Panel ── */}
                    <div className="h-44 bg-gray-900 border-t border-gray-700 flex items-stretch shrink-0">

                        {/* Stats column */}
                        <div className="flex flex-col justify-center gap-1.5 px-4 py-2 w-52 shrink-0 border-r border-gray-800">
                            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Metrics</p>
                            <StatRow label="Active connections" value={activeConns}             color="text-green-400" />
                            <StatRow label="Rejected devices"   value={rejectedCount}           color="text-red-400" />
                            <StatRow label="Network load"       value={fmtMbps(totalAllocated)} color="text-blue-400" />
                            <StatRow label="Total capacity"     value={fmtMbps(totalCapacity)}  color="text-gray-300" />
                            <StatRow label="Avg latency"        value={`${preset.latency} ms`}  color="text-yellow-400" />
                        </div>

                        {/* Utilisation + legend */}
                        <div className="flex flex-col justify-start px-4 py-3 w-56 shrink-0 border-r border-gray-800 overflow-y-auto">
                            <p className="text-xs text-gray-400 mb-1">Utilisation</p>
                            <div className="w-full h-3 bg-gray-800 rounded overflow-hidden mb-1">
                                <div className="h-3 rounded transition-all duration-300"
                                    style={{
                                        width: `${Math.min(100, loadPct)}%`,
                                        background: loadPct > 80 ? '#ef4444' : loadPct > 50 ? '#f59e0b' : '#10b981',
                                    }} />
                            </div>
                            <p className="text-xs text-gray-500 mb-2">{loadPct.toFixed(2)}% of capacity</p>

                            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Devices</p>
                            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 mb-2">
                                {[
                                    ['VR unconnected', '#581c87'],
                                    ['VR downloading', '#c084fc'],
                                    ['VR active',      '#a855f7'],
                                    ['Normal unconn.', '#164e63'],
                                    ['Normal active',  '#22d3ee'],
                                    ['Rejected',       '#ef4444'],
                                ].map(([label, color]) => (
                                    <div key={label} className="flex items-center gap-1">
                                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{background: color}} />
                                        <span className="text-xs text-gray-400">{label}</span>
                                    </div>
                                ))}
                            </div>

                            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Stations / Other</p>
                            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                                {[
                                    ['Wi-Fi AP',      WIFI_COLORS[0]],
                                    ['Cell tower',    CELL_COLORS[0]],
                                    ['DL resuming',   '#f59e0b'],
                                    ['Throttled dim', '#6b7280'],
                                ].map(([label, color]) => (
                                    <div key={label} className="flex items-center gap-1">
                                        <div className="w-2.5 h-2.5 rounded shrink-0" style={{background: color}} />
                                        <span className="text-xs text-gray-400">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Real-time load chart */}
                        <div className="flex-1 px-4 py-2 min-w-0">
                            <p className="text-xs text-gray-400 mb-1">Total Allocated Throughput over time</p>
                            <ResponsiveContainer width="100%" height={130}>
                                <LineChart data={metricsHistory} margin={{top: 4, right: 8, left: 0, bottom: 0}}>
                                    <XAxis dataKey="t" hide />
                                    <YAxis
                                        tick={{fontSize: 9, fill: '#6b7280'}}
                                        width={45}
                                        tickFormatter={v => fmtMbps(v).replace(' ', '\u202f')}
                                    />
                                    <Tooltip
                                        contentStyle={{background: '#1f2937', border: 'none', borderRadius: 4, fontSize: 11}}
                                        formatter={v => [fmtMbps(v), 'Load']}
                                        labelFormatter={() => ''}
                                        cursor={{stroke: '#374151'}}
                                    />
                                    <Line type="monotone" dataKey="load" stroke="#3b82f6" strokeWidth={2}
                                        dot={false} isAnimationActive={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────
// Helper sub-components
// ─────────────────────────────────────────────

const selectCls =
    'w-full mt-1 bg-gray-800 text-white rounded px-2 py-1.5 text-sm border border-gray-600 focus:outline-none focus:border-blue-500';

function SettingLabel({label, children}) {
    return (
        <div className="mb-4">
            <p className="text-xs text-gray-400 font-medium mb-1">{label}</p>
            {children}
        </div>
    );
}

function StatRow({label, value, color}) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">{label}</span>
            <span className={`text-xs font-bold ${color}`}>{value}</span>
        </div>
    );
}
