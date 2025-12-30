import * as THREE from 'three';
import { SceneManager } from './scene.js';
import { Controls } from './controls.js';
import { PostProcessing } from './postprocessing.js';

const SHARE_PROMPT = `
You are given a mobile-focused 3D grass/terrain demo built with Three.js (via ESM import maps) that simulates an "RTX-style" look using postprocessing and custom shaders. The experience must remain responsive on mobile (no scrolling, full-viewport canvas) and uses WASD + mouse on desktop plus nipple.js joysticks for touch.

High-level architecture:
- index.html sets up a full-screen canvas, basic HUD (title, FPS counter, RTX and wind toggles, joystick zones), and loads js/main.js as a module. It uses an import map that exposes:
  - "three" and "three/addons/*" from esm.sh
  - "nipplejs" for touch joystick control
  - "simplex-noise" for procedural terrain
- css/style.css styles a dark minimal UI with a header, glassy toggle chips, joystick zones, and small instruction text. The canvas fully covers the viewport and the UI is pointer-events:none except for controls and joystick zones.

Rendering pipeline (no real hardware RTX; it's WebGL-based with a fake "RTX" mode):
- js/main.js creates a THREE.WebGLRenderer and attaches it to a dynamically created canvas appended to <body>. It:
  - Configures renderer with shadowMap (PCFSoft), ACESFilmic tone mapping, and exposure.
  - Creates a SceneManager (js/scene.js), obtains its PerspectiveCamera, and wraps that camera in a Controls instance (js/controls.js).
  - Creates a PostProcessing pipeline (js/postprocessing.js) for the "RTX mode", passing renderer, scene, and camera.
  - Manages app state (rtxEnabled, windEnabled, canvas size) and DOM bindings for RTX toggle, wind toggle, FPS display, and the loader.
  - Sets up a looping wind_ambience.mp3 via THREE.Audio/AudioLoader attached to the camera's AudioListener, gated by the wind toggle.
  - Handles resize: updates camera aspect/projection, renderer size, and composer size.
  - Game loop (animate):
    - Computes delta time and a basic FPS counter.
    - Calls controls.update(delta) for camera movement.
    - Calls sceneManager.update(timeSeconds, delta, rtxEnabled) every frame.
    - If RTX mode is ON: postProcessing.render() renders through the composer (SSAOPass + Bloom + Bokeh + Output).
      Otherwise: renderer.render(sceneManager.scene, camera) is used directly.

Scene and lighting:
- js/scene.js defines SceneManager, which owns:
  - THREE.Scene with FogExp2 and background color (dark gray).
  - A PerspectiveCamera (60° FOV, near=0.1, far=100) initially at (0, 2, 5). Height is then constrained by terrain via Controls.
  - TerrainChunk instance (js/terrain.js) representing a single 100x100 plane, deformed into hills with simplex noise.
  - GrassSystem instance (js/grass.js), an InstancedMesh-based dense grass field.
- Lighting:
  - AmbientLight at low intensity for base fill.
  - A primary DirectionalLight (sunLight) with warm color, shadow casting enabled (shadow camera configured for a 100x100-ish area). Shadow map size and bias are adjusted depending on RTX mode.
  - A secondary cool directional "rim" light for subtle color contrast.
- SceneManager.init():
  - Constructs a TerrainChunk(size=100, resolution=64), awaits its generate() (synchronous but wrapped in async) and adds terrain.mesh to the scene.
  - Constructs GrassSystem(terrain, 40000) (40k instances) and adds its mesh.
- SceneManager.update(time, delta, rtxEnabled):
  - Forwards time and sun light position to GrassSystem.update, as well as the RTX flag (for potential shader changes).
- SceneManager.setRTXMode(enabled):
  - When enabled: increases sunLight intensity, reduces fog density, increases shadow resolution and tightens shadow bias.
  - When disabled: restores more moderate settings.
  - Forces a shadow map refresh by disposing the existing shadow map.
- SceneManager.setWind(strength) forwards to grass.setWindStrength.

Terrain generation and baked lighting:
- js/terrain.js defines TerrainChunk:
  - Constructor takes size and resolution; it holds geometry, mesh, heightData, and a simplex-noise 2D generator.
  - _computeHeight(x, z) uses a few octaves of simplex noise at different frequencies and amplitudes to yield a moderate-height terrain (simple rolling hills).
  - generate():
    - Builds a PlaneGeometry(size, size, resolution, resolution), rotates it to lie flat (rotateX(-PI/2)).
    - For each vertex, computes y via _computeHeight and stores it back to the position attribute; also stores y in heightData.
    - Computes vertex normals.
    - Computes a "baked" color for each vertex:
      - Samples the vertex normal and dot with up (0,1,0) to detect slope.
      - Uses vertex height to derive a heightFactor, then computes something like an AO factor.
      - Derives a baseColor (greenish for grass) and rockColor (brownish), and lerps between them based on slope to simulate grass vs rock.
      - Stores these colors in a 'color' attribute (Float32BufferAttribute).
    - Generates a high-frequency HD soil texture via _generateSoilTexture():
      - Creates a 512x512 RGBA DataTexture where each pixel is brownish with variation from sin/cos-based pseudo-noise and Math.random.
      - Configures wrapping to Repeat, repeat=10x10, anisotropy=16, then marks needsUpdate=true.
    - Generates a corresponding pseudo-normal map from that texture via _generateNormalMap():
      - Treats diffuse red channel as a height field, samples left/right/top/bottom per pixel, computes dx, dy, converts to a normal (nx, ny, nz), and encodes as RGB.
      - Wraps edges, repeats UVs like the diffuse map.
    - Creates a MeshStandardMaterial using map=soil texture, normalMap=generated normal map, high roughness, low metalness, with flatShading=false.
    - Creates terrain.mesh = new THREE.Mesh(geometry, material), enabling both receiveShadow and castShadow (for visual richness).
  - getHeightAt(x, z) just calls _computeHeight with the same noise functions; camera collision uses this instead of sampling the mesh.

Grass rendering and faux RTX-style shading:
- js/grass.js defines GrassSystem:
  - Uses a single PlaneGeometry(0.15, 1.0, 1, 4) translated upward so the pivot is at the base of the blade.
  - Creates a ShaderMaterial with:
    - vertexShader: bends grass blades using a layered procedural wind function based on time, instance position (x,z) from instanceMatrix, and per-vertex UV.y. It:
      - Applies a height-dependent lateral offset and slight z wobble.
      - Adjusts y slightly to keep an arc-like curvature.
      - Computes an approximate bent normal.
      - Outputs vWorldPosition, vViewPosition, vNormal, vUv, and per-instance color.
    - fragmentShader:
      - Discards pixels outside a custom blade shape (tapered tip) using the x UV.
      - Builds a gradient from darker roots to brighter tips using vUv.y.
      - Does a stylized PBR-ish lighting:
        - Wrap diffuse (half-Lambert) using N·L.
        - Specular highlight using Blinn–Phong (N·H)^32.
        - A back-lit translucency term (fake SSS) based on light vs view direction and blade height.
        - A simple AO factor along blade height for darker base.
      - Combines base color, SSS glow, and specular, then outputs finalColor.
    - Uniforms: time, windStrength, sunPosition, rtxEnabled (rtxEnabled is set but not currently branching in shader logic).
    - DoubleSide, opaque.
  - Creates an InstancedMesh(geometry, material, count).
  - populate():
    - Uses a THREE.Raycaster pointing down from y=20 to the terrain mesh to find the exact y and normal for each instance's (x,z).
    - Only places grass where terrain normal.y >= 0.7 (not too steep); otherwise sets scale 0 to effectively hide the blade.
    - Randomizes rotation and scale per instance, and sets per-instance colors via HSL (different greens).
    - Writes scales to an InstancedBufferAttribute('scale') and RGB colors to 'instanceColor'.
  - update(time, sunPos, rtx):
    - Updates shader uniforms: time, windStrength, sunPosition, and rtxEnabled.
- GrassSystem.setWindStrength(val) is called from SceneManager.setWind and from the wind toggle in main.js.

Controls and movement:
- js/controls.js defines Controls:
  - Holds a reference to the camera and sceneManager (for height queries) plus movement/rotation state.
  - Uses nipple.js to create a static joystick on the left side (#zone-joystick). The joystick's vector.x and vector.y drive moveVector.x (strafe) and moveVector.z (forward/back).
  - Implements touch-look in #zone-look:
    - touchstart/touchmove/touchend track deltas and apply yaw/pitch to rotationVector.
    - Clamps pitch to [-PI/3, +PI/3] to avoid flipping.
  - Implements desktop mouse-look when mousedown occurs on the right half of the screen.
  - Implements keyboard WASD to modify moveVector.x/z for desktop.
  - update(delta):
    - Builds a yaw quaternion (Y axis) and pitch (X axis), multiplies them to get the camera quaternion.
    - Applies movement in camera-space using the yaw only (no flying).
    - Queries terrain height via sceneManager.terrain.getHeightAt(camera.position.x, camera.position.z), sets a targetY = terrainHeight + 1.7 (approx. human eye height), and smoothly interpolates camera.position.y toward that target while clamping so the camera never clips below the ground.

Postprocessing and "RTX mode":
- js/postprocessing.js defines PostProcessing:
  - Creates an EffectComposer with:
    - RenderPass(scene, camera) as base.
    - SSAOPass(scene, camera, width, height) to approximate ambient occlusion; kernelRadius, minDistance, and maxDistance tuned for terrain.
    - UnrealBloomPass for subtle HDR bloom (strength/threshold/radius tuned).
    - BokehPass (Depth of Field) to create a slight focal depth on the terrain.
    - OutputPass for tone-mapped final output.
  - setSize(width, height) updates composer and SSAO resolution.
  - render() calls composer.render().
  - setRTX(enabled) adjusts SSAO kernelRadius and bloom strength/radius to make lighting more dramatic when RTX mode is ON.
- In main.js:
  - When RTX toggle is ON, state.rtxEnabled is true, SceneManager.setRTXMode(true) is called, PostProcessing.setRTX(true) is called, and rendering uses composer.
  - When OFF, it falls back to a single direct renderer.render() pass.

UI and toggles:
- RTX toggle (#rtx-toggle):
  - Changes state.rtxEnabled, updates label text and color, and calls sceneManager.setRTXMode + postProcessing.setRTX.
- WIND toggle (#wind-toggle):
  - Enables/disables audio playback for wind_ambience.mp3 and calls sceneManager.setWind(1.0 or 0.0), which adjust grass shader windStrength.
- Loader (#loader):
  - Visible while SceneManager.init() generates terrain and grass; fades out once initialization completes.

Important constraints for any modifications you make:
- Keep imports using the existing import map (three, three/addons, nipplejs, simplex-noise from esm.sh).
- Do not introduce bundlers or Node-specific APIs; this must run as vanilla ES modules in the browser.
- Preserve mobile-first design: full-viewport canvas, no scrolling, joystick-based movement, and minimal extra HUD elements.
- Preserve the RTX toggle semantics: "RTX ON" must mean using the postprocessing pipeline (composer) with enhanced SSAO/bloom and adjusted lighting/fog; "RTX OFF" must mean direct renderer rendering with less intense effects.
- Preserve the overall grass/terrain look: procedural terrain via simplex-noise, dense instanced grass with wind animation, HD soil texture with generated normal map, and baked-looking shading from the existing shaders and postprocessing.
`;


