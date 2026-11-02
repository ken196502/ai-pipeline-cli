/**
 * Apple & Google Modern Clean Design Language SVG builders.
 * 100% pure English text, responsive viewBox, crisp typography, and airy whitespace.
 * Off-white background (#F8FAFC), Pure White (#FFFFFF), Apple System Blue (#0071E3),
 * Modern Indigo (#4F46E5), Crisp Slate (#0F172A / #334155 / #64748B), Mint (#10B981).
 */

export function buildHeaderBannerSvg(topicTitle: string): string {
  const cleanTitle = topicTitle.replace(/["<>]/g, '').slice(0, 42);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 210" width="100%" height="auto" style="border-radius: 16px; margin: 16px 0; border: 1px solid #E2E8F0; box-shadow: 0 8px 24px -4px rgba(15, 23, 42, 0.06);">
  <defs>
    <linearGradient id="appleHeaderBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="60%" stop-color="#F8FAFC"/>
      <stop offset="100%" stop-color="#F1F5F9"/>
    </linearGradient>
    <linearGradient id="appleBlueGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#0071E3"/>
      <stop offset="100%" stop-color="#4F46E5"/>
    </linearGradient>
    <filter id="softShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#0F172A" flood-opacity="0.04"/>
    </filter>
  </defs>

  <!-- Background Base -->
  <rect width="860" height="210" fill="url(#appleHeaderBg)" rx="16"/>

  <!-- Subtle Ambient Geometric Layers -->
  <circle cx="800" cy="40" r="130" fill="#0071E3" opacity="0.04"/>
  <circle cx="720" cy="170" r="90" fill="#4F46E5" opacity="0.03"/>
  <circle cx="80" cy="20" r="80" fill="#0EA5E9" opacity="0.03"/>

  <!-- Top Pill Badge (Google M3 / Apple HIG Style) -->
  <rect x="44" y="32" width="220" height="26" rx="13" fill="#EEF2FF" stroke="#C7D2FE" stroke-width="1"/>
  <circle cx="56" cy="45" r="4" fill="#4F46E5"/>
  <text x="68" y="49" fill="#4F46E5" font-size="11" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif" letter-spacing="0.6">SYSTEM PARADIGM 2026</text>

  <!-- Main Headline -->
  <text x="44" y="94" fill="#0F172A" font-size="24" font-weight="800" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif" letter-spacing="-0.5">Autonomous Context Architecture</text>
  
  <!-- Subtitle -->
  <text x="44" y="124" fill="#475569" font-size="14" font-weight="500" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif">Self-Prompting Harness · Progressive Eviction · Deterministic State Ledger</text>

  <!-- Divider -->
  <line x1="44" y1="152" x2="816" y2="152" stroke="#E2E8F0" stroke-width="1"/>

  <!-- Footer Tags -->
  <text x="44" y="181" fill="#0071E3" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', monospace" font-weight="600">Focus: ${cleanTitle}</text>
  <text x="816" y="181" fill="#64748B" font-size="12" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" font-weight="500">Google &amp; Apple Clean Engineering Standard</text>
</svg>`;
}

export function buildArchitectureSvg(topicTitle: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 380" width="100%" height="auto" style="border-radius: 16px; margin: 18px 0; border: 1px solid #E2E8F0; box-shadow: 0 10px 28px -6px rgba(15, 23, 42, 0.05);">
  <defs>
    <linearGradient id="archBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#F8FAFC"/>
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#FBFCFD"/>
    </linearGradient>

    <!-- Arrow Markers -->
    <marker id="arrBlue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1 L9 5 L0 9 Z" fill="#0071E3"/>
    </marker>
    <marker id="arrIndigo" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1 L9 5 L0 9 Z" fill="#4F46E5"/>
    </marker>
    <marker id="arrGreen" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1 L9 5 L0 9 Z" fill="#10B981"/>
    </marker>
    <marker id="arrAmber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1 L9 5 L0 9 Z" fill="#F59E0B"/>
    </marker>

    <!-- Card Shadow -->
    <filter id="cardShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0F172A" flood-opacity="0.05"/>
    </filter>
  </defs>

  <!-- Canvas Background -->
  <rect width="860" height="380" fill="url(#archBg)" rx="16"/>

  <!-- Top Category Header -->
  <text x="36" y="40" fill="#0071E3" font-size="11" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" letter-spacing="1.2">ARCHITECTURE BLUEPRINT</text>
  <text x="36" y="66" fill="#0F172A" font-size="18" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">Self-Prompting Agent Topology &amp; Context Bus</text>
  <text x="36" y="86" fill="#64748B" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif">Decoupled Orchestration · Autonomous Eviction · Structured Playbook Sync</text>

  <!-- Node 1: Goal Orchestrator -->
  <rect x="36" y="115" width="168" height="175" rx="14" fill="url(#cardGrad)" stroke="#E2E8F0" stroke-width="1.5" filter="url(#cardShadow)"/>
  <rect x="36" y="115" width="168" height="5" rx="2" fill="#0071E3"/>
  <text x="120" y="146" text-anchor="middle" fill="#0F172A" font-size="14" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Goal Orchestrator</text>
  <text x="120" y="166" text-anchor="middle" fill="#64748B" font-size="11" font-family="-apple-system, monospace">Stateless Dispatch</text>
  <line x1="56" y1="180" x2="184" y2="180" stroke="#F1F5F9" stroke-width="1.5"/>
  <text x="120" y="204" text-anchor="middle" fill="#334155" font-size="11" font-weight="500">High-Level Objective</text>
  <text x="120" y="224" text-anchor="middle" fill="#64748B" font-size="11">Zero Static Prompts</text>
  <rect x="52" y="244" width="136" height="24" rx="12" fill="#EFF6FF" stroke="#BFDBFE" stroke-width="1"/>
  <text x="120" y="260" text-anchor="middle" fill="#0071E3" font-size="10" font-weight="700">STAGE 1: DISPATCH</text>

  <!-- Connection 1 -> 2 -->
  <line x1="204" y1="202" x2="238" y2="202" stroke="#0071E3" stroke-width="2" marker-end="url(#arrBlue)"/>

  <!-- Node 2: Dynamic Agent Harness -->
  <rect x="244" y="105" width="206" height="195" rx="14" fill="url(#cardGrad)" stroke="#C7D2FE" stroke-width="1.5" filter="url(#cardShadow)"/>
  <rect x="244" y="105" width="206" height="5" rx="2" fill="#4F46E5"/>
  <text x="347" y="138" text-anchor="middle" fill="#0F172A" font-size="14" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Active Context Window</text>
  <text x="347" y="158" text-anchor="middle" fill="#4F46E5" font-size="11" font-family="-apple-system, monospace">Self-Prompting Loop</text>
  <line x1="264" y1="172" x2="430" y2="172" stroke="#F1F5F9" stroke-width="1.5"/>
  <text x="347" y="196" text-anchor="middle" fill="#334155" font-size="11" font-weight="500">Generator ⇆ Reflector</text>
  <text x="347" y="216" text-anchor="middle" fill="#64748B" font-size="11">Tool Execution &amp; Feedback</text>
  <rect x="264" y="238" width="166" height="30" rx="15" fill="#EEF2FF" stroke="#C7D2FE" stroke-width="1"/>
  <text x="347" y="258" text-anchor="middle" fill="#4F46E5" font-size="11" font-weight="700" font-family="-apple-system, monospace">Tokens &lt; 100k Optimal</text>

  <!-- Connection 2 -> 3 -->
  <line x1="450" y1="202" x2="484" y2="202" stroke="#4F46E5" stroke-width="2" marker-end="url(#arrIndigo)"/>

  <!-- Node 3: Context Eviction Gate -->
  <rect x="490" y="105" width="194" height="195" rx="14" fill="url(#cardGrad)" stroke="#BAE6FD" stroke-width="1.5" filter="url(#cardShadow)"/>
  <rect x="490" y="105" width="194" height="5" rx="2" fill="#0284C7"/>
  <text x="587" y="138" text-anchor="middle" fill="#0F172A" font-size="14" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Context Eviction Gate</text>
  <text x="587" y="158" text-anchor="middle" fill="#0284C7" font-size="11" font-family="-apple-system, monospace">ACE / Curated Policy</text>
  <line x1="510" y1="172" x2="664" y2="172" stroke="#F1F5F9" stroke-width="1.5"/>
  <text x="587" y="196" text-anchor="middle" fill="#0284C7" font-size="11" font-weight="600">1. Prune Tool Noise</text>
  <text x="587" y="218" text-anchor="middle" fill="#059669" font-size="11" font-weight="600">2. Delta Playbook Compact</text>
  <text x="587" y="240" text-anchor="middle" fill="#4F46E5" font-size="11" font-weight="600">3. Clean Slate Workbrief</text>
  <rect x="522" y="255" width="130" height="22" rx="11" fill="#F0FDF4" stroke="#BBF7D0" stroke-width="1"/>
  <text x="587" y="270" text-anchor="middle" fill="#059669" font-size="10" font-weight="700">COMPACTION ACTIVE</text>

  <!-- Connection 3 -> 4 -->
  <line x1="684" y1="202" x2="718" y2="202" stroke="#10B981" stroke-width="2" marker-end="url(#arrGreen)"/>

  <!-- Node 4: External State Ledger -->
  <rect x="724" y="115" width="112" height="175" rx="14" fill="url(#cardGrad)" stroke="#BBF7D0" stroke-width="1.5" filter="url(#cardShadow)"/>
  <rect x="724" y="115" width="112" height="5" rx="2" fill="#10B981"/>
  <text x="780" y="146" text-anchor="middle" fill="#0F172A" font-size="14" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">State Bus</text>
  <text x="780" y="166" text-anchor="middle" fill="#059669" font-size="11" font-family="-apple-system, monospace">Persistent OS</text>
  <line x1="738" y1="180" x2="822" y2="180" stroke="#F1F5F9" stroke-width="1.5"/>
  <text x="780" y="204" text-anchor="middle" fill="#334155" font-size="11">NOTES.md</text>
  <text x="780" y="224" text-anchor="middle" fill="#334155" font-size="11">Git Diffs</text>
  <rect x="734" y="244" width="92" height="24" rx="12" fill="#ECFDF5" stroke="#A7F3D0" stroke-width="1"/>
  <text x="780" y="260" text-anchor="middle" fill="#059669" font-size="10" font-weight="700">TRUTH LEDGER</text>

  <!-- Feedback Loop Underneath -->
  <path d="M 587 300 L 587 334 L 347 334 L 347 306" fill="none" stroke="#F59E0B" stroke-width="1.8" stroke-dasharray="5,4" marker-end="url(#arrAmber)"/>
  <rect x="382" y="322" width="170" height="22" rx="11" fill="#FFFBEB" stroke="#FDE68A" stroke-width="1"/>
  <text x="467" y="337" text-anchor="middle" fill="#D97706" font-size="10" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Self-Healing Feedback Loop</text>
</svg>`;
}

export function buildSequenceSvg(topicTitle: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 380" width="100%" height="auto" style="border-radius: 16px; margin: 18px 0; border: 1px solid #E2E8F0; box-shadow: 0 10px 28px -6px rgba(15, 23, 42, 0.05);">
  <defs>
    <linearGradient id="seqCanvasBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#F8FAFC"/>
    </linearGradient>

    <!-- Sequence Flow Markers -->
    <marker id="sqBlue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1 L9 5 L0 9 Z" fill="#0071E3"/>
    </marker>
    <marker id="sqIndigo" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1 L9 5 L0 9 Z" fill="#4F46E5"/>
    </marker>
    <marker id="sqSky" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1 L9 5 L0 9 Z" fill="#0284C7"/>
    </marker>
    <marker id="sqGreen" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1 L9 5 L0 9 Z" fill="#10B981"/>
    </marker>

    <filter id="pillShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0F172A" flood-opacity="0.04"/>
    </filter>
  </defs>

  <!-- Background Base -->
  <rect width="860" height="380" fill="url(#seqCanvasBg)" rx="16"/>

  <!-- Title & Subtitle -->
  <text x="36" y="40" fill="#4F46E5" font-size="11" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" letter-spacing="1.2">INTERACTION TIMELINE</text>
  <text x="36" y="66" fill="#0F172A" font-size="18" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">Progressive Context Reset &amp; Harness Protocol</text>
  <text x="36" y="86" fill="#64748B" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif">Execution Lifecycle: Lossless Pruning → Structured Compaction → Slate Reset</text>

  <!-- Lifeline Columns -->
  <!-- Col 1 -->
  <line x1="120" y1="128" x2="120" y2="340" stroke="#E2E8F0" stroke-width="1.5" stroke-dasharray="4,4"/>
  <rect x="42" y="98" width="156" height="34" rx="17" fill="#FFFFFF" stroke="#BFDBFE" stroke-width="1.2" filter="url(#pillShadow)"/>
  <text x="120" y="120" text-anchor="middle" fill="#0071E3" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Goal Orchestrator</text>

  <!-- Col 2 -->
  <line x1="360" y1="128" x2="360" y2="340" stroke="#E2E8F0" stroke-width="1.5" stroke-dasharray="4,4"/>
  <rect x="272" y="98" width="176" height="34" rx="17" fill="#FFFFFF" stroke="#C7D2FE" stroke-width="1.2" filter="url(#pillShadow)"/>
  <text x="360" y="120" text-anchor="middle" fill="#4F46E5" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Agent Working Context</text>

  <!-- Col 3 -->
  <line x1="600" y1="128" x2="600" y2="340" stroke="#E2E8F0" stroke-width="1.5" stroke-dasharray="4,4"/>
  <rect x="512" y="98" width="176" height="34" rx="17" fill="#FFFFFF" stroke="#BAE6FD" stroke-width="1.2" filter="url(#pillShadow)"/>
  <text x="600" y="120" text-anchor="middle" fill="#0284C7" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Compaction &amp; Memory</text>

  <!-- Col 4 -->
  <line x1="770" y1="128" x2="770" y2="340" stroke="#E2E8F0" stroke-width="1.5" stroke-dasharray="4,4"/>
  <rect x="698" y="98" width="144" height="34" rx="17" fill="#FFFFFF" stroke="#BBF7D0" stroke-width="1.2" filter="url(#pillShadow)"/>
  <text x="770" y="120" text-anchor="middle" fill="#059669" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Disk State Ledger</text>

  <!-- Step 1: Dispatch -->
  <line x1="120" y1="156" x2="352" y2="156" stroke="#0071E3" stroke-width="1.8" marker-end="url(#sqBlue)"/>
  <rect x="180" y="142" width="112" height="20" rx="10" fill="#EFF6FF"/>
  <text x="236" y="156" text-anchor="middle" fill="#0071E3" font-size="10" font-weight="600">1. Dispatch task objective</text>

  <!-- Step 2: Self Loop -->
  <path d="M 360 172 Q 412 184 360 196" fill="none" stroke="#4F46E5" stroke-width="1.6"/>
  <text x="424" y="188" fill="#4F46E5" font-size="11" font-family="-apple-system, monospace" font-weight="600">2. Self-prompt &amp; tool loop</text>

  <!-- Step 3: Trigger compaction -->
  <line x1="360" y1="222" x2="592" y2="222" stroke="#0284C7" stroke-width="1.8" marker-end="url(#sqSky)"/>
  <rect x="410" y="208" width="140" height="20" rx="10" fill="#F0F9FF"/>
  <text x="480" y="222" text-anchor="middle" fill="#0284C7" font-size="10" font-weight="600">3. Trigger compaction (&gt;100k)</text>

  <!-- Step 4: Persist delta -->
  <line x1="600" y1="258" x2="762" y2="258" stroke="#10B981" stroke-width="1.8" marker-end="url(#sqGreen)"/>
  <rect x="635" y="244" width="94" height="20" rx="10" fill="#ECFDF5"/>
  <text x="682" y="258" text-anchor="middle" fill="#059669" font-size="10" font-weight="700">4. Persist delta diffs</text>

  <!-- Step 5: Clean re-inject -->
  <line x1="770" y1="292" x2="368" y2="292" stroke="#4F46E5" stroke-width="1.8" marker-end="url(#sqIndigo)"/>
  <rect x="495" y="278" width="145" height="20" rx="10" fill="#EEF2FF"/>
  <text x="567" y="292" text-anchor="middle" fill="#4F46E5" font-size="10" font-weight="600">5. Clean reset + task brief</text>

  <!-- Step 6: Success summary -->
  <line x1="360" y1="326" x2="128" y2="326" stroke="#10B981" stroke-width="1.8" marker-end="url(#sqGreen)"/>
  <rect x="180" y="312" width="120" height="20" rx="10" fill="#ECFDF5"/>
  <text x="240" y="326" text-anchor="middle" fill="#059669" font-size="10" font-weight="700">6. Return crisp artifact</text>
</svg>`;
}
