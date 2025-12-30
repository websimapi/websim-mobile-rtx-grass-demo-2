const SHARE_PROMPT = `
You are given a mobile-focused 3D grass/terrain demo originally built with Three.js (via ESM import maps) that simulated an "RTX-style" look using postprocessing and custom shaders. The UI was mobile-first (full-viewport, no scrolling) and provided a single full-screen canvas plus a thin HUD with toggles and joystick zones.

Key concepts you should preserve or understand if asked to recreate or extend it:

- Rendering stack:
  - Used THREE.WebGLRenderer directly in the browser (no bundler), with ACESFilmic tone mapping and soft shadows.
  - A SceneManager owned the THREE.Scene and a PerspectiveCamera and set up fog, lights, terrain, and grass.
  - "RTX mode" was a WebGL-level postprocessing pipeline, not hardware ray tracing. It relied on:
    - SSAOPass for contact shadows/ambient occlusion.
    - UnrealBloomPass for HDR-style glow on bright highlights.
    - Optional BokehPass for subtle depth of field on the terrain.
    - OutputPass for final tone-mapped output.
  - When RTX was OFF it rendered with a single renderer.render(scene, camera) call; when ON it rendered through EffectComposer with stronger SSAO and bloom plus tweaked light/fog settings.

- Terrain:
  - Generated from a single PlaneGeometry (size ≈100, resolution ≈64) rotated flat and deformed with a few octaves of simplex noise.
  - Vertex normals were computed for proper lighting.
  - "Baked lighting" was approximated by per-vertex colors based on:
    - Surface slope (normal·up) to distinguish grass vs rock.
    - Height-based darkening to mimic occlusion in low areas.
  - A high-detail soil texture was generated procedurally:
    - 512x512 DataTexture with brown hues and fine variation from sin/cos-based pseudo-noise and random jitter.
    - A normal map was synthesized from that diffuse data by treating the red channel as height, sampling neighbors, computing a normal, and encoding to RGB.
  - A MeshStandardMaterial used this soil map + normalMap with high roughness and low metalness; the terrain mesh both received and cast shadows.

- Grass:
  - Implemented as a dense InstancedMesh of simple vertical planes representing blades.
  - Each instance used:
    - A shared PlaneGeometry (≈0.15 wide, 1.0 tall, a few vertical segments) with pivot at the root.
    - Per-instance attributes for scale and color (greens with subtle HSL jitter).
  - Placement:
    - Random (x,z) within terrain bounds; a Raycaster shot downward onto the terrain mesh to get accurate ground y and surface normal.
    - Blades were omitted (scale 0) on steep slopes by checking normal.y to avoid grass on rock.
  - Shading & wind:
    - Custom vertex shader bent blades based on time, instance position, and UV.y to create layered wind waves, plus small z wobble and curvature preservation.
    - It output bent positions, approximated normals, world/view positions, and UVs.
    - The fragment shader:
      - Discarded pixels outside a tapered blade shape (using UV.x).
      - Built a vertical gradient from dark roots to brighter tips.
      - Applied stylized lighting: wrap diffuse, Blinn–Phong specular, a back-lit translucency term (fake SSS), and simple height-based ambient occlusion.
    - A uniform windStrength controlled animation intensity.

- Controls & camera:
  - Camera: Perspective with ~60° FOV, near=0.1, far≈100, initially a bit above ground.
  - Movement:
    - Desktop: WASD for movement, mouse drag on the right half of the screen for look.
    - Mobile: nipple.js joystick in a left-side zone for movement and touch drag in a right-side look zone for yaw/pitch.
  - The controller accumulated yaw/pitch, clamped vertical look to avoid flipping, built a quaternion from yaw + pitch, and applied that to the camera.
  - Ground collision:
    - Each frame it queried terrain height via the same noise function used to build the mesh (getHeightAt(x,z)).
    - It set a target eye height as terrainHeight + 1.7 and smoothly interpolated camera.position.y toward that, clamping so the camera never clipped below the ground.

- Lighting:
  - Low-intensity white AmbientLight for base fill.
  - Main warm DirectionalLight ("sun") with shadow casting and tuned shadow camera/frustum to cover the terrain; shadow map size and bias changed with RTX mode for quality/performance.
  - Secondary cool rim DirectionalLight for color contrast.
  - FogExp2 with darker background to give depth and atmospheric look; fog density was reduced in RTX mode.

- RTX mode semantics:
  - A UI toggle flipped a boolean state.
  - When enabled: increased sun intensity, reduced fog density, higher-res shadows, stronger SSAO + bloom in the postprocessing pipeline, and rendering via EffectComposer.
  - When disabled: restored milder lighting/shadows, smaller SSAO kernel/bloom strength, and used direct renderer.render.
  - Grass shaders received a uniform rtxEnabled flag (exposed for possible branching), while windStrength was separately controlled by a "Wind" toggle.

- Audio:
  - A single looping wind_ambience.mp3 ambient sound was loaded with THREE.Audio/AudioLoader, attached to the camera's AudioListener.
  - A "Wind" toggle controlled both shader windStrength and whether the wind audio played.

- UI & structure:
  - The HTML page used an import map to pull "three", "three/addons/*", "nipplejs", and "simplex-noise" from esm.sh, no bundler or Node APIs.
  - The canvas filled the viewport; the overlay UI had:
    - A small header with a title, FPS counter, and a "Copy prompt" button.
    - A right-side glassy chip group for RTX and Wind toggles.
    - Invisible joystick/look zones for mobile input and a little on-screen hint for controls.
  - A loader overlay displayed "Generating Terrain & Baking Lighting..." while the terrain and grass were set up.

Your job, given this description, is to reproduce, adapt, or extend a similar mobile-first Three.js experience that:
- Uses ES modules via import maps (no bundler).
- Maintains a full-viewport canvas without scrolling.
- Provides joystick and mouse/touch controls.
- Simulates an "RTX" mode using postprocessing, SSAO, bloom, and tuned lights/fog, without requiring hardware ray tracing or WebGPU.
`;

const copyButton = document.getElementById('copy-prompt-button');
const statusEl = document.getElementById('copy-status');

if (copyButton) {
    copyButton.addEventListener('click', async () => {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
            statusEl.textContent = 'Clipboard not available in this browser.';
            return;
        }

        try {
            await navigator.clipboard.writeText(SHARE_PROMPT.trim());
            statusEl.textContent = 'Prompt copied to clipboard. You can now paste it into another model.';
        } catch (err) {
            console.error('Clipboard copy failed', err);
            statusEl.textContent = 'Failed to copy. Please try again.';
        }
    });
}