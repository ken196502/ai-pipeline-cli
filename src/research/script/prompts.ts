/**
 * Generative AI Video Prompt Engineering Engine.
 *
 * Implements the universal generative video prompt formula:
 * [Framing & Shot Type] + [Subject & Concrete Action] + [Environment & Depth] + [Lighting & Atmosphere] + [Artistic Style & Aesthetic] + [Camera Movement]
 *
 * Designed to be model-agnostic and style-agnostic:
 * - Adapts dynamically to any target generative video model (Veo, Sora, Kling, Runway, etc.)
 * - Dynamically extracts and synthesizes artistic styles directly from video context
 *   (including line-art, dark fantasy, 3D motion graphics, anime, claymation, etc.)
 *   without rigid, hardcoded genre presets.
 */

import type { VlExtractedPrompt } from '../contracts.js';

export interface DynamicVisualAesthetic {
  styleAesthetic: string;
  environmentLighting: string;
  cameraMovement: string;
  imagePrompt: string;
  endImagePrompt: string;
  visualPrompt: string;
}

/**
 * Dynamically analyzes context text (title, topic, narration, description) to extract
 * artistic medium, lighting tone, and camera dynamics without rigid hardcoded enums.
 */
export function extractDynamicVisualAesthetic(
  topic: string,
  sceneTitle: string,
  narration?: string,
  contextText?: string,
  visualStyle?: string
): DynamicVisualAesthetic {
  const cleanTitle = sanitizePromptForSafetyPolicy(sceneTitle.replace(/[^a-zA-Z0-9\s,-]/g, '').trim());
  const cleanTopic = sanitizePromptForSafetyPolicy(topic.replace(/[^a-zA-Z0-9\s,-]/g, '').trim());
  const cleanNarration = narration
    ? sanitizePromptForSafetyPolicy(
        narration
          .slice(0, 120)
          .replace(/[^a-zA-Z0-9\s,-]/g, '')
          .trim()
      )
    : '';

  const subjectOrAction = cleanNarration || cleanTitle || cleanTopic;
  const combined = `${visualStyle || ''} ${contextText || ''} ${cleanTopic} ${cleanTitle} ${cleanNarration}`.toLowerCase();

  // 1. Dynamic Art Medium & Aesthetic Detection
  let styleAesthetic = 'cinematic photorealistic 35mm lens, high-fidelity visual storytelling, cohesive filmic color grading';
  let environmentLighting = 'natural ambient lighting with cinematic depth of field and soft shadows';
  let cameraMovement = 'slow smooth tracking dolly-in camera movement';
  let mediumDescriptor = 'Cinematic eye-level medium shot';

  const styleCat = classifyStyleCategory(visualStyle);

  if (/\b(stickman|stick figure|stick fight|stick animation|alan becker|pivot|火柴人)\b/i.test(combined)) {
    styleAesthetic = 'minimalist fluid 2D stickman line art animation, high-octane kinetic martial arts choreography, crisp black silhouettes';
    environmentLighting = 'stark high-contrast clean minimalist backdrop illuminated by vibrant glowing neon kinetic energy trails';
    cameraMovement = 'rapid whip pan, dynamic impact zoom, and high-speed lateral tracking camera motion';
    mediumDescriptor = 'Minimalist dynamic 2D stickman animation';
  } else if (/\b(skeleton|skellie|skulls?|undead|bones?|grim reaper|necromancer|crypt|dungeon|gothic|骷髅|白骨)\b/i.test(combined)) {
    styleAesthetic = 'stylized dark fantasy 3D gothic animation, tactile weathered bone textures, whimsical macabre aesthetic';
    environmentLighting = 'atmospheric ancient gothic stone crypt, eerie emerald and violet volumetric fog, flickering amber torch sconces';
    cameraMovement = 'slow creeping low-angle orbital tracking shot with dramatic Dutch angle tilt';
    mediumDescriptor = 'Stylized dark fantasy animated skeleton';
  } else if (/\b(3d document|documentary|archival|parchment|manuscripts?|historical maps?|vintage photos?|declassified|dossier|档案|历史文献)\b/i.test(combined)) {
    styleAesthetic = 'high-end 3D motion graphics documentary style, macro lens with shallow depth of field, authentic vintage paper grain textures';
    environmentLighting = 'dark mahogany investigative desk, warm directional tungsten desk lamp illumination with dramatic chiaroscuro and floating dust motes';
    cameraMovement = 'slow drifting cinematic macro parallax sweep across textured documents';
    mediumDescriptor = 'Cinematic 3D archival document animation';
  } else if (/\b(anime|ghibli|manga|cel-shaded|makoto shinkai|动漫|吉卜力)\b/i.test(combined)) {
    styleAesthetic = 'high-fidelity Japanese anime aesthetic, vibrant painted watercolor backgrounds, clean cel-shaded character design';
    environmentLighting = 'lush hand-painted natural landscape, soft golden hour sunbeams with atmospheric bloom and glowing particles';
    cameraMovement = 'smooth cinematic anime camera pan with gentle depth parallax';
    mediumDescriptor = 'Vibrant Japanese anime aesthetic';
  } else if (styleCat === 'claymation' || /\b(claymation|plasticine|stop-motion|stop motion|clay animation|粘土|定格)\b/i.test(combined)) {
    styleAesthetic = 'tactile handcrafted plasticine claymation stop-motion, visible surface fingerprints and miniature physical textures';
    environmentLighting = 'miniature physical tabletop studio lighting with warm soft shadows and physical lamp reflections';
    cameraMovement = 'tactile macro miniature dolly-in with shallow depth of field';
    mediumDescriptor = 'Tactile plasticine claymation stop-motion aesthetic';
  } else if (styleCat === 'animation-2d' || /\b(2d cartoon|cartoon animation|2d animation|卡通动画|卡通)\b/i.test(combined)) {
    styleAesthetic = 'vibrant stylized 2D cartoon animation style, expressive hand-drawn cel-shaded character design, clean art lines, whimsical and friendly aesthetic';
    environmentLighting = 'bright cheerful cartoon lighting, vibrant saturated color palette with warm soft highlights';
    cameraMovement = 'smooth dynamic 2D animation tracking pan with lively character animation';
    mediumDescriptor = 'Stylized 2D cartoon animation';
  } else if (styleCat === 'animation-3d' || /\b(3d cartoon|3d animation|blender animation|pixar|stylized 3d|low-poly|3d动画)\b/i.test(combined)) {
    styleAesthetic = 'premium stylized 3D character animation, expressive character acting, clean artistic shapes, vibrant cartoon palette';
    environmentLighting = 'vibrant whimsical stylized world, colorful three-point studio lighting with saturated rim lights';
    cameraMovement = 'dynamic smooth orbital camera movement with expressive framing';
    mediumDescriptor = 'Stylized 3D character animation';
  } else if (styleCat === 'phone-shot' || /\b(phone|ugc|smartphone|vlog|手机拍摄|手机)\b/i.test(combined)) {
    styleAesthetic = 'authentic smartphone camera POV video style, natural mobile lens perspective, unpolished UGC handheld aesthetic';
    environmentLighting = 'natural realistic indoor/outdoor ambient mobile lighting with subtle lens flare';
    cameraMovement = 'organic subtle handheld camera drift and authentic slight movement';
    mediumDescriptor = 'Handheld smartphone camera POV';
  } else if (/\b(cyberpunk|synthwave|neon noir|sci-fi|futuristic)\b/i.test(combined)) {
    styleAesthetic = 'futuristic cyberpunk neon aesthetic, rain-slicked surfaces with chromatic reflections, anamorphic lens flare';
    environmentLighting = 'moody midnight ambience with vibrant blue and magenta neon rim lighting and wet reflective asphalt';
    cameraMovement = 'low-angle slow tracking glide with smooth anamorphic pan';
    mediumDescriptor = 'Cinematic cyberpunk visual scene';
  } else if (/\b(politics|political|president|election|news anchor|broadcast news|white house|congress|senate|breaking news)\b/i.test(combined)) {
    styleAesthetic = 'cinematic investigative documentary aesthetic, high-contrast dramatic lighting, anamorphic 35mm lens, atmospheric depth';
    environmentLighting = 'moody broadcast newsroom and architectural interiors, high-contrast rim lighting, cool blue and warm tungsten accents with soft atmospheric haze';
    cameraMovement = 'slow cinematic over-the-shoulder tracking shot or dramatic dolly across broadcast monitors and documents';
    mediumDescriptor = 'Cinematic over-the-shoulder or atmospheric silhouette composition';
  } else if (styleCat === 'cinematic' || /\b(35mm|photorealistic|live-action|film|cinema|电影)\b/i.test(combined)) {
    styleAesthetic = 'cinematic photorealistic 35mm lens, high-fidelity visual storytelling, cohesive filmic color grading';
    environmentLighting = 'natural ambient lighting with cinematic depth of field and soft shadows';
    cameraMovement = 'slow smooth tracking dolly-in camera movement';
    mediumDescriptor = 'Cinematic eye-level medium shot';
  } else if (styleCat === 'realistic' || /\b(realistic|documentary|写实|纪录片)\b/i.test(combined)) {
    styleAesthetic = 'natural documentary style, neutral realistic lighting, authentic observational framing';
    environmentLighting = 'natural ambient daylight';
    cameraMovement = 'steady observational pan';
    mediumDescriptor = 'Documentary medium shot';
  }

  // Synthesize prompts using dual/triple-prompt workflow:
  // imagePrompt: Static keyframe (no motion) — [Framing/Shot] + [Subject Pose] + [Environment] + [Lighting] + [Style] (Start frame)
  // endImagePrompt: Ending static keyframe — [Framing/Shot] + [Subject Concluded Pose] + [Environment] + [Lighting] + [Style] (End frame)
  // visualPrompt: Animation motion — [Camera Motion] + [Subject Action] + [Environmental Dynamics] + [Temporal Effects]
  // Note: Avoid baking spoken dialogue/narration quotes directly into image prompts, as diffusion models
  // render spoken English words as typography/lettering artifacts across the frame.
  const visualContext = cleanTitle || cleanTopic;
  const imagePrompt = `${mediumDescriptor} depicting ${visualContext}. Natural character posture and environment before action begins. ${environmentLighting}. ${styleAesthetic}.`;

  const endImagePrompt = `${mediumDescriptor} depicting conclusion of ${visualContext}. Subject settled in final posture with ambient atmosphere. ${environmentLighting}. ${styleAesthetic}.`;

  const visualPrompt = `${cameraMovement}. Dynamic cinematic motion and physical action progressing across scene. Environmental particles and lighting shifts throughout the scene.`;

  return {
    styleAesthetic,
    environmentLighting,
    cameraMovement,
    imagePrompt,
    endImagePrompt,
    visualPrompt,
  };
}