// Application State
const state = {
    rtxEnabled: false,
    windEnabled: true,
    width: window.innerWidth,
    height: window.innerHeight
};

// DOM Elements
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const loadingScreen = document.getElementById('loader');
const fpsCounter = document.getElementById('fps');
const rtxToggle = document.getElementById('rtx-toggle');
const rtxStatus = document.getElementById('rtx-status');
const windToggle = document.getElementById('wind-toggle');
const copyPromptButton = document.getElementById('copy-prompt-button');

// Initialize Three.js
const renderer = new THREE.WebGLRenderer({ 
    canvas, 
    antialias: false, // AA handled by post-proc or disabled for perf
    powerPreference: "high-performance",
    stencil: false,
    depth: true
});
renderer.setSize(state.width, state.height);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// Managers
const sceneManager = new SceneManager(renderer);
const camera = sceneManager.camera;
const controls = new Controls(camera, document.body, sceneManager);
const postProcessing = new PostProcessing(renderer, sceneManager.scene, camera, state.width, state.height);

// Audio
const audioListener = new THREE.AudioListener();
camera.add(audioListener);
const windSound = new THREE.Audio(audioListener);
const audioLoader = new THREE.AudioLoader();

// Load Audio
audioLoader.load('wind_ambience.mp3', function(buffer) {
    windSound.setBuffer(buffer);
    windSound.setLoop(true);
    windSound.setVolume(0.5);
    if(state.windEnabled) windSound.play();
});

