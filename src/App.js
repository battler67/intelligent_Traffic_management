import { useEffect, useRef, useState } from 'react';
import './App.css';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://127.0.0.1:8000';
const LANE_ORDER = ['N', 'E', 'S', 'W'];
const EMPTY_LANE_DISTRIBUTION = { N: 0, E: 0, S: 0, W: 0 };
const EMPTY_METRICS = {
  totalVehicles: 0,
  ambulanceCount: 0,
  emergencyVehicleCount: 0,
  haltingVehicleCount: 0,
  movingVehicleCount: 0,
  averageWaitTimeSec: 0,
  averageHaltingWaitTimeSec: 0,
  laneDistribution: EMPTY_LANE_DISTRIBUTION,
  laneStats: {},
  currentGreenLane: null,
  signalCycleTimeSec: 0,
};

function formatSeconds(value) {
  return `${Number(value || 0).toFixed(2)}s`;
}

function buildPolylinePoints(values, width, height) {
  if (!values.length) {
    return '';
  }

  const maxValue = Math.max(...values, 1);
  const step = values.length === 1 ? width : width / (values.length - 1);

  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / maxValue) * height;
      return `${x},${y.toFixed(2)}`;
    })
    .join(' ');
}

function MetricSparkline({ values, stroke, fill }) {
  const width = 320;
  const height = 88;
  const points = buildPolylinePoints(values, width, height);

  if (!points) {
    return (
      <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1="0" y1={height - 2} x2={width} y2={height - 2} className="sparkline-empty" />
      </svg>
    );
  }

  const fillPoints = `${points} ${width},${height} 0,${height}`;

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polygon points={fillPoints} fill={fill} />
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function MetricCard({ label, value, accent, caption }) {
  return (
    <article className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value" style={{ color: accent }}>
        {value}
      </strong>
      <span className="metric-caption">{caption}</span>
    </article>
  );
}

function LaneCard({ lane, stats, totalVehicles, active }) {
  const laneVehicles = stats?.vehicles || 0;
  const laneShare = totalVehicles ? Math.round((laneVehicles / totalVehicles) * 100) : 0;

  return (
    <article className={`lane-card ${active ? 'lane-card-active' : ''}`}>
      <header className="lane-card-header">
        <span className="lane-token">{lane}</span>
        <span className="lane-share">{laneShare}% share</span>
      </header>
      <strong className="lane-count">{laneVehicles}</strong>
      <div className="lane-meta">
        <span>Halting {stats?.halting || 0}</span>
        <span>Ambulances {stats?.ambulances || 0}</span>
      </div>
      <div className="lane-progress">
        <div className="lane-progress-bar" style={{ width: `${laneShare}%` }} />
      </div>
      <span className="lane-wait">Avg wait {formatSeconds(stats?.averageWaitTimeSec || 0)}</span>
    </article>
  );
}

function App() {
  const streamRef = useRef(null);
  const [config, setConfig] = useState(null);
  const [session, setSession] = useState(null);
  const [currentFrame, setCurrentFrame] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState({
    tone: 'idle',
    title: 'Backend required',
    message: 'Start the Python server to stream YOLO analysis into the dashboard.',
  });
  const [form, setForm] = useState({
    videoPath: '',
    processFps: '10',
    emitIntervalSec: '1',
    realtime: true,
  });

  useEffect(() => {
    let isCancelled = false;

    async function loadConfig() {
      try {
        const response = await fetch(`${API_BASE}/api/config`);
        if (!response.ok) {
          throw new Error(`Backend responded with ${response.status}`);
        }

        const payload = await response.json();
        if (isCancelled) {
          return;
        }

        setConfig(payload);
        setForm({
          videoPath: payload.defaultVideoPath || '',
          processFps: String(payload.defaults?.processFps || 10),
          emitIntervalSec: String(payload.defaults?.emitIntervalSec || 1),
          realtime: Boolean(payload.defaults?.realtime),
        });
        setStatus({
          tone: 'ready',
          title: 'Backend online',
          message: 'Model bundle detected. Choose a video path and start the stream.',
        });
      } catch (loadError) {
        if (isCancelled) {
          return;
        }

        setError(loadError.message);
        setStatus({
          tone: 'error',
          title: 'Backend unavailable',
          message: 'Run the Python backend first. The React dashboard is ready to connect.',
        });
      }
    }

    loadConfig();

    return () => {
      isCancelled = true;
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, []);

  function updateForm(field, value) {
    setForm((previous) => ({
      ...previous,
      [field]: value,
    }));
  }

  function stopStream(nextStatus) {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    setIsStreaming(false);
    if (nextStatus) {
      setStatus(nextStatus);
    }
  }

  function startStream() {
    const videoPath = form.videoPath.trim();
    const processFps = Number(form.processFps);
    const emitIntervalSec = Number(form.emitIntervalSec);

    if (!videoPath) {
      setError('Video path is required.');
      return;
    }
    if (!Number.isFinite(processFps) || processFps <= 0) {
      setError('Process FPS must be greater than 0.');
      return;
    }
    if (!Number.isFinite(emitIntervalSec) || emitIntervalSec <= 0) {
      setError('Emit interval must be greater than 0.');
      return;
    }

    setError('');
    setCurrentFrame(null);
    setHistory([]);
    setSession(null);
    stopStream();

    const params = new URLSearchParams({
      videoPath,
      processFps: String(processFps),
      emitIntervalSec: String(emitIntervalSec),
      realtime: String(form.realtime),
    });
    const source = new EventSource(`${API_BASE}/api/stream?${params.toString()}`);
    streamRef.current = source;
    setIsStreaming(true);
    setStatus({
      tone: 'streaming',
      title: 'Streaming analysis',
      message: 'The backend is now emitting one JSON snapshot per second.',
    });

    source.onmessage = (event) => {
      if (streamRef.current !== source) {
        return;
      }

      const payload = JSON.parse(event.data);
      setError('');

      if (payload.type === 'session') {
        setSession(payload);
        setStatus({
          tone: 'streaming',
          title: 'Video session started',
          message: `${payload.video?.path || videoPath} is now being analyzed.`,
        });
        return;
      }

      if (payload.type === 'analysis') {
        setCurrentFrame(payload);
        setHistory((previous) => [...previous.slice(-23), payload]);
        return;
      }

      if (payload.type === 'complete') {
        if (payload.finalFrame) {
          setCurrentFrame(payload.finalFrame);
        }
        stopStream({
          tone: 'ready',
          title: 'Analysis complete',
          message: `Processed ${payload.emittedCount || 0} snapshots up to ${payload.lastTimestampLabel || '00:00'}.`,
        });
        return;
      }

      if (payload.type === 'error') {
        setError(payload.message || 'The backend reported an error.');
        stopStream({
          tone: 'error',
          title: 'Stream failed',
          message: payload.message || 'The backend reported an error.',
        });
      }
    };

    source.onerror = () => {
      if (streamRef.current !== source) {
        return;
      }

      setError('The SSE connection closed unexpectedly.');
      stopStream({
        tone: 'error',
        title: 'Connection dropped',
        message: 'The stream disconnected before completion.',
      });
    };
  }

  const metrics = currentFrame?.metrics || EMPTY_METRICS;
  const laneStats = metrics.laneStats || {};
  const totalVehicles = metrics.totalVehicles || 0;
  const recentVehicleCounts = history.map((entry) => entry.metrics.totalVehicles || 0);
  const recentWaitTimes = history.map((entry) => entry.metrics.averageWaitTimeSec || 0);
  const recentEmergencyCounts = history.map((entry) => entry.metrics.emergencyVehicleCount || 0);
  const latestVehicles = currentFrame?.vehicleDetails || [];
  const recentFrames = [...history].reverse();
  const videoUrl = form.videoPath.trim()
    ? `${API_BASE}/api/video?path=${encodeURIComponent(form.videoPath.trim())}`
    : '';

  return (
    <div className="app-shell">
      <div className="app-glow app-glow-one" />
      <div className="app-glow app-glow-two" />

      <main className="dashboard">
        <section className="hero panel">
          <div className="hero-copy">
            <span className="eyebrow">YOLO Traffic Intelligence</span>
            <h1>Interactive command dashboard for four-way traffic flow analysis.</h1>
            <p className="hero-text">
              Streams vehicle JSON from the local model bundle, tracks ambulances, measures wait
              time, and breaks down north, east, south, and west lane pressure in real time.
            </p>
            <div className="hero-tags">
              <span>Bundle {config?.bundlePath || 'pending'}</span>
              <span>Video {session?.video?.durationSec || config?.video?.durationSec || 0}s</span>
              <span>Frames {session?.video?.frameCount || config?.video?.frameCount || 0}</span>
            </div>
          </div>

          <div className={`status-card status-${status.tone}`}>
            <span className="status-kicker">{status.title}</span>
            <p>{status.message}</p>
            <div className="status-actions">
              <button className="primary-button" onClick={startStream} disabled={isStreaming}>
                Start stream
              </button>
              <button
                className="secondary-button"
                onClick={() =>
                  stopStream({
                    tone: 'ready',
                    title: 'Stream stopped',
                    message: 'The stream was closed from the dashboard.',
                  })
                }
                disabled={!isStreaming}
              >
                Stop stream
              </button>
            </div>
          </div>
        </section>

        <section className="top-grid">
          <article className="panel video-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Video Source</span>
                <h2>Local preview</h2>
              </div>
              <span className="panel-badge">
                {currentFrame?.timestampLabel || session?.video?.durationSec || '00:00'}
              </span>
            </div>

            {videoUrl ? (
              <video key={videoUrl} className="video-player" controls preload="metadata" src={videoUrl} />
            ) : (
              <div className="video-placeholder">Enter a local video path to preview the source.</div>
            )}

            <div className="video-meta-grid">
              <div>
                <span>Current timestamp</span>
                <strong>{currentFrame?.timestampLabel || '00:00'}</strong>
              </div>
              <div>
                <span>Current green lane</span>
                <strong>{metrics.currentGreenLane || 'Pending'}</strong>
              </div>
              <div>
                <span>Signal cycle</span>
                <strong>{formatSeconds(metrics.signalCycleTimeSec)}</strong>
              </div>
            </div>
          </article>

          <article className="panel control-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Controls</span>
                <h2>Session setup</h2>
              </div>
            </div>

            <label className="field">
              <span>Video path</span>
              <input
                type="text"
                value={form.videoPath}
                onChange={(event) => updateForm('videoPath', event.target.value)}
                placeholder="C:\\Users\\seera\\Downloads\\5927708-hd_1080_1920_30fps.mp4"
              />
            </label>

            <div className="field-row">
              <label className="field">
                <span>Process FPS</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.processFps}
                  onChange={(event) => updateForm('processFps', event.target.value)}
                />
              </label>

              <label className="field">
                <span>Emit interval (sec)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.emitIntervalSec}
                  onChange={(event) => updateForm('emitIntervalSec', event.target.value)}
                />
              </label>
            </div>

            <label className="toggle-row">
              <span>Wall-clock pacing</span>
              <button
                type="button"
                className={`toggle-chip ${form.realtime ? 'toggle-chip-on' : ''}`}
                onClick={() => updateForm('realtime', !form.realtime)}
              >
                {form.realtime ? 'Real time' : 'Fast as possible'}
              </button>
            </label>

            <div className="config-list">
              <div>
                <span>Backend</span>
                <strong>{API_BASE}</strong>
              </div>
              <div>
                <span>Runtime config</span>
                <strong>{config?.configPath || 'Waiting for backend'}</strong>
              </div>
              <div>
                <span>Lane order</span>
                <strong>{(config?.lanes || LANE_ORDER).join(' / ')}</strong>
              </div>
            </div>

            {error ? <p className="error-text">{error}</p> : null}
          </article>
        </section>

        <section className="metric-grid">
          <MetricCard
            label="Vehicles"
            value={metrics.totalVehicles}
            accent="#ffd166"
            caption={`${metrics.movingVehicleCount} moving right now`}
          />
          <MetricCard
            label="Ambulances"
            value={metrics.ambulanceCount}
            accent="#ff6b6b"
            caption={`${metrics.emergencyVehicleCount} emergency vehicles`}
          />
          <MetricCard
            label="Average wait"
            value={formatSeconds(metrics.averageWaitTimeSec)}
            accent="#5eead4"
            caption={`Halting avg ${formatSeconds(metrics.averageHaltingWaitTimeSec)}`}
          />
          <MetricCard
            label="Halting vehicles"
            value={metrics.haltingVehicleCount}
            accent="#8ec5ff"
            caption={`Cycle ${formatSeconds(metrics.signalCycleTimeSec)}`}
          />
        </section>

        <section className="middle-grid">
          <article className="panel lane-board">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Lane Distribution</span>
                <h2>Compass view</h2>
              </div>
              <span className="panel-badge">{totalVehicles} vehicles tracked</span>
            </div>

            <div className="compass-grid">
              <div className="compass-slot compass-north">
                <LaneCard
                  lane="N"
                  stats={laneStats.N}
                  totalVehicles={totalVehicles}
                  active={metrics.currentGreenLane === 'N'}
                />
              </div>
              <div className="compass-slot compass-west">
                <LaneCard
                  lane="W"
                  stats={laneStats.W}
                  totalVehicles={totalVehicles}
                  active={metrics.currentGreenLane === 'W'}
                />
              </div>
              <div className="compass-slot compass-center">
                <div className="signal-core">
                  <span className="signal-kicker">Signal focus</span>
                  <strong>{metrics.currentGreenLane || 'No active lane'}</strong>
                  <p>{metrics.haltingVehicleCount} vehicles are currently halting.</p>
                </div>
              </div>
              <div className="compass-slot compass-east">
                <LaneCard
                  lane="E"
                  stats={laneStats.E}
                  totalVehicles={totalVehicles}
                  active={metrics.currentGreenLane === 'E'}
                />
              </div>
              <div className="compass-slot compass-south">
                <LaneCard
                  lane="S"
                  stats={laneStats.S}
                  totalVehicles={totalVehicles}
                  active={metrics.currentGreenLane === 'S'}
                />
              </div>
            </div>
          </article>

          <article className="panel trend-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Recent Trend</span>
                <h2>Last 24 emitted snapshots</h2>
              </div>
            </div>

            <div className="trend-stack">
              <div className="trend-card">
                <div className="trend-meta">
                  <span>Vehicle count</span>
                  <strong>{recentVehicleCounts[recentVehicleCounts.length - 1] || 0}</strong>
                </div>
                <MetricSparkline values={recentVehicleCounts} stroke="#ffd166" fill="rgba(255, 209, 102, 0.16)" />
              </div>

              <div className="trend-card">
                <div className="trend-meta">
                  <span>Average wait</span>
                  <strong>{formatSeconds(recentWaitTimes[recentWaitTimes.length - 1] || 0)}</strong>
                </div>
                <MetricSparkline values={recentWaitTimes} stroke="#5eead4" fill="rgba(94, 234, 212, 0.16)" />
              </div>

              <div className="trend-card">
                <div className="trend-meta">
                  <span>Emergency traffic</span>
                  <strong>{recentEmergencyCounts[recentEmergencyCounts.length - 1] || 0}</strong>
                </div>
                <MetricSparkline values={recentEmergencyCounts} stroke="#ff6b6b" fill="rgba(255, 107, 107, 0.16)" />
              </div>
            </div>

            <div className="recent-feed">
              {recentFrames.length ? (
                recentFrames.slice(0, 6).map((frame) => (
                  <div key={frame.emittedIndex} className="feed-row">
                    <span>{frame.timestampLabel}</span>
                    <strong>{frame.metrics.totalVehicles} vehicles</strong>
                    <span>
                      N {frame.metrics.laneDistribution.N} / E {frame.metrics.laneDistribution.E} / S{' '}
                      {frame.metrics.laneDistribution.S} / W {frame.metrics.laneDistribution.W}
                    </span>
                  </div>
                ))
              ) : (
                <div className="feed-empty">No streamed frames yet.</div>
              )}
            </div>
          </article>
        </section>

        <section className="bottom-grid">
          <article className="panel table-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Tracked Vehicles</span>
                <h2>Current frame detail</h2>
              </div>
              <span className="panel-badge">{latestVehicles.length} rows</span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Lane</th>
                    <th>Class</th>
                    <th>Wait</th>
                    <th>Halting</th>
                    <th>Emergency</th>
                  </tr>
                </thead>
                <tbody>
                  {latestVehicles.length ? (
                    latestVehicles.slice(0, 14).map((vehicle) => (
                      <tr key={vehicle.id}>
                        <td>{vehicle.id}</td>
                        <td>{vehicle.lane}</td>
                        <td>{vehicle.className}</td>
                        <td>{formatSeconds(vehicle.waitTimeSec)}</td>
                        <td>{vehicle.isHalting ? 'Yes' : 'No'}</td>
                        <td>{vehicle.isEmergency ? 'Yes' : 'No'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="6" className="empty-row">
                        Start a stream to populate the vehicle table.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="panel json-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Per-second JSON</span>
                <h2>Latest raw vehicle payload</h2>
              </div>
              <span className="panel-badge">{currentFrame?.timestampLabel || 'Idle'}</span>
            </div>

            <pre className="json-viewer">
              {JSON.stringify(currentFrame?.vehicles || [], null, 2)}
            </pre>
          </article>
        </section>
      </main>
    </div>
  );
}

export default App;