/**
 * Strips motion and camera movements from a video prompt to derive
 * a clean, static starting keyframe description (imagePrompt) when the original
 * candidate video lacks image prompts.
 */
export function deriveKeyframeFromVideoPrompt(
  videoPrompt: string,
  styleAesthetic?: string,
  environmentLighting?: string
): string {
  if (!videoPrompt || !videoPrompt.trim()) {
    return styleAesthetic ? `Static keyframe scene composition. ${styleAesthetic}` : 'Static keyframe scene composition.';
  }

  // Remove camera movement directives while preserving subject poses and action postures
  let staticScene = videoPrompt
    .replace(/\b(slow|fast|smooth|rapid|dynamic|cinematic)?\s*(tracking|panning|pan|dolly-in|dolly-out|dolly|zoom-in|zoom-out|zoom|whip pan|orbital|orbit|tilt|roll|glide|sweep|tilt-up|tilt-down)\s*(camera movement|camera motion|shot|sweep|drift)?\b/gi, '')
    .replace(/\b(camera (moves|pans|zooms|dollies|tracks|sweeps|glides|rotates|follows))\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,\s.-]+/, '')
    .trim();

  if (!staticScene) {
    staticScene = 'Scene framing and character subject pose';
  }

  const basePrompt = `Static keyframe composition capturing ${staticScene}.`;
  const env = environmentLighting ? ` ${environmentLighting}.` : '';
  const style = styleAesthetic ? ` ${styleAesthetic}.` : '';

  return `${basePrompt}${env}${style}`.replace(/\.{2,}/g, '.').trim();
}

/**
 * Formats all OCR-extracted source prompts from the candidate video for injection
 * into LLM context, detailing promptType, UI/tool context, confidence, and settings.
 */
export function formatSourcePromptsForLlm(vlPrompts?: VlExtractedPrompt[]): string {
  if (!vlPrompts || vlPrompts.length === 0) {
    return 'No source AI generation prompts were extracted from the candidate video.';
  }

  return vlPrompts
    .map((p, idx) => {
      const settings = p.settings && p.settings.length > 0 ? ` | Settings: [${p.settings.join(', ')}]` : '';
      const narrationText = p.narration && p.narration.trim() ? `\nNarration/Voiceover Script (旁白稿): "${p.narration.trim()}"` : '';
      return `[Source Prompt #${idx + 1}] Type: ${p.promptType.toUpperCase()} | Tool/UI: "${p.uiContext}" | Confidence: ${(p.confidence * 100).toFixed(0)}%${settings}\nContent: "${p.prompt}"${narrationText}`;
    })
    .join('\n\n');
}

/**
 * MANDATORY shot transition annotation (切分镜 / 连续) for every generated clip.
 * The LLM must decide the transition relative to the previous clip, write BOTH prompts
 * accordingly, and always leave a 备注 (transitionNote) explaining the decision.
 *
 * The "continuous" semantics below mirror the generation pipeline exactly
 * (src/flow/clip-plan.ts): a continuous clip generates NO new image — the ACTUAL
 * LAST VIDEO FRAME of the previous clip is uploaded as this clip's starting frame.
 */
/**
 * Shot transition guidelines deprecated from LLM prompts.
 * Physical shot transition is handled internally by the pipeline.
 * Retained as empty string for backward compatibility.
 */
export const SHOT_TRANSITION_GUIDELINES = '';

/**
 * Guidelines for avoiding Google Flow / Veo "prominent people" policy violations.
 * Mandates using approximate actions, indirect framing (OTS, silhouettes, back views),
 * and equipment/document metaphors instead of direct frontal realistic talking heads.
 */
export const POLICY_AVOIDANCE_GUIDELINES = `
## STRICT POLICY AVOIDANCE: PROMINENT PEOPLE & APPROXIMATE ACTION EVASION (规避知名公众人物策略拦截)

Google Flow / Veo strictly bans generating recognizable real prominent people (politicians, presidents, celebrities, public figures, news anchors) and triggers fatal policy errors ("policies about generating prominent people").

To ensure successful generation, apply the following evasion techniques to both imagePrompt and visualPrompt:

1. ABSOLUTELY ZERO NAMES OF REAL PROMINENT FIGURES:
   - NEVER use the names of real-world politicians, presidents, celebrities, or tech leaders (e.g., Trump, Biden, Obama, Harris, Musk, etc.).
   - NEVER use identifiable personal caricature traits (e.g., "long red tie with swept blond hair", "orange tan").
   - If the source prompts or reference video mention any real prominent people, transform them into generic fictional roles ("an anonymous speaker", "a government delegate", "an investigative analyst").

2. USE APPROXIMATE ACTIONS & OBJECT/EQUIPMENT METAPHORS (近似动作与物件细节隐喻):
   Instead of direct frontal close-ups of an anchor or politician speaking into the lens, focus on concrete approximate actions and high-tension physical props:
   - **Hands & Document Actions**: Extreme close-up of hands shuffling classified dossiers, hands turning an analog audio dial on a mixing console, a fountain pen signing an official document, fingers tapping on an encrypted keyboard.
   - **Broadcasting & Tech Equipment**: Close-up of a vintage studio broadcast microphone with a glowing red "ON AIR" indicator, bouncing needle on an analog VU meter, teleprompter green text scrolling reflected across glass, studio camera lens racking focus.
   - **Environmental Tension**: Slow dolly across rows of dark newsroom computer monitors displaying flashing breaking headlines, red warning beacons spinning silently in corridors, spotlight illuminating an empty podium or shadow.

3. USE INDIRECT HUMAN FRAMING (间接镜头构图：背影、剪影、过肩镜头):
   If a human presence is required by the scene narrative, NEVER frame them in direct, well-lit frontal close-ups facing the camera. Use indirect cinematic angles:
   - **Back Views (背影)**: Position camera behind the speaker, framing dark suited shoulders from behind as they address a vast auditorium or look toward glowing spotlights.
   - **Deep Silhouettes & Rim Lighting (深剪影/轮廓光)**: High-contrast silhouette of a figure against backlit blinds or foggy window, facial features fully shrouded in shadow.
   - **Over-the-Shoulder (OTS / 过肩镜头)**: Over-the-shoulder shot looking past a shadowed silhouette toward a glowing digital wall map or broadcast monitor.
   - **Wide Environmental Shots (大远景)**: Distant wide establishing shots where human figures are tiny, unidentifiable distant silhouettes.
`;

/**
 * Guidelines for avoiding Google Flow / Veo / Imagen content-policy violations beyond
 * "prominent people": graphic violence, gore, horror/disturbing entities, death/self-harm,
 * sexual content, hate, minors-in-danger, copyrighted characters, and real tragedies.
 *
 * Google Flow returns a fatal "warningFailed This generation might violate our policies"
 * (no charge) when any of these appear, which aborts the whole pipeline run. The rules below
 * force suspense/emotion to be expressed through cinematic craft rather than forbidden content.
 */
