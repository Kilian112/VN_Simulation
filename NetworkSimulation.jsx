import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// ─────────────────────────────────────────────
// Constants & Presets
// ─────────────────────────────────────────────

const CANVAS_W = 900;
const CANVAS_H = 560;

const NETWORK_PRESETS = {
  'Wi-Fi 6': { radius: 150, maxUsers: 20,  peakThroughput: 9600,    latency: 2    },
  'Wi-Fi 7': { radius: 175, maxUsers: 25,  peakThroughput: 46000,   latency: 1    },
  'Wi-Fi 8': { radius: 200, maxUsers: 30,  peakThroughput: 100000,  latency: 0.5  },
  '4G':      { radius: 280, maxUsers: 50,  peakThroughput: 100,     latency: 30   },
  '5G':      { radius: 240, maxUsers: 100, peakThroughput: 20000,   latency: 5    },
  '6G':      { radius: 320, maxUsers: 150, peakThroughput: 1000000, latency: 0.1  },
};

// Pixels per second for each speed setting
const SPEED_PX = { slow: 25, medium: 70, fast: 160 };

const SIM_MULTIPLIERS = [0.5, 1, 2, 5];

// Colors assigned per station index
const STATION_COLORS = ['#60a5fa', '#34d399', '#f59e0b', '#f87171', '#a78bfa'];

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

/**
 * Place `count` base stations spread across the canvas in a grid, with jitter.
 */
function makeStations(count, presetKey) {
  const p = NETWORK_PRESETS[presetKey];
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = CANVAS_W / cols;
  const cellH = CANVAS_H / rows;
  return Array.from({ length: count }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      id: i,
      x: cellW * col + cellW * 0.2 + Math.random() * cellW * 0.6,
      y: cellH * row + cellH * 0.2 + Math.random() * cellH * 0.6,
      radius:         p.radius,
      maxUsers:       p.maxUsers,
      peakThroughput: p.peakThroughput,
      latency:        p.latency,
    };
  });
}

/**
 * Create `count` devices at random positions with random unit-vector velocities.
 */
function makeDevices(count) {
  return Array.from({ length: count }, (_, i) => {
    const angle = Math.random() * Math.PI * 2;
    return {
      id:               i,
      x:                Math.random() * CANVAS_W,
      y:                Math.random() * CANVAS_H,
      vx:               Math.cos(angle),  // unit vector; scaled by speed in step()
      vy:               Math.sin(angle),
      connectedTo:      null,             // station id or null
      // state: 'unconnected' | 'downloading' | 'connected' | 'rejected'
      state:            'unconnected',
      downloadProgress: 0,               // 0–1
    };
  });
}

// ─────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────