// Event Listeners
window.addEventListener('resize', onWindowResize, false);

rtxToggle.addEventListener('change', (e) => {
    state.rtxEnabled = e.target.checked;
    rtxStatus.innerText = state.rtxEnabled ? "ON" : "OFF";
    rtxStatus.style.color = state.rtxEnabled ? "var(--accent)" : "#aaa";
    sceneManager.setRTXMode(state.rtxEnabled);
    postProcessing.setRTX(state.rtxEnabled);
});

// Wind on/off
windToggle.addEventListener('change', (e) => {
    state.windEnabled = e.target.checked;
    if(state.windEnabled) {
        if(!windSound.isPlaying) windSound.play();
        sceneManager.setWind(1.0);
    } else {
        if(windSound.isPlaying) windSound.pause();
        sceneManager.setWind(0.0);
    }
});

// Copy explanation prompt to clipboard
if (copyPromptButton && navigator.clipboard) {
    copyPromptButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(SHARE_PROMPT.trim());
            copyPromptButton.textContent = 'Copied';
            setTimeout(() => {
                copyPromptButton.textContent = 'Copy prompt';
            }, 1500);
        } catch (err) {
            console.error('Clipboard copy failed', err);
        }
    });
}

// Resize Handler
function onWindowResize() {
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    
    camera.aspect = state.width / state.height;
    camera.updateProjectionMatrix();
    
    renderer.setSize(state.width, state.height);
    postProcessing.setSize(state.width, state.height);
}

// Main Loop
let lastTime = 0;
let frameCount = 0;
let lastFpsTime = 0;

function animate(time) {
    requestAnimationFrame(animate);
    
    const delta = (time - lastTime) / 1000;
    lastTime = time;

    // FPS Counter
    frameCount++;
    if (time - lastFpsTime >= 1000) {
        fpsCounter.innerText = `${frameCount} FPS`;
        frameCount = 0;
        lastFpsTime = time;
    }

    // Logic
    controls.update(delta);
    sceneManager.update(time / 1000, delta, state.rtxEnabled); 

    // Render
    if (state.rtxEnabled) {
        postProcessing.render();
    } else {
        renderer.render(sceneManager.scene, camera);
    }
}

// Start
sceneManager.init().then(() => {
    loadingScreen.style.opacity = '0';
    setTimeout(() => {
        loadingScreen.style.display = 'none';
    }, 500);
    
    // Initial resize to ensure everything fits
    onWindowResize();
    
    // Start loop
    animate(0);
});