export const CONTENT_SAFETY_GUIDELINES = `
## STRICT CONTENT-SAFETY POLICY AVOIDANCE (规避内容安全条例拦截)

Google Flow / Veo / Imagen run aggressive safety filters. If a prompt touches the categories below,
the model returns a fatal policy error ("This generation might violate our policies") and the clip
is rejected (no charge), aborting the whole run. NEVER request the following content in imagePrompt,
endImagePrompt, or visualPrompt:

1. GRAPHIC VIOLENCE, GORE & INJURY (血腥暴力与伤害):
   - FORBIDDEN: blood, blood spatter, gore, gory wounds, open injuries, mutilation, dismemberment,
     torture, beatings, executions, corpses, dead bodies, mass casualties, war atrocities.
   - FORBIDDEN props/actions: weapons aimed at people (guns, pistols, rifles, knives, blades),
     shooting, stabbing, slashing, strangling, punching that draws blood, explosions harming people.

2. HORROR & DISTURBING IMAGERY (恐怖与惊悚画面):
   - FORBIDDEN: horror genre framing, jumpscares, ghosts, demons, monsters, zombies, undead,
     possessions, exorcisms, haunted settings, creepy/disturbing atmosphere, screaming in terror.
   - FORBIDDEN composition: a threatening/ambiguous figure lurking, looming, standing, or emerging
     DIRECTLY BEHIND or approaching a person (triggers stalking / harassment / simulated-violence
     filters). Never place an unexplained pale shape, shadow-figure, or entity behind a subject.
   - FORBIDDEN emotion vocabulary: terror, terrified, horrified, panicked screaming, nightmare.
     Express unease only through lighting, grain, and guarded body language (see Safe Rewrites).

3. DEATH & SELF-HARM (死亡与自残):
   - FORBIDDEN: death scenes, dying, corpses, funerals of graphic nature, suicide, self-harm,
     cutting, hanging, overdose, medication misuse.

4. SEXUAL & NUDITY CONTENT (色情与裸露):
   - FORBIDDEN: nudity, semi-nudity, exposed bodies, sexual acts, fetish content, lingerie framing,
     suggestive poses or camera emphasis on intimate body areas. Characters must be tastefully,
     fully clothed in every prompt.

5. MINORS (未成年人保护):
   - FORBIDDEN: children/minors in danger, distress, sexualized, or violent contexts.
   - If children appear at all, they must be fully clothed, safe, and in innocent, non-threatening scenes.

6. HATE, HARASSMENT & DISCRIMINATION (仇恨与骚扰):
   - FORBIDDEN: slurs, hate symbols (swastikas, KKK imagery), discriminatory caricatures, bullying,
     humiliation, degradation of any person or group, targeted harassment.

7. COPYRIGHT & TRADEMARK (版权与商标):
   - FORBIDDEN: recognizable copyrighted characters (Disney, Marvel, Pixar, Pokémon, Star Wars,
     Nintendo, etc.), celebrity likenesses, brand logos, trademarked mascots. Use original designs only.

8. REAL-WORLD TRAGEDIES & ILLEGAL ACTIVITY (真实灾难与违法内容):
   - FORBIDDEN: real terrorist attacks, mass shootings, plane crashes, natural-disaster casualty scenes,
     riots with violence, drug manufacturing/use, smoking, heavy alcohol abuse, criminal instruction.

SAFE REWRITE STRATEGY (安全改写策略) — keep the story beat, remove the trigger:
- SUSPENSE VIA CRAFT, NOT CONTENT: Replace horror/threat with cinematic tension — dim ambient
  lighting, shallow depth of field, slow push-in, drifting haze, muted color grade, tense stillness.
- NEUTRAL POSE VOCABULARY: Instead of "terror/terrified/screaming", use "wide-eyed with concern",
  "guarded expression", "holding his breath", "tense posture", "wary glance".
- NO ENTITY BEHIND THE SUBJECT: Keep the background empty, soft-focus, or atmospherically hazy.
  Never imply a pursuer, ghost, or unseen threat directly behind/approaching a person.
- TECHNICAL FILM LANGUAGE: Describe the medium (analog camcorder texture, handheld drift, VHS grain,
  low-light ambient grade) rather than the frightening narrative intent.
- FAMILY-SAFE / PG FRAMING: Everything must be suitable for a general audience. When in doubt, choose
  the calmer, more neutral, less graphic description.
`;

/**
 * Sanitizes prompts to prevent Google Flow / Veo content-policy violations.
 * 1. Replaces known prominent public figures with safe generic archetypes.
 * 2. Replaces direct frontal close-ups of anchors/politicians speaking with indirect OTS/silhouette framing and approximate actions.
 * 3. Rewrites graphic-violence / gore / horror / disturbing-entity / death / sexual content into
 *    neutral cinematic equivalents (final safety net in case the LLM ignored the guidelines).
 */
