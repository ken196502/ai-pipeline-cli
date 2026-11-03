# Plan: Non-Human Subject & Genre-Adaptive Video Storyboard Re-orchestration

## Problem Statement
When re-orchestrating non-human genres (geography/maps, astronomy/cosmic, microbiology, STEM/physics phenomena), the prompt generator previously forced every topic into a humanoid "Character" framework (`{character1}` with physical height e.g. "0.8m tall red beacon marker").
This resulted in:
1. Turning abstract/geographical/scientific phenomena into miniature physical props/puppets in empty space.
2. Stripping away crucial genre context (such as real historical maps, satellite coordinates, nautical charts, celestial dynamics, molecular mechanisms).
3. Repetitive, purposeless camera movements around a single static prop with no narrative momentum.

## Architectural Improvements
1. **Genre-Adaptive Subject Architecture in `src/research/script/prompts.ts`**:
   - For **Character/Fiction** narratives: retain humanoid/creature `{character1}` and `{background1}` consistency.
   - For **Non-Human / Documentary / STEM / Geographic / Astronomy / Microscopic** narratives:
     - The subject is NOT a character doll. The subject is a **Focus Subject / Phenomenon / Geographic Feature / Cosmic Object / Molecular Mechanism**.
     - Explicitly support specialized non-human paradigms:
       * **Maps & Geography**: Historical charts vs modern satellite overlays, GPS/sonar scans, boundary transformations, territorial evolution, labels & coordinates.
       * **Astronomy & Space**: Gravitational lensing, accretion disks, relativistic jets, tidal disruption, orbital dynamics.
       * **Microbiology & Cellular**: Molecular machinery, receptor binding, membrane dynamics, viral injection, intracellular transport.
       * **STEM & Physics**: Field lines, state transitions, stress concentrations, cascading reactions, phase shifts.
     - Prohibit turning map icons (pins, markers, routes, crosshairs) or celestial bodies into humanoid/character dolls.
2. **Preserve Story & Mystery Lore**:
   - When extracting prompts from mystery/documentary tutorials (e.g. Sandy Island, historical anomalies, scientific paradoxes), preserve the core investigative/narrative facts (dates, locations, instruments, contradictions).
3. **Execution & Verification**:
   - Compile code with `npm run build`.
   - Launch FlowTutor in a named tmux session (`flowTutor-pipeline`).
   - Report the session name and monitoring commands to the user.
