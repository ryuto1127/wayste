/**
 * Visual cue descriptions per Tier-1 class, used in the GPT
 * material-identification prompt (buildMaterialIdentificationPrompt).
 *
 * @legacy-cloud-path — the default kiosk never calls this; alive only behind NEXT_PUBLIC_CLOUD_FALLBACK=1 (pilot experiments)
 */
export const MATERIAL_VISUAL_CUES: Record<string, { material: string; cues: string }[]> = {
  bottle: [
    { material: "PET plastic", cues: "clear or colored, lightweight, crinkles when squeezed, recycling symbol ♳" },
    { material: "Glass", cues: "heavy, rigid, thick walls, slight color tint, smooth surface" },
    { material: "Aluminium metal", cues: "lightweight, pull-tab, printed graphics wrap around" },
    { material: "Steel metal", cues: "similar to aluminium, matte finish, may be magnetic" },
  ],
  cup: [
    { material: "Paper with plastic lining", cues: "lightweight, printed cardboard, waxy interior" },
    { material: "Clear plastic", cues: "transparent, thin-walled, may have a recycling number on bottom" },
    { material: "Styrofoam/EPS", cues: "white, porous, very lightweight, squeaks when rubbed" },
    { material: "Ceramic", cues: "heavy, opaque, often has a handle, glazed surface" },
  ],
  bowl: [
    { material: "Plastic", cues: "lightweight, may be transparent or colored, flexible" },
    { material: "Ceramic or glass", cues: "heavy, rigid, smooth glazed surface" },
    { material: "Paper", cues: "lightweight, flexible, may be wax-coated" },
  ],
  fork: [
    { material: "Metal", cues: "reflective, heavy, rigid, may have decorative pattern" },
    { material: "Plastic", cues: "lightweight, often white/clear/colored, may be flimsy" },
    { material: "Wood or bamboo", cues: "natural grain, light brown, lightweight" },
  ],
  knife: [
    { material: "Metal", cues: "reflective, heavy, rigid, may have decorative pattern" },
    { material: "Plastic", cues: "lightweight, often white/clear/colored, may be flimsy" },
    { material: "Wood or bamboo", cues: "natural grain, light brown, lightweight" },
  ],
  spoon: [
    { material: "Metal", cues: "reflective, heavy, rigid, may have decorative pattern" },
    { material: "Plastic", cues: "lightweight, often white/clear/colored, may be flimsy" },
    { material: "Wood or bamboo", cues: "natural grain, light brown, lightweight" },
  ],
  "wine glass": [
    { material: "Glass", cues: "clear, thin, fragile, may have a stem" },
    { material: "Plastic/acrylic", cues: "lighter, less fragile, may be slightly cloudy" },
  ],
};
