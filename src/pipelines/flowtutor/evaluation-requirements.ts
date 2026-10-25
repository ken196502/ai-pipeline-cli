import { formatEvaluationRequirements, type EvaluationRequirements } from '../../research/index.js';

export const FLOW_TUTOR_EVALUATION_REQUIREMENTS: EvaluationRequirements = {
  pipelineId: 'flowTutor',
  coreObjective:
    'Evaluate video candidates for OUTSTANDING CREATIVE ENTERTAINMENT, DISTINCTIVE VISUAL STYLIST FLAIR, TOPIC UNIQUENESS & BLUE-OCEAN DIFFERENTIATION, DETAILED GENERATION GUIDANCE, RICH STORY SCRIPTS, CHARISMATIC CHARACTERS, AND HIGH GENERATIVE PROMPT RE-CREATIVITY.',
  requiredDimensions: [
    {
      name: 'Detailed Generation Guidance & Actionable Instructions',
      description:
        'Does the video provide clear, detailed, and actionable instructions, exact prompts (image prompts, video motion directives), parameters, or step-by-step guidance that allow viewers to reproduce the video using generative AI tools?',
      priority: 'critical',
      scoringGuidelines: {
        high: 'Displays or narrates exact, high-quality AI prompts, parameters, and actionable reproduction steps clearly legible and ready for prompt extraction.',
        low: 'Zero prompts, vague superficial mentions of software tools, or abstract concepts with no actionable instructions or prompts.',
      },
    },
    {
      name: 'Visual Stylist & Aesthetic Boldness (Distinctive Style & Visual Identity)',
      description:
        'Does the video exhibit a bold, unmistakable visual art style (e.g. cyberpunk neon noir, retro 70s/80s dark fantasy, anime / graphic novel, claymation, surreal humor, high-octane 3D stylized animation, vintage film grain, baroque gothic, or vibrant pop art) rather than generic, bland AI stock realism? A striking aesthetic identity that immediately commands viewer attention.',
      priority: 'critical',
      scoringGuidelines: {
        high: 'Striking, unmistakable visual identity and cohesive artistic style that immediately commands attention and stands out from generic AI content.',
        low: 'Bland, muddy stock realism with no artistic vision, or generic computer UI screencasts with no aesthetic identity.',
      },
    },
    {
      name: 'Stories, Narrative Hooks & Engaging Mini-Arcs (Story Script & Staging)',
      description:
        'Does the video tell a compelling story and provide a structured story script, scene-by-scene storyboard, dialogue/narration cues, or engaging micro-narrative arc with a relentless 0-3 second hook, clear narrative momentum, escalating stakes, and satisfying resolution?',
      priority: 'critical',
      scoringGuidelines: {
        high: 'Cohesive story arc, escalating stakes/twists, well-defined scene progression, scripted cues, and structured narrative ready for multi-clip video generation.',
        low: 'Completely lacking story or narrative structure, random disconnected B-roll or slides without any plot or character arc.',
      },
    },
    {
      name: 'Prompts Craft & Cinematic Re-creativity (Camera Choreography & Motion)',
      description:
        'Does the video contain rich, concrete, descriptive visual scenes with tangible physical actions, specific camera dynamics (slow tracking dolly, low-angle orbital pan, heroic crane reveal, whip pan), atmospheric lighting (golden hour haze, volumetric god rays, neon rim lighting), and environmental depth that translate seamlessly into high-fidelity generative AI video prompts?',
      priority: 'high',
      scoringGuidelines: {
        high: 'Tangible physical actions, specific camera dynamics, rich atmospheric lighting, and environmental depth easily translatable to AI video prompts.',
        low: 'Static motionless scenes, PowerPoint slides, webcam talking heads, or UI software screen recordings.',
      },
    },
    {
      name: 'Character Design, Charisma & Expressive Personality',
      description:
        'Does the video feature memorable, charismatic, quirky, or iconic characters (heroes, quirky creatures, expressive figures, anthropomorphic personas) with emotive facial expressions, distinct physical traits, strong personality quirks, and clear character motivations?',
      priority: 'high',
      scoringGuidelines: {
        high: 'Emotive, highly expressive character designs with distinct visual traits and strong charisma.',
        low: 'Lifeless avatars, generic robotic figures, or faceless stock subjects.',
      },
    },
    {
      name: 'Topic Uniqueness & Blue-Ocean Differentiation',
      description:
        'Does the video occupy a genuinely differentiated niche instead of riding the most saturated trend? Consider topic novelty, homogeneity/crowding of the niche, whether the angle or presentation has its own recognizable identity, and how much blue-ocean differentiation room remains after replication. Popularity alone must NOT substitute for uniqueness.',
      priority: 'high',
      scoringGuidelines: {
        high: 'Distinctive niche or fresh angle with low homogeneity, own recognizable identity, and clear blue-ocean differentiation room after replication.',
        low: 'Copycat riding the most crowded trend, indistinguishable from mass-produced content in the same niche, or pure popularity-chasing with zero differentiation.',
      },
    },
    {
      name: 'Fun, Humor, Wonder & Entertainment Delight',
      description:
        'Is the video genuinely fun, hilarious, delightful, absurd, mind-bending, or awe-inspiring, with high entertainment value, comedy, shocking plot twists, imaginative charm, or creative energy compelling viewers to laugh, rewatch, and share?',
      priority: 'high',
      scoringGuidelines: {
        high: 'Immediate 0-3 second hook, captivating pacing, humor/wonder/energy that compels viewers to watch until the end and share.',
        low: 'Dull, monotonous narration, slow pacing, zero emotional or creative engagement.',
      },
    },
  ],
  targetTraits: [
    'Clear, detailed, and actionable generation guidance with visible prompts and tool settings',
    'Bold, distinctive aesthetic style and unmistakable visual identity (never bland stock AI)',
    'Structured story script, narrative beats, or scene-by-scene storyboard',
    'Rich cinematic camera movements and physical character actions',
    'Memorable character design, charisma, and emotive expression',
    'High entertainment value, humor, wonder, and audience retention hooks',
    'Topic uniqueness and blue-ocean differentiation room, not merely the loudest trend',
  ],
  negativeFilters: [
    'Dry how-to lectures, desktop screen captures of software UI without creative scenes, or PowerPoint-like slides',
    'Talking-head webcam monologues with zero story, zero character, zero fun, and no stylistic vision',
    'Bland, generic AI stock realism with zero artistic vision or unique style',
    'Videos lacking any actionable prompts, script, or creation guidance',
    'Homogeneous copycat topics that only chase the most saturated viral trend with no differentiation angle',
  ],
};

export const DEFAULT_FLOW_TUTOR_EVALUATION_FOCUS = formatEvaluationRequirements(FLOW_TUTOR_EVALUATION_REQUIREMENTS);

export const FLOW_TUTOR_EVALUATION_FOCUS = DEFAULT_FLOW_TUTOR_EVALUATION_FOCUS;