export function sanitizePromptForSafetyPolicy(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') return prompt;

  let cleaned = prompt;

  // 1. Replace specific prominent political & celebrity names with generic fictional roles
  const prominentReplacements: Array<[RegExp, string]> = [
    [/\b(donald\s+trump|donald\s+j\.?\s+trump|trump(?!\s+card))\b/gi, 'a political speaker'],
    [/\b(joe\s+biden|joseph\s+biden|biden)\b/gi, 'a government official'],
    [/\b(barack\s+obama|obama)\b/gi, 'a senior statesman'],
    [/\b(kamala\s+harris|harris)\b/gi, 'a high-ranking official'],
    [/\b(elon\s+musk|musk(?!\s+(scent|deer|oil|perfume|ox|melon)))\b/gi, 'a tech executive'],
    [/\b(vladimir\s+putin|putin)\b/gi, 'a foreign dignitary'],
    [/\b(xi\s+jinping)\b/gi, 'a state official'],
    [/\bpresident\s+(trump|biden|obama)\b/gi, 'the president figure'],
  ];

  for (const [pattern, replacement] of prominentReplacements) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  // 2. Soften direct frontal anchor/politician close-up phrasing into indirect or approximate framing
  cleaned = cleaned
    .replace(
      /\b(close-up|medium close-up|extreme close-up)\s+of\s+a\s+(serious|dramatic|intense)?\s*(news\s+anchor|news\s+broadcaster|political\s+figure|politician)\b/gi,
      'Cinematic over-the-shoulder shot of a suited news broadcaster'
    )
    .replace(
      /\b(anchor|politician|speaker)\s+(?:as\s+(?:he|she|they)\s+)?(leans\s+forward\s+and\s+speaks\s+with\s+urgency|speaks\s+with\s+urgency|speaks\s+directly\s+to\s+(?:the\s+)?camera)\b/gi,
      'broadcaster gestures emphatically toward papers and glowing broadcast monitors'
    )
    .replace(
      /\bpolitical\s+figure\s+in\s+dark\s+navy\s+suit\s+with\s+long\s+red\s+tie\b/gi,
      'silhouette of a commanding suited figure viewed from behind'
    );

  // 3. Strip / soften graphic-violence, gore, horror, disturbing-entity, death and sexual content.
  //    Order matters: specific multi-word constructions are rewritten before generic tokens.
  const disturbingReplacements: Array<[RegExp, string]> = [
    // --- Exact high-risk constructions (must run before generic token rules) ---
    [/\bthe\s+phone\s+screen\s+nearly\s+black\b/gi, 'the phone screen glowing faintly'],
    [/\bface\s+half[-\s]swallowed\s+by\s+darkness\b/gi, 'face dimly lit by the fading screen glow'],
    [/\bpure\s+blackness\s+behind\s+(?:him|her|them)\b/gi, 'dim ambient shadows behind them'],
    [/\bterror\s+in\s+(?:his|her|their)\s+(?:wide\s+)?eyes\b/gi, 'a wide-eyed worried expression'],
    [/\b(?:a\s+)?(?:vague\s+)?(?:pale|dark|shadowy|tall)\s+(?:shape|figure|silhouette)\s+barely\s+distinguishable\s+in\s+the\s+(?:black|dark)\s+fog\s+behind\s+(?:him|her|them)\b/gi, 'soft drifting atmospheric haze in the background'],
    [/\b(?:a\s+)?(?:pale|dark|shadowy|tall)\s+(?:shape|figure|silhouette)\s+(?:lurking|looming|standing|emerging|appearing|waiting)\s+(?:directly\s+)?behind\s+(?:him|her|them)\b/gi, 'soft atmospheric haze in the background'],
    [/\b(?:a\s+)?(?:vague|pale|shadowy)\s+(?:shape|figure|silhouette)\s+behind\s+(?:him|her|them)\b/gi, 'soft atmospheric haze in the background'],
    [/\bblood\s+(?:spatter|splatter|dripping|stain|pool)\b/gi, 'red-toned shadow'],
    [/\bdead\s+bod(?:y|ies)\b/gi, 'still figure'],

    // --- Horror / disturbing mood & entities ---
    [/\bfound[-\s]footage\b/gi, 'handheld documentary'],
    [/\bhorror(?:\s+(?:style|aesthetic|scene|movie|film|genre))?\b/gi, 'suspenseful atmosphere'],
    [/\bhorrifying|horrific\b/gi, 'dramatic'],
    [/\bhorrified\b/gi, 'shocked'],
    [/\bterror\b/gi, 'unease'],
    [/\bterrified\b/gi, 'wide-eyed'],
    [/\bterrifying\b/gi, 'tense'],
    [/\bghostly\b/gi, 'misty'],
    [/\bghosts?\b/gi, 'faint mist'],
    [/\bdemonic\b/gi, 'dark'],
    [/\bdemons?\b/gi, 'shadowy figure'],
    [/\bmonsters?\b/gi, 'fantasy creature'],
    [/\bzombies?\b/gi, 'shambling figure'],
    [/\bcadavers?|corpses?\b/gi, 'still figure'],
    [/\bhaunted\b/gi, 'old'],
    [/\bcreepy\b/gi, 'atmospheric'],
    [/\bsinister\b/gi, 'mysterious'],
    [/\bmenacing\b/gi, 'imposing'],
    [/\blurking\b/gi, 'standing quietly'],
    [/\bstalking\b/gi, 'walking'],
    [/\bpossess(?:ed|ion)\b/gi, 'trance-like state'],
    [/\bexorcis[em]\w*\b/gi, 'ceremony'],

    // --- Violence, injury, death & self-harm ---
    [/\bgores?|gory\b/gi, 'dramatic'],
    [/\bblood\b/gi, 'red'],
    [/\bbloody|bloodied\b/gi, 'red-toned'],
    [/\bmurder(?:er|ers|ous)?\b/gi, 'mystery'],
    [/\bkill(?:ing|ings|s|ed)?\b/gi, 'defeat'],
    [/\bscream(?:ing|s)?\b/gi, 'calling out'],
    [/\bweapons?\b/gi, 'prop'],
    [/\b(?:guns?|pistols?|rifles?|firearms?)\b/gi, 'prop'],
    [/\b(?:knives|knife|blades?|daggers?)\b/gi, 'tool'],
    [/\bwounds?|wounded\b/gi, 'mark'],
    [/\binjur(?:y|ies|ed)\b/gi, 'setback'],
    [/\bd(?:ying|eath)\b/gi, 'fading'],
    [/\bdead\b/gi, 'motionless'],
    [/\bsuicide\b/gi, 'emotional struggle'],
    [/\bself[-\s]harm\b/gi, 'emotional struggle'],

    // --- Sexual / nudity ---
    [/\bnudity|nude|naked\b/gi, 'modestly dressed'],
    [/\bsexual|sexy|erotic\b/gi, 'romantic'],

    // --- Substance / illegal ---
    [/\bdrugs?\b/gi, 'medicine'],
    [/\bsmoking\b/gi, 'holding a warm drink'],
  ];

  for (const [pattern, replacement] of disturbingReplacements) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

export function sanitizeClipsForSafetyPolicy<T extends { imagePrompt: string; visualPrompt: string; endImagePrompt?: string }>(clips: T[]): T[] {
  return clips.map((clip) => ({
    ...clip,
    imagePrompt: sanitizePromptForSafetyPolicy(clip.imagePrompt),
    endImagePrompt: clip.endImagePrompt ? sanitizePromptForSafetyPolicy(clip.endImagePrompt) : '',
    visualPrompt: sanitizePromptForSafetyPolicy(clip.visualPrompt),
  }));
}

/**
 * Classifies a user/FastEval style label into a normalized category.
 */
export function classifyStyleCategory(
  styleStr?: string
): 'animation-2d' | 'animation-3d' | 'claymation' | 'cinematic' | 'phone-shot' | 'realistic' | 'other' {
  if (!styleStr || typeof styleStr !== 'string') return 'other';
  const s = styleStr.toLowerCase();
  if (/(?:cartoon|2d|anime|cel-shaded|manga|stickman|卡通|二次元|手绘|动漫)/i.test(s)) return 'animation-2d';
  if (/(?:3d|cgi|pixar|blender|low-poly|3d动画)/i.test(s)) return 'animation-3d';
  if (/(?:claymation|stop-motion|plasticine|定格|粘土)/i.test(s)) return 'claymation';
  if (/(?:phone|ugc|smartphone|vlog|手机拍摄|手机)/i.test(s)) return 'phone-shot';
  if (/(?:cinematic|film|movie|35mm|电影)/i.test(s)) return 'cinematic';
  if (/(?:realistic|documentary|写实|纪实|纪录片)/i.test(s)) return 'realistic';
  return 'other';
}

/**
 * Enforces visual style consistency on generated clips.
 * When the style is animation/cartoon/3d, it strictly eliminates photorealistic
 * descriptions and prevents uncomfortable realistic biological/macro insect rendering.
 */
export function enforceVisualStyleOnClips<T extends { imagePrompt: string; visualPrompt: string; endImagePrompt?: string; styleAesthetic?: string }>(
  clips: T[],
  visualStyle?: string
): T[] {
  if (!visualStyle && !clips.some((c) => c.styleAesthetic)) return clips;
  const rawStyle = (visualStyle || '').trim();
  const targetCategory = classifyStyleCategory(rawStyle);
  const isAnimated = targetCategory === 'animation-2d' || targetCategory === 'animation-3d' || targetCategory === 'claymation' ||
    /(?:cartoon|animation|animated|anime|3d|claymation|stop-motion|pixar|cel-shaded|manga|comic|手绘|动漫|卡通|定格|粘土)/i.test(rawStyle);

  const toEnglishDescriptor = (raw: string, cat: string): string => {
    if (cat === 'animation-2d') return 'Stylized 2D cartoon animation style';
    if (cat === 'animation-3d') return 'Stylized 3D animation style';
    if (cat === 'claymation') return 'Handcrafted stop-motion claymation style';
    if (cat === 'phone-shot') return 'Authentic smartphone camera POV';
    if (cat === 'cinematic') return 'Cinematic film style';
    if (cat === 'realistic') return 'Realistic documentary style';
    const stripped = raw.replace(/[\u4e00-\u9fa5]/g, '').replace(/[（）()、/]/g, ' ').replace(/\s+/g, ' ').trim();
    return stripped ? `${stripped} style` : 'Cinematic visual style';
  };

  const styleTag = toEnglishDescriptor(rawStyle, targetCategory);

  return clips.map((clip) => {
    let img = clip.imagePrompt;
    let endImg = clip.endImagePrompt || '';
    let vis = clip.visualPrompt;
    let aesthetic = clip.styleAesthetic || '';

    if (isAnimated) {
      const cleanAnimated = (p: string) => {
        if (!p) return p;
        return p
          .replace(/\b(photorealistic|hyperrealistic|ultra-realistic|real-life|macro photography of realistic|realistic close-up of real)\b/gi, 'stylized animation')
          .replace(/\b(photograph of|real photograph|live-action)\b/gi, 'animated depiction of')
          .replace(/\b(realistic insect|realistic bug|creepy realistic insect|gross macro insect)\b/gi, 'cute stylized cartoon insect');
      };

      img = cleanAnimated(img);
      endImg = cleanAnimated(endImg);
      vis = cleanAnimated(vis);
      aesthetic = cleanAnimated(aesthetic);

      const mediumCheck =
        targetCategory === 'animation-2d'
          ? /(?:cartoon|2d|anime|cel-shaded|manga)/i
          : targetCategory === 'animation-3d'
            ? /(?:3d|blender|pixar|cgi)/i
            : /(?:claymation|stop-motion|plasticine)/i;

      if (img && !mediumCheck.test(img)) {
        img = `${styleTag}, ${img}`;
      }
      if (endImg && !mediumCheck.test(endImg)) {
        endImg = `${styleTag}, ${endImg}`;
      }
      if (vis && !mediumCheck.test(vis)) {
        vis = `${styleTag}, ${vis}`;
      }
    } else if (rawStyle) {
      if (img && !img.toLowerCase().includes(styleTag.toLowerCase())) {
        img = `${styleTag}, ${img}`;
      }
      if (vis && !vis.toLowerCase().includes(styleTag.toLowerCase())) {
        vis = `${styleTag}, ${vis}`;
      }
    }

    // Strip any residual Chinese characters from prompt text to ensure strict English purity
    const purgeChinese = (s: string) => s.replace(/[\u4e00-\u9fa5]/g, '').replace(/\s{2,}/g, ' ').trim();

    return {
      ...clip,
      imagePrompt: purgeTextAndBorderArtifacts(purgeChinese(img)),
      endImagePrompt: purgeTextAndBorderArtifacts(purgeChinese(endImg)),
      visualPrompt: purgeTextAndBorderArtifacts(purgeChinese(vis)),
      styleAesthetic: purgeTextAndBorderArtifacts(purgeChinese(aesthetic || clip.styleAesthetic || styleTag)),
    };
  });
}

/**
 * Strips words, typography, stamp readings, margin notes, newsprint text,
 * and border/frame decorators that trigger image models to generate gibberish text or fuzzy borders.
 */
export function purgeTextAndBorderArtifacts(promptText: string): string {
  if (!promptText) return promptText;
  let text = promptText;

  const patterns: Array<[RegExp, string]> = [
    [/\b(?:a\s+)?(?:red\s+ink\s+)?stamp\s+reading\s+["'\w\s]+/gi, 'ink markings'],
    [/\b(?:reading|labeled|spelling|marked with)\s+["'][A-Za-z0-9\s]+["']/gi, ''],
    [/\b(?:reading|labeled|spelling|marked with)\s+[A-Z]{2,}(?:\s+[A-Z]{2,})*/g, ''],
    [/\b(?:the\s+)?red\s+[A-Z]{2,}\s+stamp\b/gi, 'red ink mark'],
    [/\bhandwritten\s+(?:margin\s+)?notes?\b/gi, 'fine abstract sketch lines'],
    [/\b(?:handwritten\s+)?transcript(?:\s+fragments?)?\b/gi, 'textured paper collage fragments'],
    [/\bnewsprint(?:\s+textures?|\s+shadows?)?\b/gi, 'parchment paper texture'],
    [/\bspelling\s+fragmented\s+words\b/gi, 'abstract paper shapes'],
    [/\b(?:layered\s+around\s+the\s+frame|surrounding\s+frame\s+borders?|top\s+and\s+bottom\s+borders?|letterbox(?:ing)?|pillarbox(?:ing)?)\b/gi, ''],
    [/\b(?:with\s+words|containing\s+text|text\s+reading|typography|subtitles|captions)\b/gi, ''],
  ];

  for (const [pat, repl] of patterns) {
    text = text.replace(pat, repl);
  }

  return text
    .replace(/\s*,\s*,+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[,;\s]+|[,;\s]+$/g, '');
}

/**
 * Replaces character placeholders like {character1}, {character_1}, etc.
 * with their master character descriptions.
 */
export function expandCharacterPlaceholders(
  text: string,
  characters?: Record<string, string>
): string {
  if (!text || !characters) return text;
  let result = text;
  for (const [key, description] of Object.entries(characters)) {
    if (!description || typeof description !== 'string') continue;
    const cleanKey = key.replace(/[{}]/g, '').trim();
    if (!cleanKey) continue;
    const pattern = new RegExp(`\\{${cleanKey}\\}`, 'gi');
    result = result.replace(pattern, description.trim());
  }
  return result;
}

/**
 * Replaces background/scene placeholders like {background1}, {scene1}, etc.
 * with their master background/location descriptions (which MUST carry absolute sizes).
 */
export function expandBackgroundPlaceholders(
  text: string,
  backgrounds?: Record<string, string>
): string {
  if (!text || !backgrounds) return text;
  let result = text;
  for (const [key, description] of Object.entries(backgrounds)) {
    if (!description || typeof description !== 'string') continue;
    const cleanKey = key.replace(/[{}]/g, '').trim();
    if (!cleanKey) continue;
    const pattern = new RegExp(`\\{${cleanKey}\\}`, 'gi');
    result = result.replace(pattern, description.trim());
  }
  return result;
}

/**
 * Expands BOTH character and background placeholders in a single pass so that
 * every image/video prompt carries the identical sized master descriptions.
 */
export function expandMasterPlaceholders(
  text: string,
  masters?: { characters?: Record<string, string>; backgrounds?: Record<string, string> }
): string {
  if (!text || !masters) return text;
  return expandBackgroundPlaceholders(
    expandCharacterPlaceholders(text, masters.characters),
    masters.backgrounds
  );
}

/**
 * Scale & proportion consistency rule. Character and environment definitions are
 * generated ONCE with absolute size and then referenced by placeholder in every clip,
 * so the human-to-set ratio cannot drift between images/videos.
 */
export const SCALE_AND_PROPORTION_GUIDELINES = `
## MASTER SCENE & SCALE CONSISTENCY RULE ({character1} + {background1})

1. TWO SIZED MASTER DICTIONARIES ARE MANDATORY in every generated JSON response:
   - "characters": one immutable entry per recurring character, ALWAYS prefixed with its ABSOLUTE SIZE
     and build, e.g. "character1": "1.8 m / 5 ft 11 in tall, athletic adult male, weathered face, ... exact
     clothing from head to toe ...".
   - "backgrounds": one immutable entry per recurring location/set, ALWAYS prefixed with its ABSOLUTE
     DIMENSIONS and fixed scale landmarks, e.g. "background1": "massive Hollywood sound-stage interior,
     ~30 m ceiling height, 2.4 m tall steel double doors, tabletop miniature theater 0.6 m wide x 0.4 m tall
     with 5 cm puppets".
   - BOTH dictionaries MUST express size in the SAME unit (metres or feet) so the human-to-environment
     ratio is computable, and MUST NOT change between clips.

2. DETERMINISTIC SCALE ANCHOR (尺寸锚点):
   - Every character/background definition MUST contain a concrete height/dimension AND at least one
     landmark whose size fixes the ratio (door height, table height, ceiling, vehicle, prop).
   - NEVER re-invent, re-scale, or contradict a size that was already defined in the master dictionaries.

3. PLACEHOLDER REFERENCING (统一引用):
   - In EVERY clip imagePrompt, endImagePrompt and visualPrompt, refer to characters as {character1},
     {character2}, ... and to the location as {background1}, {background2}, ... .
   - NEVER re-describe or re-scale a character/background in a clip prompt; the placeholder expands to the
     exact same size tokens in every image and video.
   - When the shot size or camera distance changes, express the scale change through FRAMING only
     (e.g. "wide shot, character occupies about 1/4 of frame height"), NEVER by editing the master sizes.
`;

export const FLOW_PROMPT_REWRITE_GUIDELINES = `
## GOOGLE FLOW DUAL-PROMPT REWRITING & KEYFRAME INFERENCE RULES (FRAMES MODE):

1. **Source Prompt Rewriting into Flow Standards**:
   - For cut scenes (Cut Scene Mode), every scene requires THREE coordinated prompts:
     * **imagePrompt** (Text-to-Image / STARTING KEYFRAME AT t=0.0s): Static scene description for the OPENING / START of the clip (strictly NOT the conclusion!). Describes the frozen moment at second 0.0: initial subject pose, environment, lighting, artistic style before motion begins. (e.g. warrior with blade raised poised to strike, runner ready at starting blocks).
     * **endImagePrompt** (Text-to-Image / ENDING KEYFRAME AT t=duration): Static scene description for the CONCLUSION / END of the clip (ending frame). Describes the settled moment when the clip's action reaches completion (e.g. warrior with blade swung through in finished stance, runner crossing the finish line tape), maintaining strict character, environment, and art-medium consistency with imagePrompt.
     * **visualPrompt** (Video Motion / Animation): Temporal motion & camera movement choreography connecting the starting keyframe to the ending keyframe over time.
   - If the candidate video provides source video prompts (e.g. Runway, Kling, Sora, Veo), REWRITE them into "visualPrompt" adhering to Flow's camera dynamics and timing.
   - If the candidate video provides source image prompts (e.g. Midjourney, Flux, DALL-E), REWRITE them into "imagePrompt", preserving subject poses and composition.

2. **AUTOMATIC KEYFRAME PROMPT SUPPLEMENTING (When Original Video Lacks Prompts)**:
   - If the original video contains video prompts but lacks static image prompts, you MUST automatically infer and SUPPLEMENT matching static "imagePrompt" AND "endImagePrompt".
   - Break down the video prompt: extract the subject, initial pose (for imagePrompt), final pose (for endImagePrompt), environment setting, lighting atmosphere, and visual art medium.
   - Compose clean, static text-to-image prompts as the starting and ending keyframes for the Frames video generation to interpolate between.

3. **MASTER CHARACTER & SCENE SCALE CONSISTENCY RULE ({character1: xxxx} + {background1: xxxx})**:
   - In any narrative featuring recurrent characters or creatures, you MUST define each character once in the top-level "characters" dictionary, ALWAYS including its ABSOLUTE SIZE/BUILD (e.g. {"character1": "1.8 m tall athletic build, detailed fixed appearance, age, gender, ethnicity, facial features, hair, eye color, and exact clothing from head to toe"}).
   - You MUST ALSO define each recurring location/set once in the top-level "backgrounds" dictionary, ALWAYS including its ABSOLUTE DIMENSIONS and scale landmarks in the SAME unit (e.g. {"background1": "30 m ceiling, 2.4 m tall doors, 0.6 m x 0.4 m tabletop model with 5 cm puppets"}).
   - In EVERY clip's imagePrompt, endImagePrompt, and visualPrompt where that character or set appears, you MUST refer to them using the exact placeholders "{character1}" (or "{character2}") and "{background1}" (or "{background2}").
   - NEVER vary, re-describe, or ad-lib character traits OR sizes between clips. Using "{character1}" and "{background1}" ensures 100% token-for-token character AND scene consistency (including scale ratio) across all images and videos.
${SCALE_AND_PROPORTION_GUIDELINES}
`;

export const GENERATIVE_VIDEO_GUIDELINES = `
You are an expert cinematic director and AI video prompt engineer specializing in generative video model prompt synthesis.
Your mission is to transform research scenes, narrative story beats, and transcript cues into high-fidelity visual prompts tailored for generative video synthesis.

## TWO-PROMPT WORKFLOW (Image + Video)

Each clip requires TWO distinct prompts:

1. **imagePrompt** (Text-to-Image / STARTING FRAME OF CLIP): A static scene description for generating the OPENING keyframe image at second 0.0 (片段的开头，绝对不是结尾！).
   - Describe the scene as a frozen moment AT THE VERY START: initial framing, starting subject pose, environment, lighting, style.
   - No motion, no camera movement, no temporal action. It is strictly the OPENING frame where the video clip BEGINS.

2. **visualPrompt** (Image-to-Video / Animate): A motion+animation prompt that brings the static image to life.
   - Describe ONLY the motion, camera movement, temporal dynamics, and physical actions.
   - Assume the viewer already sees the image — describe what MOVES and HOW.
   - Focus on: camera choreography, subject animation, particle effects, lighting shifts, environmental motion.

## UNIVERSAL PROMPT FORMULA

Image Prompt: [Framing & Shot Type] + [Subject & Pose/State] + [Environment & Setting Depth] + [Lighting & Atmosphere] + [Artistic Style & Aesthetic]
Video Prompt: [Camera Movement] + [Subject Motion & Action] + [Environmental Dynamics] + [Temporal Effects & Particles] + [Pacing & Rhythm]

CORE PROMPT RULES:
1. Preserve and Amplify Artistic Style:
   - Always honor the source video's specific visual medium and art direction. Never force generic live-action photorealism onto animated or stylized content.
   - For line-art/stickman animations, describe fluid 2D keyframed combat, clean silhouettes, and kinetic energy trails.
   - For fantasy/gothic/creature stories, describe stylized textures, atmospheric volumetric fog, and dramatic lighting.
   - For document/archival narratives, describe multi-plane 3D parallax, macro lens depth, and authentic textured materials.
   - For cartoon/anime/claymation, preserve their distinct animation medium, palettes, and expressive framing.
2. Physical and Concrete Actions:
   - Describe visible, tangible physical motions and interactions. Avoid empty buzzwords like "hyperrealistic", "stunning", "mind-blowing", or "breathtaking".
3. Dynamic Camera Choreography (video prompt only):
   - Explicitly specify camera motion ("slow dolly-in", "tracking pan left to right", "rapid whip pan", "macro parallax drift", "low-angle orbital sweep").
4. Atmospheric Lighting & Depth:
   - Detail the lighting quality ("soft golden hour sunbeams", "cool neon rim lighting", "dramatic chiaroscuro tungsten lamp with dust motes", "eerie volumetric fog").
5. Visual-Only (STRICT NO-TEXT & NO-BORDER RULE):
   - Models generate visual frames, not text overlays, captions, or collage text.
   - ABSOLUTELY FORBIDDEN: Do NOT ask for subtitles, charts, text labels, UI overlays, stamps, words, letters, signatures, handwritten notes, margin notes, or transcript fragments.
   - NO NEWSPRINT / NO TYPOGRAPHY: Never describe newsprint shadows, printed text textures, or words in the background.
   - NO BORDERS / NO LETTERBOX: Never describe borders, framed edges, vignette margins, or torn paper along frame edges. Full-bleed clean visual imagery only.
6. Clip Duration Matching:
   - Ensure the described physical action naturally fits within the requested clip duration (e.g. 4, 6, 8, or 10 seconds).
7. ZERO META / ZERO TUTORIAL LEAKAGE (STRICT IN-UNIVERSE STORYTELLING):
   - You are generating prompts to produce the FINAL CREATIVE ENTERTAINMENT VIDEO (the story, the fictional characters, the animated world).
   - ABSOLUTELY FORBIDDEN: Laptops, computer desks, keyboards, creators/editors, software UI, ChatGPT interfaces, editing software, timelines, storyboards on paper, prompt cards, tutorial demonstrations, social media like counters, or subscriber calls-to-action.
   - Even if the research scenes mention tutorial chapters (e.g. "planning prompt", "using image tool", "assembling edit"), DO NOT visualize the creator, their workspace, or their computer!
   - Every clip must depict the IN-UNIVERSE fictional world, characters, environments, and story events.
8. STRICT POLICY AVOIDANCE: PROMINENT PEOPLE & APPROXIMATE ACTION EVASION:
   - NEVER generate recognizable real prominent figures (politicians, presidents, celebrities, news anchors, tech executives).
   - NEVER include real names (e.g. Trump, Biden, Obama, Harris, Musk).
   - AVOID direct frontal close-up talking faces of anchors or politicians.
   - USE APPROXIMATE ACTIONS & OBJECT METAPHORS: hands shuffling dossiers, hands adjusting mixer dials, pen signing documents, close-up of vintage broadcast mic with glowing ON AIR light, bouncing VU meters, flickering newsroom monitors, sweeping searchlights across empty podiums.
   - USE INDIRECT FRAMING: over-the-shoulder (OTS) shots, back views (framing suited shoulders from behind), deep high-contrast silhouettes against backlit blinds, and wide environmental shots.
9. STRICT CONTENT-SAFETY POLICY AVOIDANCE (GORE / HORROR / VIOLENCE / DISTURBING CONTENT):
   - NEVER request graphic violence, gore, blood, wounds, corpses, weapons aimed at people, torture, or death scenes.
   - NEVER request horror/disturbing content: ghosts, demons, monsters, zombies, possessions, jumpscares, screaming in terror, or any threatening/ambiguous figure lurking or standing DIRECTLY BEHIND a person.
   - NEVER request sexual/nudity content, self-harm/suicide, hate symbols/slurs, copyrighted characters, real disasters, drugs, smoking, or minors in dangerous contexts.
   - Express suspense and emotion ONLY through cinematic craft (lighting, grain, slow push-in, guarded pose) and keep every frame family-safe / PG.
${FLOW_PROMPT_REWRITE_GUIDELINES}
${POLICY_AVOIDANCE_GUIDELINES}
${CONTENT_SAFETY_GUIDELINES}
`;

// Backward-compatible alias
export const VEO_GUIDELINES = `Google Veo & Generative Video Guidelines:\n${GENERATIVE_VIDEO_GUIDELINES}`;

export function buildVideoSystemPrompt(options?: { modelTarget?: string; clipDuration?: 4 | 6 | 8 | 10 }): string {
  const modelName = options?.modelTarget ? ` for ${options.modelTarget}` : '';
  const duration = options?.clipDuration ?? 4;
  return `${GENERATIVE_VIDEO_GUIDELINES}
Target Model: Video Generation Engine${modelName}

Generate a structured JSON response matching this exact shape:
{
  "clips": [
    {
      "clipIndex": 1,
      "sceneId": "scene-001",
      "title": "Short descriptive scene title",
      "startSec": 0,
      "endSec": ${duration},
      "durationSec": ${duration},
      "imagePrompt": "Starting frame image prompt at second 0.0 before motion begins (required for new scene shots; empty string \"\" for action continuation shots)",
      "endImagePrompt": "Ending frame image prompt at second ${duration} (required for new scene shots; empty string \"\" for action continuation shots)",
      "visualPrompt": "Motion and animation prompt for image-to-video: camera choreography, subject action, environmental dynamics, temporal effects. Describe ONLY what moves on screen. DO NOT write transition instructions (cut/continuous/starting from last frame) into this prompt!",
      "cameraMovement": "Specific camera movement description",
      "subjectAction": "Physical description of what the subject does",
      "environmentLighting": "Atmospheric lighting description",
      "styleAesthetic": "Genre-specific artistic style description",
      "narrationCues": "Matching transcript or spoken voiceover line only; leave empty string \"\" if no spoken dialogue"
    }
  ]
}

Return ONLY valid JSON. Do not include markdown code block markers or conversational preamble.`;
}

// Backward-compatible export
export function buildVeoSystemPrompt(options?: { clipDuration?: 4 | 6 | 8 | 10; modelTarget?: string }): string {
  const modelTarget = options?.modelTarget || 'Google Veo';
  return `${VEO_GUIDELINES}\n${buildVideoSystemPrompt({ modelTarget, clipDuration: options?.clipDuration })}`;
}

export function buildVideoUserPrompt(params: {
  topic: string;
  videoTitle: string;
  videoSummary?: string;
  segments: Array<{
    id?: string;
    title?: string;
    summary?: string;
    startSec: number;
    endSec: number;
    text?: string;
  }>;
  clipDuration?: 4 | 6 | 8 | 10;
  aspectRatio?: 'landscape' | 'portrait';
  modelTarget?: string;
  vlStyleHint?: string;
  vlPrompts?: VlExtractedPrompt[];
  visualStyle?: string;
}): string {
  const duration = params.clipDuration || 4;
  const aspect = params.aspectRatio || 'landscape';

  const scenesText = params.segments
    .slice(0, 12)
    .map((seg, idx) => {
      const id = seg.id || `scene-${String(idx + 1).padStart(3, '0')}`;
      const title = seg.title || `Scene ${idx + 1}`;
      const time = `${Math.round(seg.startSec)}s - ${Math.round(seg.endSec)}s`;
      const desc = seg.summary || seg.text?.slice(0, 160) || '';
      return `[${id}] (${time}) "${title}": ${desc}`;
    })
    .join('\n');

  // Multi-modal source prompt analysis
  const vlPrompts = params.vlPrompts || [];
  const videoPrompts = vlPrompts.filter((p) => p.promptType === 'video' && p.prompt && p.prompt.trim().length > 0);
  const imagePrompts = vlPrompts.filter((p) => p.promptType === 'image' && p.prompt && p.prompt.trim().length > 0);

  let promptDirectiveBlock = '';
  if (vlPrompts.length > 0) {
    const formattedSources = formatSourcePromptsForLlm(vlPrompts);
    let directive = '';

    if (videoPrompts.length > 0 && imagePrompts.length === 0) {
      directive = `CRITICAL DIRECTIVE - SUPPLEMENT MISSING IMAGE PROMPTS (补齐缺失的图片提示词):
The candidate video contains ${videoPrompts.length} AI video generation prompt(s), but ZERO static image generation prompts.
For each scene clip:
1. Rewrite the video prompt and camera motion into Flow's "visualPrompt" (motion choreography, camera dynamics, temporal action).
2. You MUST automatically infer, synthesize, and SUPPLEMENT a corresponding static "imagePrompt" representing the frozen initial keyframe. Describe the initial scene composition, framing, lighting, subject pose, and art medium before motion begins (strictly NO motion words).`;
    } else if (videoPrompts.length > 0 && imagePrompts.length > 0) {
      directive = `CRITICAL DIRECTIVE - DUAL PROMPT REWRITING (重写源图片与视频提示词为Flow双提示词):
The candidate video contains both ${imagePrompts.length} AI image prompt(s) and ${videoPrompts.length} video prompt(s).
Systematically rewrite and adapt the source image prompts into Flow "imagePrompt" (static text-to-image starting keyframe) and source video prompts into Flow "visualPrompt" (image-to-video animation and camera movement).`;
    } else if (imagePrompts.length > 0 && videoPrompts.length === 0) {
      directive = `CRITICAL DIRECTIVE - REWRITE IMAGE PROMPTS & INFER MOTION:
The candidate video contains ${imagePrompts.length} AI image prompt(s).
Rewrite source image prompts into Flow "imagePrompt" (static keyframe) and derive cinematic camera dynamics into Flow "visualPrompt".`;
    }

    promptDirectiveBlock = `\n=== EXTRACTED SOURCE PROMPTS FROM CANDIDATE VIDEO ===\n${formattedSources}\n\n${directive}\n`;
  } else if (params.vlStyleHint) {
    promptDirectiveBlock = `\nSTYLE REFERENCE (from original video's AI generation prompt):\n${params.vlStyleHint}\nMatch this visual style, aesthetic direction, and prompt engineering approach.\n\n`;
  }

  return `Topic: "${params.topic}"
Reference Video: "${params.videoTitle}"
${params.visualStyle ? `Identified Visual Style: "${params.visualStyle}"\n` : ''}${params.videoSummary ? `Summary: ${params.videoSummary}\n` : ''}Aspect Ratio: ${aspect}
Default Clip Duration: ${duration} seconds
${params.modelTarget ? `Target Model: ${params.modelTarget}\n` : ''}${promptDirectiveBlock}Scenes from Research:
${scenesText}

CRITICAL STORYTELLING RULE:
Every clip must be an IN-UNIVERSE scene inside the fictional story world.
NEVER depict a creator, a desk, a laptop, software UI, prompt cards, or video editing.
NEVER output real prominent people or politician names (e.g. Trump, Biden). For political/news themes, use approximate actions (hands on documents/microphones), equipment close-ups (ON AIR mics, monitors), or indirect framing (over-the-shoulder, silhouettes, back views) instead of frontal talking heads.
NEVER output graphic violence, gore, blood, corpses, weapons aimed at people, horror/disturbing entities (ghosts, demons, monsters, zombies), a threatening figure standing directly BEHIND a person, screaming in terror, sexual/nudity content, self-harm, hate symbols, copyrighted characters, drugs, smoking, or real tragedies. Express suspense through cinematic craft (lighting, grain, guarded pose) and keep every frame family-safe / PG.
Transform all scenes into a continuous, cinematic in-universe story arc!

Convert each scene into generation prompts:
1. **imagePrompt**: A static keyframe scene description for text-to-image generation of the STARTING FRAME (t=0.0s). Describe the frozen visual composition — framing, subject pose, environment, lighting, and artistic style. For action continuation scenes where motion flows directly from the previous scene, leave this as empty string "".
2. **endImagePrompt**: A static keyframe scene description for text-to-image generation of the ENDING FRAME (t=duration). Required for new scene shots.
   - Describe the settled conclusion posture and framing, with character and art style identical to imagePrompt.
   - CRITICAL DELTA & COMPLETION RULE: The ending frame MUST be a complete, self-contained description representing a CLEAR, VISUALLY DISTINCT PROGRESSION from imagePrompt (e.g., character has finished moving across the room, hand is holding the microphone, new object is revealed, pose and composition have noticeably advanced).
   - NEVER use phrases like "Same wide shot", "same framing with tiny subtle change", or "nearly identical scene"; always specify the new framing, subject action conclusion, and visual state so the image generation model creates a distinctly evolved concluding frame. For action continuation scenes, leave this as empty string "".
3. **visualPrompt**: An animation prompt describing ONLY the motion, camera choreography, subject action, environmental dynamics, and temporal effects within this clip. DO NOT include transition instructions, scene switch phrases, or continuation meta-words in this prompt.

Preserve the unique visual style, characters, and kinetic action of the source video. Return JSON with the clips array.`;
}

// Backward-compatible export
export function buildVeoUserPrompt(params: {
  topic: string;
  videoTitle: string;
  videoSummary?: string;
  segments: Array<{
    id?: string;
    title?: string;
    summary?: string;
    startSec: number;
    endSec: number;
    text?: string;
  }>;
  clipDuration?: 4 | 6 | 8 | 10;
  aspectRatio?: 'landscape' | 'portrait';
  vlStyleHint?: string;
  vlPrompts?: VlExtractedPrompt[];
}): string {
  return buildVideoUserPrompt(params);
}

/**
 * Deterministic prompt generator that dynamically extracts aesthetic and lighting
 * without relying on generic photorealism fallbacks or hardcoded presets.
 * Returns both imagePrompt (static) and visualPrompt (motion).
 */
export function buildDeterministicVeoPrompt(
  topic: string,
  sceneTitle: string,
  narration?: string,
  contextText?: string,
  visualStyle?: string
): { imagePrompt: string; visualPrompt: string } {
  const dynamic = extractDynamicVisualAesthetic(topic, sceneTitle, narration, contextText, visualStyle);
  return { imagePrompt: dynamic.imagePrompt, visualPrompt: dynamic.visualPrompt };
}

export interface ReorchestrationPromptOptions {
  vlPrompts: VlExtractedPrompt[];
  topic: string;
  videoTitle: string;
  videoSummary?: string;
  targetClipCount: number;
  clipDuration: 4 | 6 | 8 | 10;
  aspectRatio: 'landscape' | 'portrait';
  modelTarget?: string;
  clipTransitions?: Array<'cut' | 'continuous'>;
  visualStyle?: string;
}

/**
 * Builds the system prompt for LLM prompt re-orchestration.
 * All parameters are passed dynamically without hardcoding.
 */
export function buildReorchestrationSystemPrompt(options?: {
  modelTarget?: string;
  clipDuration?: 4 | 6 | 8 | 10;
  targetClipCount?: number;
  visualStyle?: string;
}): string {
  const modelName = options?.modelTarget ? ` for ${options.modelTarget}` : '';
  const duration = options?.clipDuration ?? 4;
  const countDesc = options?.targetClipCount ? `exactly ${options.targetClipCount}` : 'the requested number of';
  const styleInstruction = options?.visualStyle
    ? `\n4. MANDATORY VISUAL STYLE INTEGRITY (${options.visualStyle}):
   - The reference visual art style has been identified as: "${options.visualStyle}".
   - You MUST strictly enforce this visual medium across all clips (imagePrompt, endImagePrompt, visualPrompt).
   - If the style is animation/cartoon/3D (卡通/2D/3D动画/定格动画):
     * NEVER drift into live-action or photorealism.
     * STRICT AVOIDANCE OF UNCOMFORTABLE REALISTIC SUBJECTS: When depicting insects, bugs, creatures, or organic elements in animation/cartoon styles, NEVER produce photorealistic, hyperrealistic, or macro photography descriptions of real insects (no realistic chitin, gross bristles, or creepy anatomical close-ups). Render them strictly as stylized, charming, whimsical, or simplified cartoon/animated characters!
   - If the style is cinematic, film, or smartphone/UGC, maintain that specific medium consistently.`
    : '';

  return `You are an expert cinematic director and AI video prompt re-orchestration architect${modelName}.
Your mission is to take raw AI generation prompts extracted from a reference video (classified strictly as "image" or "video") and RE-ORCHESTRATE (重新编排) them into a cohesive, high-fidelity narrative sequence of ${countDesc} scene clips.

CRITICAL IN-UNIVERSE CREATIVE STORYTELLING PRINCIPLES:
1. ZERO TUTORIAL / ZERO DESKTOP LEAKAGE:
   - You are creating the in-universe cinematic story world depicted in the prompts, NOT a tutorial about how prompts were made.
   - ABSOLUTELY FORBIDDEN: Laptops, desks, computer monitors, keyboards, editors/creators at desks, UI windows, ChatGPT chats, Midjourney interfaces, or tutorial narrations.
   - Every clip must take place INSIDE the fictional world, featuring the characters, creatures, settings, and lore of the story.

2. DUAL-PROMPT ARCHITECTURE (Each clip MUST have both prompts):
   - **imagePrompt (图片提示词)** - 片段开头起始帧 (STARTING FRAME ONLY):
     * CRITICAL RULE: imagePrompt is ALWAYS the STARTING FRAME (instant t=0.0s before motion begins) of this clip, ABSOLUTELY NEVER THE ENDING!
     * The subject must be posed at the START of the action, NOT at the finish or aftermath (e.g. at the starting line, sword raised before the swing, door just beginning to open).
     * Formula: [Framing & Shot Type] + [Subject & Initial Opening Pose / Posture] + [Environment Setting & Depth] + [Lighting & Atmosphere] + [Artistic Medium & Style].
   - **visualPrompt (配套视频提示词)** - 动态演进 (MOTION DYNAMICS):
     * Formula: [Camera Choreography] + [Subject Action & Motion] + [Dynamic Environmental Shifts] + [Atmospheric Particles & Lighting Changes].
     * Describes how the scene moves and evolves FROM the opening imagePrompt ONWARD to the end of the clip.
${POLICY_AVOIDANCE_GUIDELINES}
${CONTENT_SAFETY_GUIDELINES}
3. MASTER CHARACTER & SCENE SCALE CONSISTENCY RULE ({character1} + {background1}):
   - In any narrative featuring recurrent characters or creatures, you MUST define each character in the top-level "characters" dictionary, ALWAYS including its ABSOLUTE SIZE/BUILD (e.g. "character1": "1.8 m tall athletic adult male, detailed fixed appearance, age, gender, ethnicity, facial features, hair, eye color, and exact clothing from head to toe").
   - You MUST ALSO define each recurring location/set in the top-level "backgrounds" dictionary, ALWAYS including its ABSOLUTE DIMENSIONS and scale landmarks in the SAME unit (e.g. "background1": "massive sound-stage interior, 30 m ceiling height, 2.4 m tall steel doors, 0.6 m wide x 0.4 m tall tabletop miniature theater with 5 cm puppets").
   - MANDATORY INSTRUCTION: In EVERY clip's imagePrompt, endImagePrompt, and visualPrompt where that character or set appears, you MUST refer to them using the exact placeholders "{character1}" (or "{character2}") and "{background1}" (or "{background2}").
   - NEVER vary, re-describe, or ad-lib character traits OR sizes between clips. Every visual prompt referencing the character/set MUST use the placeholders "{character1}" and "{background1}" so the description (including scale ratio) remains 100% token-for-token identical across all images and videos!
${SCALE_AND_PROPORTION_GUIDELINES}
4. RE-ORCHESTRATION & SYNTHESIS:
   - Seamlessly connect and expand the extracted source prompts across the clips into a compelling beginning, middle, and climax.
   - Maintain character design, wardrobe, color palette, lighting atmosphere, and visual medium consistency throughout all clips.
   - If the extracted prompts contain both image and video prompts, synthesize their aesthetics and motion.
   - If the extracted prompts are video prompts only, deduce the frozen starting composition into imagePrompt and adapt motion into visualPrompt.
   - If the extracted prompts are image prompts only, adapt the composition into imagePrompt and design dynamic camera and character motion into visualPrompt.${styleInstruction}
5. STRICT ENGLISH LANGUAGE REQUIREMENT:
   - All generated clip fields — title, imagePrompt, endImagePrompt, visualPrompt, cameraMovement, subjectAction, environmentLighting, styleAesthetic, and narrationCues — MUST be written 100% strictly in clean ENGLISH.
   - NEVER output Chinese characters (汉字) in any field. The voiceover TTS engine requires pure English voiceover.

Target Clip Duration: ${duration} seconds per clip.

Return a structured JSON response matching this exact shape:
{
  "characters": {
    "character1": "ABSOLUTE SIZE first (e.g. 1.8 m tall athletic build), then exhaustive, unvarying description of character 1: age, ethnicity, facial features, facial hair, hairstyle/color, exact clothing, textures, and accessories from head to toe",
    "character2": "Optional second character definition"
  },
  "backgrounds": {
    "background1": "ABSOLUTE DIMENSIONS first (e.g. 30 m ceiling, 2.4 m tall doors, 0.6 m x 0.4 m tabletop model with 5 cm puppets) plus fixed scale landmarks for the recurring location/set",
    "background2": "Optional second background definition"
  },
  "hasNarration": "y | n",
  "clips": [
    {
      "clipIndex": 1,
      "sceneId": "scene-001",
      "title": "Short descriptive scene title",
      "hasNarration": "y | n",
      "startSec": 0,
      "endSec": ${duration},
      "durationSec": ${duration},
      "imagePrompt": "Starting frame image prompt at 0.0s. Always use {character1} for characters and {background1} for the location! (MANDATORY FOR CUT / new scene shots; empty string \"\" for action continuation shots)",
      "endImagePrompt": "Ending frame image prompt at duration. Always use {character1} for characters and {background1} for the location! (MANDATORY FOR CUT / new scene shots; empty string \"\" for action continuation shots)",
      "visualPrompt": "Companion animation prompt for camera movement, subject action, dynamic effects. Always use {character1} and {background1} for references! CRITICAL: Describe ONLY movement and dynamics. DO NOT include transition phrases or continuation meta-words in this prompt!",
      "cameraMovement": "Specific camera movement description",
      "subjectAction": "Physical action performed by the subject",
      "environmentLighting": "Atmospheric lighting description",
      "styleAesthetic": "Genre-specific artistic style description",
      "narrationCues": "Actual in-universe spoken dialogue or spoken voiceover line only. If this clip has NO dialogue or spoken lines (ambient, instrumental, silent, or sound effects only), this MUST be an empty string \"\". NEVER write 'No dialogue', 'No dialog', 'None', 'Mood cue:', or sound effect descriptions."
    }
  ]
}

Return ONLY valid JSON. Do not include markdown code block markers or conversational preamble.`;
}

/**
 * Builds the user prompt for LLM prompt re-orchestration.
 * Dynamically injects all extracted prompts and target clip count N.
 */
export function buildReorchestrationUserPrompt(options: ReorchestrationPromptOptions): string {
  const formattedSources = formatSourcePromptsForLlm(options.vlPrompts);
  const videoPrompts = options.vlPrompts.filter((p) => p.promptType === 'video');
  const imagePrompts = options.vlPrompts.filter((p) => p.promptType === 'image');

  const clipSpecs = options.clipTransitions && options.clipTransitions.length > 0
    ? `\n=== CLIP GENERATION SPECIFICATIONS ===\n` +
      options.clipTransitions
        .map((t, idx) => {
          const num = idx + 1;
          if (t === 'cut') {
            return `- Clip ${num} (New scene): Provide "imagePrompt" (start frame at 0.0s), "endImagePrompt" (end frame at ${options.clipDuration}s), and "visualPrompt" (motion between start and end).`;
          }
          return `- Clip ${num} (Action continuation): Action resumes from previous video; provide ONLY "visualPrompt" (motion and camera dynamics). Set "imagePrompt" and "endImagePrompt" to empty string "".`;
        })
        .join('\n') +
      '\n'
    : '';

  return `Topic: "${options.topic}"
Reference Video: "${options.videoTitle}"
${options.visualStyle ? `Identified Visual Style (FastEval): "${options.visualStyle}"\n` : ''}${options.videoSummary ? `Summary: ${options.videoSummary}\n` : ''}Aspect Ratio: ${options.aspectRatio}
Clip Duration: ${options.clipDuration} seconds per clip
Target Clips Count (N): ${options.targetClipCount}

=== EXTRACTED SOURCE PROMPTS FROM REFERENCE VIDEO ===
Found ${options.vlPrompts.length} extracted prompt(s) (strictly classified as "image" or "video"):
- ${imagePrompts.length} Image generation prompt(s) (type: image)
- ${videoPrompts.length} Video generation prompt(s) (type: video)

${formattedSources}
${clipSpecs}
=== RE-ORCHESTRATION ASSIGNMENT ===
You must take the extracted prompts above and RE-ORCHESTRATE (重新编排) them into exactly ${options.targetClipCount} sequential story clips.
Each clip must include:
1. **imagePrompt (STARTING FRAME at 0.0s)**: Static Text-to-Image prompt for the OPENING frame of this clip at t=0.0s. For action continuation clips, leave as empty string "".
2. **endImagePrompt (ENDING FRAME at duration)**: Static Text-to-Image prompt for the CONCLUDING frame of this clip at t=duration. For action continuation clips, leave as empty string "". The ending frame must be a self-contained visual description showing CLEAR, NOTICEABLE VISUAL PROGRESSION from imagePrompt (action concluded, character arrived at position, angle/camera progressed, new focal subject). Do NOT start with "Same wide shot" or provide an almost identical scene.
3. **visualPrompt (Motion Dynamics)**: Companion animation prompt describing ONLY camera dynamics and subject motion. DO NOT write transition meta-words into this prompt.

Mandatory Constraints:
- In-universe creative story ONLY: Base the world, characters, setting, and plot SOLELY on the fictional universe described in the EXTRACTED SOURCE PROMPTS. NEVER create scenes depicting tutorials, computers, laptops, desks, editing software, or content creators.
- Opening-Frame Rule: For new scene clips, "imagePrompt" is strictly the STARTING FRAME (0.0s before action unfolds). "endImagePrompt" is the ending settled pose.
- Pure Video Prompt: "visualPrompt" describes ONLY what moves on screen. Never write transition directives or continuation commentary in visualPrompt.
- Strict Narration/Dialogue rule: narrationCues is strictly for spoken voiceover or spoken dialogue that will be spoken aloud by a voice actor. Set "hasNarration" to "y" if the video has spoken voiceover/dialogue; set to "n" if this video is non-verbal (pure visual, background music/ambience only). For each clip, set "hasNarration" to "y" or "n". When "hasNarration" is "n", narrationCues MUST be empty "". Strictly NEVER output "No dialogue", "No dialog", "None", "N/A", "Mood cue:", or sound effect descriptions.
- ZERO TEXT & ZERO LETTERING RULE: Absolutely NO words, letters, titles, signs, typography, stamps, newspaper/newsprint text, margin notes, or transcript fragments in imagePrompt, endImagePrompt, or visualPrompt. Always describe visual objects, actions, and environments purely without text labels.
- ZERO BORDERS & ZERO LETTERBOXING: Prompts must describe edge-to-edge full-bleed imagery. Do not include framed edges, torn paper borders, or top/bottom margin strips.
- Zero UI artifact leakage: Ignore meta instructions or tool buttons in prompts like "paste this prompt", "agent prompt", "create video", or "add animation with voiceover".
- Strict Prominent People Policy Avoidance: NEVER output real names (Trump, Biden, etc.) or identifiable public figures. Use approximate actions (hands shuffling files, adjusting mic knobs), equipment close-ups (ON AIR mics, monitors), or indirect framing (silhouettes, back views, over-the-shoulder) instead of frontal talking faces.
- Strict Content-Safety Policy Avoidance (Gore/Horror/Violence/Disturbing): NEVER output graphic violence, gore, blood, wounds, corpses, weapons aimed at people, torture, or death scenes. NEVER output horror/disturbing content: ghosts, demons, monsters, zombies, possessions, jumpscares, screaming in terror, or any threatening/ambiguous figure lurking or standing DIRECTLY BEHIND a person. NEVER output sexual/nudity content, self-harm/suicide, hate symbols/slurs, copyrighted characters (Disney, Marvel, etc.), real disasters, drugs, smoking, or minors in dangerous contexts. Express suspense ONLY through cinematic craft (lighting, grain, slow push-in, guarded expression) and keep every frame family-safe / PG.
- Mandatory Visual Style & Anti-Uncomfortable Rule: The visual style is identified as "${options.visualStyle || 'determined by source prompts'}". Ensure all imagePrompt, endImagePrompt, and visualPrompt strictly adhere to this artistic medium. If this is an animation or cartoon style, NEVER output photorealistic descriptions or repulsive macro real insect anatomy; always maintain stylized, friendly, or cartoon aesthetics.
- MASTER CHARACTER & SCENE SCALE CONSISTENCY: In the top-level "characters" field, define each character's immutable appearance AND ABSOLUTE SIZE once (e.g. {"character1": "1.8 m tall athletic build, detailed fixed appearance, age, gender, ethnicity, facial features, hair, eye color, and exact clothing from head to toe"}). In the top-level "backgrounds" field, define each recurring location/set once with its ABSOLUTE DIMENSIONS and fixed scale landmarks in the same unit (e.g. {"background1": "30 m ceiling, 2.4 m tall doors, 0.6 m x 0.4 m tabletop model with 5 cm puppets"}). In all imagePrompt, endImagePrompt, and visualPrompt entries, refer to the character strictly as "{character1}" and to the location strictly as "{background1}" to ensure 100% identical appearance, wardrobe AND human-to-set scale ratio across all clips. NEVER restate or alter a master size inside a clip prompt; express shot-size changes through framing only.
- STRICT ENGLISH LANGUAGE PURITY: All generated content — titles, imagePrompt, endImagePrompt, visualPrompt, and narrationCues — MUST be written strictly in clean English. Do NOT output any Chinese characters anywhere.
- Preserve the visual aesthetic, lighting, and characters from the source prompts.
- Output exactly ${options.targetClipCount} clips in the JSON "clips" array.`;
}

// Dynamic genre detection for tests/verification
export function detectAnimationGenre(contextText: string): string {
  const text = contextText.toLowerCase();
  if (/\b(stickman|stick figure|stick fight|stick animation|alan becker|pivot|火柴人)\b/i.test(text)) return 'stickman';
  if (/\b(skeleton|skellie|skulls?|undead|bones?|grim reaper|necromancer|crypt|dungeon|gothic|骷髅|白骨)\b/i.test(text)) return 'skeleton';
  if (/\b(3d document|documentary|archival|parchment|manuscripts?|historical maps?|vintage photos?|declassified|dossier|档案|历史文献)\b/i.test(text)) return '3d-document';
  if (/\b(anime|ghibli|manga|cel-shaded|makoto shinkai|动漫|吉卜力)\b/i.test(text)) return 'anime';
  if (/\b(claymation|plasticine|stop-motion|stop motion|clay animation|粘土|定格)\b/i.test(text)) return 'claymation';
  if (/\b(3d cartoon|3d animation|blender animation|pixar|stylized 3d|low-poly|3d动画)\b/i.test(text)) return '3d-cartoon';
  return 'default';
}