export default function NetworkSimulation() {
  // ── Settings (trigger re-init when changed via Apply & Reset) ──
  const [networkType,  setNetworkType]  = useState('5G');
  const [stationCount, setStationCount] = useState(3);
  const [deviceCount,  setDeviceCount]  = useState(15);
  const [moveSpeed,    setMoveSpeed]    = useState('medium');
  const [appDlSize,    setAppDlSize]    = useState(100);   // MB
  const [bgLoad,       setBgLoad]       = useState(5);     // Mbps per fully-connected device
  const [simMult,      setSimMult]      = useState(1);
  const [paused,       setPaused]       = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Simulation state in refs (mutated every frame without triggering renders) ──
  const stationsRef     = useRef([]);
  const devicesRef      = useRef([]);
  const rafRef          = useRef(null);
  const lastTsRef       = useRef(null);
  const metricsTimerRef = useRef(0);
  const metricsHistRef  = useRef([]);

  // ── Renderable snapshots (~30 fps) ──
  const [snapshot,       setSnapshot]       = useState({ stations: [], devices: [] });
  const [metricsHistory, setMetricsHistory] = useState([]);

  // Always-current settings for use inside the RAF closure
  const settingsRef = useRef({});
  settingsRef.current = { networkType, moveSpeed, appDlSize, bgLoad, simMult };

  const preset = NETWORK_PRESETS[networkType];

  // ── Initialise / reset ──
  const initSim = useCallback(() => {
    stationsRef.current  = makeStations(stationCount, networkType);
    devicesRef.current   = makeDevices(deviceCount);
    metricsHistRef.current = [];
    metricsTimerRef.current = 0;
    setMetricsHistory([]);
    setSnapshot({
      stations: stationsRef.current.map(s => ({ ...s })),
      devices:  devicesRef.current.map(d => ({ ...d })),
    });
  }, [stationCount, deviceCount, networkType]);

  useEffect(() => { initSim(); }, [initSim]);

  // ── Single simulation step ──
  // Called from the RAF loop; reads live settings from settingsRef.
  const step = useCallback((rawDelta) => {
    const { moveSpeed, appDlSize, bgLoad, simMult } = settingsRef.current;
    const dt       = Math.min(rawDelta, 0.1) * simMult;   // capped, then scaled
    const speedPx  = SPEED_PX[moveSpeed];
    const stations = stationsRef.current;
    const devices  = devicesRef.current;

    // ── 1. Move devices (bounce off walls) ──
    for (const d of devices) {
      d.x += d.vx * speedPx * dt;
      d.y += d.vy * speedPx * dt;
      if (d.x < 8)            { d.x = 8;            d.vx =  Math.abs(d.vx); }
      if (d.x > CANVAS_W - 8) { d.x = CANVAS_W - 8; d.vx = -Math.abs(d.vx); }
      if (d.y < 8)            { d.y = 8;            d.vy =  Math.abs(d.vy); }
      if (d.y > CANVAS_H - 8) { d.y = CANVAS_H - 8; d.vy = -Math.abs(d.vy); }
    }

    // ── 2. Assign devices to stations ──
    // Sort by distance so closest devices win limited slots (greedy).
    const slotsTaken = new Map(stations.map(s => [s.id, 0]));

    const withNearest = devices.map(d => {
      let best = null, bestDist = Infinity;
      for (const s of stations) {
        const dd = euclidDist(d, s);
        if (dd <= s.radius && dd < bestDist) { best = s; bestDist = dd; }
      }
      return { d, best, bestDist };
    });
    withNearest.sort((a, b) => a.bestDist - b.bestDist);

    for (const { d, best } of withNearest) {
      if (!best) {
        // Out of all coverage areas → unconnected
        d.connectedTo      = null;
        d.state            = 'unconnected';
        d.downloadProgress = 0;
        continue;
      }

      d.connectedTo = best.id;
      const taken = slotsTaken.get(best.id);

      if (taken < best.maxUsers) {
        // Accepted into station
        slotsTaken.set(best.id, taken + 1);

        // If newly entering coverage, start download
        if (d.state === 'unconnected' || d.state === 'rejected') {
          d.state            = 'downloading';
          d.downloadProgress = 0;
        }

        // Advance download
        if (d.state === 'downloading') {
          const accepted    = slotsTaken.get(best.id);
          const shareMbps   = best.peakThroughput / accepted;
          const mbReceived  = (shareMbps / 8) * dt; // Mbps → MB/s → MB in dt seconds
          d.downloadProgress = Math.min(1, d.downloadProgress + mbReceived / appDlSize);
          if (d.downloadProgress >= 1) d.state = 'connected';
        }
        // 'connected' devices just stay connected; background load is accounted in metrics
      } else {
        // Station at capacity → rejected
        d.state = 'rejected';
      }
    }

    // ── 3. Collect metrics every 0.5 real-time seconds ──
    metricsTimerRef.current += rawDelta;
    if (metricsTimerRef.current >= 0.5) {
      metricsTimerRef.current = 0;
      const connectedCount = devices.filter(d => d.state === 'connected').length;
      const totalLoad      = connectedCount * bgLoad;
      const entry = { t: metricsHistRef.current.length, load: Math.round(totalLoad * 10) / 10 };
      metricsHistRef.current = [...metricsHistRef.current.slice(-59), entry];
      setMetricsHistory([...metricsHistRef.current]);
    }
  }, []); // intentionally empty — reads settings from settingsRef

  // ── Animation loop ──
  useEffect(() => {
    if (paused || settingsOpen) {
      lastTsRef.current = null;
      return;
    }

    let renderTimer = 0;

    const loop = (ts) => {
      if (lastTsRef.current === null) lastTsRef.current = ts;
      const rawDelta = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;

      step(rawDelta);

      // Push a render snapshot at ~30 fps
      renderTimer += rawDelta;
      if (renderTimer >= 0.033) {
        renderTimer = 0;
        setSnapshot({
          stations: stationsRef.current.map(s => ({ ...s })),
          devices:  devicesRef.current.map(d => ({ ...d })),
        });
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [paused, settingsOpen, step]);

  // ── Derived display values from latest snapshot ──
  const { stations, devices } = snapshot;

  const activeConns   = devices.filter(d => d.state === 'connected' || d.state === 'downloading').length;
  const rejectedCount = devices.filter(d => d.state === 'rejected').length;
  const totalLoad     = devices.filter(d => d.state === 'connected').length * bgLoad;
  const totalCapacity = stations.reduce((sum, s) => sum + s.peakThroughput, 0);
  const loadPct       = totalCapacity > 0 ? (totalLoad / totalCapacity) * 100 : 0;

  // Per-station aggregated stats for the SVG labels
  const stationStats = stations.map((s, i) => {
    const myDevices = devices.filter(d => d.connectedTo === s.id);
    const accepted  = myDevices.filter(d => d.state !== 'rejected').length;
    const rejected  = myDevices.filter(d => d.state === 'rejected').length;
    const load      = myDevices.filter(d => d.state === 'connected').length * bgLoad;
    return { ...s, accepted, rejected, load, color: STATION_COLORS[i % STATION_COLORS.length] };
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
              <select
                value={networkType}
                onChange={e => setNetworkType(e.target.value)}
                className={selectCls}
              >
                {Object.keys(NETWORK_PRESETS).map(k => <option key={k}>{k}</option>)}
              </select>
              {/* Show preset summary */}
              <div className="text-xs text-gray-500 mt-2 bg-gray-800 rounded p-2 space-y-0.5">
                <div>Coverage radius: <span className="text-gray-300">{preset.radius} units</span></div>
                <div>Max users/station: <span className="text-gray-300">{preset.maxUsers}</span></div>
                <div>Peak throughput: <span className="text-gray-300">{fmtMbps(preset.peakThroughput)}</span></div>
                <div>Latency: <span className="text-gray-300">{preset.latency} ms</span></div>
              </div>
            </SettingLabel>

            <SettingLabel label={`Base Stations: ${stationCount}`}>
              <input
                type="range" min={1} max={5} value={stationCount}
                onChange={e => setStationCount(+e.target.value)}
                className="w-full accent-blue-500"
              />
            </SettingLabel>

            <SettingLabel label={`Devices: ${deviceCount}`}>
              <input
                type="range" min={1} max={30} value={deviceCount}
                onChange={e => setDeviceCount(+e.target.value)}
                className="w-full accent-blue-500"
              />
            </SettingLabel>

            <SettingLabel label="Movement Speed">
              <select
                value={moveSpeed}
                onChange={e => setMoveSpeed(e.target.value)}
                className={selectCls}
              >
                <option value="slow">Slow</option>
                <option value="medium">Medium</option>
                <option value="fast">Fast</option>
              </select>
            </SettingLabel>

            <SettingLabel label={`App Download Size: ${appDlSize} MB`}>
              <input
                type="range" min={10} max={1000} step={10} value={appDlSize}
                onChange={e => setAppDlSize(+e.target.value)}
                className="w-full accent-blue-500"
              />
            </SettingLabel>

            <SettingLabel label={`Background Load: ${bgLoad} Mbps/device`}>
              <input
                type="range" min={0.1} max={100} step={0.1} value={bgLoad}
                onChange={e => setBgLoad(+e.target.value)}
                className="w-full accent-blue-500"
              />
            </SettingLabel>

            <SettingLabel label="Simulation Speed">
              <div className="flex gap-1">
                {SIM_MULTIPLIERS.map(m => (
                  <button
                    key={m}
                    onClick={() => setSimMult(m)}
                    className={`flex-1 py-1 rounded text-xs font-bold ${simMult === m ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
                  >
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

          {/* ── SVG Canvas ── */}
          <div className="flex-1 overflow-hidden">
            <svg
              viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
              className="w-full h-full"
              style={{ background: 'radial-gradient(ellipse at 50% 40%, #0d1b2a 0%, #050c14 100%)' }}
            >
              {/* ── Coverage radius rings ── */}
              {stationStats.map(s => (
                <g key={`cov-${s.id}`}>
                  {/* Outer fill */}
                  <circle
                    cx={s.x} cy={s.y} r={s.radius}
                    fill={s.color} fillOpacity={0.05}
                    stroke={s.color} strokeOpacity={0.2} strokeWidth={1} strokeDasharray="5 4"
                  />
                  {/* Inner ring at 50% radius for depth */}
                  <circle
                    cx={s.x} cy={s.y} r={s.radius * 0.5}
                    fill="none"
                    stroke={s.color} strokeOpacity={0.08} strokeWidth={0.8}
                  />
                </g>
              ))}

              {/* ── Connection lines (device → station) ── */}
              {devices
                .filter(d => d.connectedTo !== null && d.state !== 'rejected')
                .map(d => {
                  const s = stations.find(st => st.id === d.connectedTo);
                  if (!s) return null;
                  const color = STATION_COLORS[s.id % STATION_COLORS.length];
                  return (
                    <line
                      key={`line-${d.id}`}
                      x1={d.x} y1={d.y} x2={s.x} y2={s.y}
                      stroke={color} strokeWidth={0.7} strokeOpacity={0.3}
                    />
                  );
                })}

              {/* ── Base Stations ── */}
              {stationStats.map(s => {
                const labelY = s.y + 55;
                return (
                  <g key={`sta-${s.id}`}>
                    {/* Tower triangle */}
                    <polygon
                      points={`${s.x},${s.y - 18} ${s.x - 11},${s.y + 9} ${s.x + 11},${s.y + 9}`}
                      fill={s.color} fillOpacity={0.85}
                      stroke="#fff" strokeWidth={0.4} strokeOpacity={0.3}
                    />
                    {/* Mast */}
                    <rect x={s.x - 2.5} y={s.y + 9} width={5} height={11} fill={s.color} fillOpacity={0.8} />
                    {/* Base */}
                    <rect x={s.x - 8} y={s.y + 19} width={16} height={3} rx={1} fill={s.color} fillOpacity={0.5} />

                    {/* Connected / max label */}
                    <text
                      x={s.x} y={s.y + 36}
                      textAnchor="middle" fontSize={11} fontWeight="bold"
                      fill={s.color} fontFamily="monospace"
                    >
                      {s.accepted}/{s.maxUsers}
                    </text>

                    {/* Overload label */}
                    {s.rejected > 0 && (
                      <text
                        x={s.x} y={s.y + 48}
                        textAnchor="middle" fontSize={9}
                        fill="#f87171" fontFamily="monospace"
                      >
                        +{s.rejected} ovld
                      </text>
                    )}

                    {/* Load label */}
                    <text
                      x={s.x} y={s.rejected > 0 ? s.y + 60 : s.y + 48}
                      textAnchor="middle" fontSize={9}
                      fill="#9ca3af" fontFamily="monospace"
                    >
                      {fmtMbps(s.load)}
                    </text>
                  </g>
                );
              })}

              {/* ── Devices ── */}
              {devices.map(d => {
                const fillColor =
                  d.state === 'unconnected' ? '#6b7280' :
                  d.state === 'downloading' ? '#3b82f6' :
                  d.state === 'connected'   ? '#10b981' :
                  /* rejected */              '#ef4444';

                return (
                  <g key={`dev-${d.id}`}>
                    {/* Outer glow ring for active devices */}
                    {(d.state === 'connected' || d.state === 'downloading') && (
                      <circle
                        cx={d.x} cy={d.y} r={10}
                        fill="none"
                        stroke={fillColor} strokeWidth={0.8} strokeOpacity={0.25}
                      />
                    )}

                    {/* Device dot */}
                    <circle
                      cx={d.x} cy={d.y} r={6}
                      fill={fillColor} fillOpacity={0.9}
                      stroke={fillColor} strokeWidth={1} strokeOpacity={0.4}
                    />

                    {/* Download progress bar */}
                    {d.state === 'downloading' && (
                      <>
                        {/* Background track */}
                        <rect
                          x={d.x - 9} y={d.y + 9} width={18} height={3}
                          fill="#1e3a5f" rx={1.5}
                        />
                        {/* Fill */}
                        <rect
                          x={d.x - 9} y={d.y + 9}
                          width={18 * d.downloadProgress} height={3}
                          fill="#3b82f6" rx={1.5}
                        />
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {/* ── Metrics Panel ── */}
          <div className="h-40 bg-gray-900 border-t border-gray-700 flex items-stretch gap-0 shrink-0">

            {/* Stats column */}
            <div className="flex flex-col justify-center gap-1.5 px-4 py-2 w-52 shrink-0 border-r border-gray-800">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Metrics</p>
              <StatRow label="Active connections" value={activeConns}         color="text-green-400" />
              <StatRow label="Rejected devices"   value={rejectedCount}       color="text-red-400"   />
              <StatRow label="Network load"        value={fmtMbps(totalLoad)} color="text-blue-400"  />
              <StatRow label="Total capacity"      value={fmtMbps(totalCapacity)} color="text-gray-300" />
              <StatRow label="Avg latency"         value={`${preset.latency} ms`} color="text-yellow-400" />
            </div>

            {/* Utilisation + legend */}
            <div className="flex flex-col justify-center px-4 py-2 w-44 shrink-0 border-r border-gray-800">
              <p className="text-xs text-gray-400 mb-1">Utilisation</p>
              <div className="w-full h-4 bg-gray-800 rounded overflow-hidden">
                <div
                  className="h-4 rounded transition-all duration-300"
                  style={{
                    width: `${Math.min(100, loadPct)}%`,
                    background: loadPct > 80 ? '#ef4444' : loadPct > 50 ? '#f59e0b' : '#10b981',
                  }}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">{loadPct.toFixed(2)}% of capacity</p>

              {/* Legend */}
              <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1">
                {[
                  ['Unconnected', '#6b7280'],
                  ['Downloading', '#3b82f6'],
                  ['Connected',   '#10b981'],
                  ['Rejected',    '#ef4444'],
                ].map(([label, color]) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                    <span className="text-xs text-gray-400">{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Real-time load chart */}
            <div className="flex-1 px-4 py-2 min-w-0">
              <p className="text-xs text-gray-400 mb-1">Total Network Load over time (Mbps)</p>
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={metricsHistory} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <XAxis dataKey="t" hide />
                  <YAxis
                    tick={{ fontSize: 9, fill: '#6b7280' }}
                    width={45}
                    tickFormatter={v => fmtMbps(v).replace(' ', '\u202f')}
                  />
                  <Tooltip
                    contentStyle={{ background: '#1f2937', border: 'none', borderRadius: 4, fontSize: 11 }}
                    formatter={v => [fmtMbps(v), 'Load']}
                    labelFormatter={() => ''}
                    cursor={{ stroke: '#374151' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="load"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
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

function SettingLabel({ label, children }) {
  return (
    <div className="mb-4">
      <p className="text-xs text-gray-400 font-medium mb-1">{label}</p>
      {children}
    </div>
  );
}

function StatRow({ label, value, color }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-gray-400">{label}</span>
      <span className={`text-xs font-bold ${color}`}>{value}</span>
    </div>
  );
}
