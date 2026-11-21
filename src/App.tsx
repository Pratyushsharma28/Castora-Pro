import { useMemo, useState } from 'react';
import { Check, Copy, ArrowUpRight, Shield, Layers, Network, FileCode2 } from 'lucide-react';
import {
  PLATFORM_STACK,
  PROTOCOL_MESSAGES,
  REPO_FILES,
  ROADMAP_PHASES,
  TOPOLOGIES,
} from './data/castoraBlueprint';

const PHASE_1_CHECKLIST = [
  'Inspected GitHub repository (github.com/Pratyushsharma28/Castora-Pro) and verified Phase 1 baseline files',
  'Created README.md with truthful Implemented / Planned / Tested status ledger',
  'Created .gitignore covering Xcode/macOS, Android/Gradle, keystores, and workspace artifacts',
  'Created docs/PROJECT_ARCHITECTURE.md covering macOS, Android, Android TV, WebRTC, discovery, pairing, security, multi-stream, telemetry, and risks',
  'Created docs/DEVELOPMENT_ROADMAP.md (all 15 phases + dependencies) and docs/TESTING_STRATEGY.md',
];

export default function App() {
  const [selectedTopologyId, setSelectedTopologyId] = useState<'one-to-one' | 'one-to-many' | 'many-to-one'>('one-to-one');
  const [selectedMessageType, setSelectedMessageType] = useState<string>(PROTOCOL_MESSAGES[0].type);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [checkedItems, setCheckedItems] = useState<Record<number, boolean>>({
    0: true,
    1: true,
    2: true,
    3: true,
    4: true,
  });

  // Interactive QR URI Specification Builder (strictly formats the castora:// spec string)
  const [specHostIp, setSpecHostIp] = useState('192.168.1.42');
  const [specPort, setSpecPort] = useState('49152');
  const [specRoom, setSpecRoom] = useState('K7M9P2');
  const [specName, setSpecName] = useState('Living Room TV');

  const activeTopology = useMemo(
    () => TOPOLOGIES.find((t) => t.id === selectedTopologyId) ?? TOPOLOGIES[0],
    [selectedTopologyId]
  );

  const activeMessage = useMemo(
    () => PROTOCOL_MESSAGES.find((m) => m.type === selectedMessageType) ?? PROTOCOL_MESSAGES[0],
    [selectedMessageType]
  );

  const formattedQrUri = useMemo(() => {
    const cleanRoom = specRoom.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'K7M9P2';
    const cleanPort = specPort.replace(/[^0-9]/g, '') || '49152';
    const cleanIp = specHostIp.trim() || '192.168.1.42';
    const encodedName = encodeURIComponent(specName.trim() || 'Castora Pro Receiver');
    return `castora://pair?v=1&ip=${cleanIp}&port=${cleanPort}&room=${cleanRoom}&token=<128bit_ephemeral_token>&name=${encodedName}`;
  }, [specHostIp, specPort, specRoom, specName]);

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1500);
  };

  const toggleChecklist = (index: number) => {
    setCheckedItems((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const completedCount = Object.values(checkedItems).filter(Boolean).length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 zones (wordmark, 4 single-line links, 1 primary CTA) */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="#overview"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            Castora Pro
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a href="#architecture" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Architecture
            </a>
            <a href="#topologies" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Topologies
            </a>
            <a href="#protocol" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Protocol
            </a>
            <a href="#roadmap" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Roadmap
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <a
              href="#checklist"
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Phase 1 Checklist
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-6 py-10 space-y-16">
        {/* Hero / Phase 1 Overview */}
        <section id="overview" className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          <div className="lg:col-span-7 flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500">
                <span>Phase 1</span>
                <span aria-hidden="true">·</span>
                <span>Repository &amp; Architecture Baseline</span>
                <span aria-hidden="true">·</span>
                <span>Protocol castora.v1</span>
              </div>

              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 text-balance">
                Cross-Platform Native Screen Casting Architecture
              </h1>

              <p className="text-base text-slate-600 leading-relaxed max-w-2xl">
                Castora Pro connects native macOS, Android, and Android TV applications over local Wi-Fi or Ethernet using
                Bonjour/NSD discovery, an interoperable JSON WebSocket signaling contract, and DTLS-SRTP WebRTC media
                pipelines targeting up to 1080p at 60 FPS.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-200">
              <div>
                <div className="text-xs text-slate-500">Media Transport</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">WebRTC DTLS-SRTP</div>
                <div className="mt-0.5 text-xs text-slate-500">LAN host ICE first</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Hardware Target</div>
                <div className="mt-1 text-sm font-semibold text-slate-900 tabular-nums">1080p · 60 FPS</div>
                <div className="mt-0.5 text-xs text-slate-500">Adaptive GCC bitrate</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Telemetry Policy</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">Real RTCStats Only</div>
                <div className="mt-0.5 text-xs text-slate-500">Zero synthetic metrics</div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <span className="text-sm font-semibold text-slate-900">Phase 1 Repository Artifacts</span>
                <span className="font-mono text-xs text-slate-500 tabular-nums">{REPO_FILES.length} files</span>
              </div>
              <ul className="divide-y divide-slate-100 mt-2">
                {REPO_FILES.map((file) => (
                  <li key={file.path} className="py-2.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-medium text-slate-900 truncate">{file.path}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{file.role}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(file.path, file.path)}
                      className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
                      aria-label={`Copy path ${file.path}`}
                    >
                      {copiedKey === file.path ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="pt-3 mt-3 border-t border-slate-100 text-xs text-slate-500">
              Official repository: github.com/Pratyushsharma28/Castora-Pro
            </div>
          </div>
        </section>

        {/* Native Platform Stack Comparison */}
        <section id="architecture" className="space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                <span>01. Native Platform Matrix</span>
              </div>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                Shared Contract, Native Media Pipelines
              </h2>
            </div>
            <p className="text-sm text-slate-600 max-w-md">
              Both clients speak identical JSON over local WebSockets while capturing and encoding via native OS hardware frameworks.
            </p>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">Layer</th>
                  <th className="py-3 px-4">macOS (Native)</th>
                  <th className="py-3 px-4">Android &amp; Android TV (Native)</th>
                  <th className="py-3 px-4">Architectural Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {PLATFORM_STACK.map((row) => (
                  <tr key={row.layer} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-slate-900 whitespace-nowrap">{row.layer}</td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-800">{row.macos}</td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-800">{row.android}</td>
                    <td className="py-3.5 px-4 text-slate-600 text-xs leading-relaxed">{row.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Session Topologies */}
        <section id="topologies" className="space-y-5">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <Network className="h-3.5 w-3.5" aria-hidden="true" />
                <span>02. Session Topologies</span>
              </div>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                1:1, 1:N Broadcast, and N:1 Multi-Screen Grid
              </h2>
            </div>

            <div className="inline-flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
              {TOPOLOGIES.map((topology) => {
                const isActive = topology.id === selectedTopologyId;
                return (
                  <button
                    key={topology.id}
                    type="button"
                    onClick={() => setSelectedTopologyId(topology.id)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {topology.id === 'one-to-one'
                      ? '1:1 Direct'
                      : topology.id === 'one-to-many'
                      ? '1:N Multi-Receiver'
                      : 'N:1 Multi-Sender Grid'}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 rounded-xl border border-slate-200 bg-white p-6">
            <div className="lg:col-span-5 space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{activeTopology.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{activeTopology.subtitle}</p>
              </div>

              <div className="space-y-3 pt-2 border-t border-slate-100 text-xs">
                <div>
                  <span className="font-semibold text-slate-900">Capture Strategy: </span>
                  <span className="text-slate-600">{activeTopology.captureStrategy}</span>
                </div>
                <div>
                  <span className="font-semibold text-slate-900">Signaling Flow: </span>
                  <span className="text-slate-600">{activeTopology.signalingFlow}</span>
                </div>
                <div>
                  <span className="font-semibold text-slate-900">Receiver Layout: </span>
                  <span className="text-slate-600">{activeTopology.receiverLayout}</span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-7 border-t lg:border-t-0 lg:border-l border-slate-100 pt-4 lg:pt-0 lg:pl-6">
              <div className="text-xs font-semibold text-slate-500 mb-3">Connection Sequence</div>
              <ol className="space-y-3">
                {activeTopology.steps.map((step, idx) => (
                  <li key={step.detail} className="flex items-start gap-3 text-sm">
                    <span className="font-mono text-xs font-semibold text-blue-600 tabular-nums pt-0.5 shrink-0">
                      0{idx + 1}
                    </span>
                    <div>
                      <span className="font-semibold text-slate-900">{step.actor}: </span>
                      <span className="text-slate-600">{step.detail}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Signaling Protocol & QR URI Spec Explorer */}
        <section id="protocol" className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>03. Signaling Specification</span>
              </div>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                Interoperable castora.v1 Message Catalog &amp; QR URI
              </h2>
            </div>
            <span className="font-mono text-xs text-slate-500">protocol/castora-protocol.schema.json</span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Message Selector + JSON Inspector */}
            <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden flex flex-col">
              <div className="border-b border-slate-200 bg-slate-50/70 px-4 py-3 flex flex-wrap items-center gap-1.5">
                {PROTOCOL_MESSAGES.map((msg) => {
                  const active = msg.type === activeMessage.type;
                  return (
                    <button
                      key={msg.type}
                      type="button"
                      onClick={() => setSelectedMessageType(msg.type)}
                      className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors whitespace-nowrap shrink-0 ${
                        active
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:bg-slate-200/70 hover:text-slate-900'
                      }`}
                    >
                      {msg.type}
                    </button>
                  );
                })}
              </div>

              <div className="p-5 space-y-4 flex-1 flex flex-col justify-between">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-mono text-sm font-semibold text-slate-900">{activeMessage.type}</span>
                    <span className="text-xs font-medium text-slate-500">{activeMessage.direction}</span>
                  </div>
                  <p className="text-sm text-slate-600">{activeMessage.summary}</p>
                  <div className="text-xs text-slate-500">
                    Required payload keys:{' '}
                    <span className="font-mono text-slate-800">{activeMessage.requiredFields.join(', ')}</span>
                  </div>
                </div>

                <div className="relative rounded-lg bg-slate-950 p-4 text-slate-100">
                  <button
                    type="button"
                    onClick={() => handleCopy(`msg-${activeMessage.type}`, activeMessage.exampleJson)}
                    className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 transition-colors"
                  >
                    {copiedKey === `msg-${activeMessage.type}` ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        Copy JSON
                      </>
                    )}
                  </button>
                  <pre className="overflow-x-auto font-mono text-xs leading-relaxed pr-16">
                    <code>{activeMessage.exampleJson}</code>
                  </pre>
                </div>
              </div>
            </div>

            {/* QR Pairing URI Format Builder */}
            <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-4 flex flex-col justify-between">
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <Shield className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>QR &amp; Room-Code URI Format Spec</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Test how a Receiver encodes its LAN address, ephemeral WebSocket port, 6-character room code, and
                  temporary pairing token into a <code className="font-mono text-slate-900">castora://pair</code> URI.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-medium text-slate-700">LAN IP</span>
                    <input
                      type="text"
                      value={specHostIp}
                      onChange={(e) => setSpecHostIp(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-700">WebSocket Port</span>
                    <input
                      type="text"
                      value={specPort}
                      onChange={(e) => setSpecPort(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none tabular-nums"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-700">Room Code (6 chars)</span>
                    <input
                      type="text"
                      maxLength={6}
                      value={specRoom}
                      onChange={(e) => setSpecRoom(e.target.value.toUpperCase())}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 font-mono text-xs uppercase text-slate-900 focus:border-blue-600 focus:outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-700">Receiver Name</span>
                    <input
                      type="text"
                      value={specName}
                      onChange={(e) => setSpecName(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                    />
                  </label>
                </div>
              </div>

              <div className="space-y-2 pt-3 border-t border-slate-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600">Encoded Pairing URI</span>
                  <button
                    type="button"
                    onClick={() => handleCopy('qr-uri', formattedQrUri)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                  >
                    {copiedKey === 'qr-uri' ? 'Copied' : 'Copy URI'}
                  </button>
                </div>
                <div className="rounded-lg bg-slate-100 p-3 font-mono text-xs text-slate-800 break-all">
                  {formattedQrUri}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Phased Roadmap & Phase 1 Verification Checklist */}
        <section id="roadmap" className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-7 space-y-4">
            <div className="border-b border-slate-200 pb-3">
              <div className="text-xs font-medium text-slate-500">04. Engineering Milestones</div>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Phased Roadmap</h2>
            </div>

            <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
              {ROADMAP_PHASES.map((item) => (
                <div key={item.phase} className="p-4 flex items-start gap-4">
                  <div className="font-mono text-xs font-semibold text-slate-500 tabular-nums pt-0.5 shrink-0 w-7">
                    P{item.phase}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
                      <span
                        className={`text-xs font-medium ${
                          item.status === 'Implemented' ? 'text-emerald-700' : 'text-slate-400'
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600 leading-relaxed">{item.goal}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Depends on: {item.dependsOn} · Exit gate: {item.exitGate}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div id="checklist" className="lg:col-span-5 space-y-4">
            <div className="border-b border-slate-200 pb-3 flex items-end justify-between">
              <div>
                <div className="text-xs font-medium text-slate-500">05. Gate Verification</div>
                <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Phase 1 Checklist</h2>
              </div>
              <span className="font-mono text-xs font-medium text-slate-600 tabular-nums">
                {completedCount}/{PHASE_1_CHECKLIST.length}
              </span>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
              {PHASE_1_CHECKLIST.map((label, idx) => {
                const checked = Boolean(checkedItems[idx]);
                return (
                  <label
                    key={label}
                    className="flex items-start gap-3 p-4 cursor-pointer hover:bg-slate-50/70 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleChecklist(idx)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                    />
                    <span className={`text-sm leading-snug ${checked ? 'text-slate-900' : 'text-slate-500'}`}>
                      {label}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white mt-12">
        <div className="mx-auto max-w-[1200px] px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <span>Castora Pro · Phase 1 Architecture &amp; Protocol Specification</span>
          <span>No streaming engine implemented in Phase 1</span>
        </div>
      </footer>
    </div>
  );
}
