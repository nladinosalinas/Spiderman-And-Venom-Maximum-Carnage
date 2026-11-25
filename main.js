const canvas = document.getElementById("gameCanvas");
const webglContextOptions = { alpha: false, antialias: false };
const gl = canvas.getContext("webgl", webglContextOptions)
  || canvas.getContext("experimental-webgl", webglContextOptions);
if (!gl) throw new Error("No se pudo inicializar WebGL 1 en gameCanvas.");

const statusOverlay = document.createElement("canvas");
statusOverlay.width = canvas.width;
statusOverlay.height = canvas.height;
statusOverlay.style.position = "fixed";
statusOverlay.style.pointerEvents = "none";
statusOverlay.style.imageRendering = "crisp-edges";
statusOverlay.style.imageRendering = "pixelated";
statusOverlay.style.zIndex = "10";
document.body.appendChild(statusOverlay);
const statusOverlayContext = statusOverlay.getContext("2d");
function positionStatusOverlay() {
  const rect = canvas.getBoundingClientRect();
  statusOverlay.style.left = `${rect.left}px`;
  statusOverlay.style.top = `${rect.top}px`;
  statusOverlay.style.width = `${rect.width}px`;
  statusOverlay.style.height = `${rect.height}px`;
}
positionStatusOverlay();
window.addEventListener("resize", positionStatusOverlay);
window.addEventListener("scroll", positionStatusOverlay, { passive: true });
if (typeof ResizeObserver !== "undefined") {
  const statusOverlayResizeObserver = new ResizeObserver(positionStatusOverlay);
  statusOverlayResizeObserver.observe(canvas);
}

function drawCenteredOverlayMessage(message, color = "#f5d130") {
  const context = statusOverlayContext;
  if (!context) return;
  context.clearRect(0, 0, statusOverlay.width, statusOverlay.height);
  context.fillStyle = "rgba(5, 6, 12, 0.92)";
  context.fillRect(0, 0, statusOverlay.width, statusOverlay.height);
  context.imageSmoothingEnabled = false;
  context.textAlign = "center";
  context.textBaseline = "middle";

  const fontSize = Math.max(7, Math.min(9, Math.floor(canvas.width / 36)));
  const maxWidth = canvas.width - 24;
  const lineHeight = fontSize + 4;
  const lines = [];
  context.font = `bold ${fontSize}px monospace`;
  for (const paragraph of String(message).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }

  const firstY = (canvas.height - (lines.length - 1) * lineHeight) / 2;
  context.lineWidth = 2;
  context.strokeStyle = "#050508";
  context.fillStyle = color;
  lines.forEach((line, index) => {
    const y = firstY + index * lineHeight;
    context.strokeText(line, canvas.width / 2, y, maxWidth);
    context.fillText(line, canvas.width / 2, y, maxWidth);
  });
}

// Activar transparencia para los sprites
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// 1. Shaders en GLSL
const vsSource = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  uniform vec2 u_resolution;
  uniform float u_yOffset;
  varying vec2 v_texCoord;
  void main() {
    vec2 zeroToOne = (a_position + vec2(0.0, u_yOffset)) / u_resolution;
    vec2 zeroToTwo = zeroToOne * 2.0;
    vec2 clipSpace = zeroToTwo - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
    v_texCoord = a_texCoord;
  }
`;

const fsSource = `
  precision mediump float;
  uniform sampler2D u_image;
  uniform int u_useColor;
  uniform vec4 u_color;
  varying vec2 v_texCoord;
  void main() {
    if (u_useColor == 1) {
      gl_FragColor = u_color;
    } else {
      vec4 color = texture2D(u_image, v_texCoord);
      if (color.a < 0.1) discard;
      gl_FragColor = color;
    }
  }
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("No se pudo crear un shader WebGL.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const details = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Error al compilar shader WebGL: ${details}`);
  }
  return shader;
}

const program = gl.createProgram();
if (!program) throw new Error("No se pudo crear el programa WebGL.");
gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vsSource));
gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(`Error al enlazar el programa WebGL: ${gl.getProgramInfoLog(program)}`);
}
gl.useProgram(program);

const posLocation = gl.getAttribLocation(program, "a_position");
const texLocation = gl.getAttribLocation(program, "a_texCoord");
const resLocation = gl.getUniformLocation(program, "u_resolution");
const yOffsetLocation = gl.getUniformLocation(program, "u_yOffset");
const useColorLocation = gl.getUniformLocation(program, "u_useColor");
const colorLocation = gl.getUniformLocation(program, "u_color");

const posBuffer = gl.createBuffer();
const texBuffer = gl.createBuffer();
const quadPositions = new Float32Array(12);
const quadTexCoords = new Float32Array(12);
gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
gl.bufferData(gl.ARRAY_BUFFER, quadPositions.byteLength, gl.DYNAMIC_DRAW);
gl.enableVertexAttribArray(posLocation);
gl.vertexAttribPointer(posLocation, 2, gl.FLOAT, false, 0, 0);
gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
gl.bufferData(gl.ARRAY_BUFFER, quadTexCoords.byteLength, gl.DYNAMIC_DRAW);
gl.enableVertexAttribArray(texLocation);
gl.vertexAttribPointer(texLocation, 2, gl.FLOAT, false, 0, 0);

// 2. Sistema de Entrada (Teclado)
const keys = {};
const justPressed = {};
const justPressedHorizontal = { left: false, right: false };
const physicalKeys = new Set();
const virtualKeyHolds = new Map();
const preventDefaultKeys = new Set([
  "Tab", "F1", "F2", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"
]);
let sfxAudioContext = null;
function ensureSFXAudioContext() {
  if (!sfxAudioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      sfxAudioContext = new AudioContextClass();
    } catch (error) {
      return null;
    }
  }
  if (sfxAudioContext.state === "suspended") {
    try {
      const resumePromise = sfxAudioContext.resume();
      if (resumePromise && typeof resumePromise.catch === "function") resumePromise.catch(() => {});
    } catch (error) {
      return null;
    }
  }
  return sfxAudioContext;
}
window.addEventListener("pointerdown", ensureSFXAudioContext, { passive: true });
function playSFX(type) {
  const audio = ensureSFXAudioContext();
  if (!audio) return;
  const now = audio.currentTime;
  const tone = (wave, startHz, endHz, duration, delay = 0, volume = 0.12) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const start = now + delay;
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(startHz, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + Math.min(0.008, duration * 0.15));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  };

  if (type === "punch") tone("square", 180, 65, 0.07, 0, 0.1);
  else if (type === "web") tone("triangle", 780, 320, 0.11, 0, 0.1);
  else if (type === "slam") tone("sawtooth", 110, 32, 0.24, 0, 0.15);
  else if (type === "hurt") tone("square", 140, 50, 0.15, 0, 0.1);
  else if (type === "transform") {
    tone("sawtooth", 65, 260, 0.19, 0, 0.1);
    tone("triangle", 95, 520, 0.16, 0.19, 0.1);
  } else if (type === "go") {
    tone("square", 523, 523, 0.1, 0, 0.08);
    tone("square", 784, 784, 0.16, 0.11, 0.08);
  }
}
window.addEventListener("keydown", (e) => {
  if (preventDefaultKeys.has(e.code)) e.preventDefault();
  ensureSFXAudioContext();
  if (!keys[e.code]) {
    justPressed[e.code] = true;

    if ((e.code === "ArrowLeft" || e.code === "KeyA") && !keys["ArrowLeft"] && !keys["KeyA"]) {
      justPressedHorizontal.left = true;
    }
    if ((e.code === "ArrowRight" || e.code === "KeyD") && !keys["ArrowRight"] && !keys["KeyD"]) {
      justPressedHorizontal.right = true;
    }
  }
  physicalKeys.add(e.code);
  keys[e.code] = true;
});
window.addEventListener("keyup", (e) => {
  physicalKeys.delete(e.code);
  keys[e.code] = virtualKeyHolds.has(e.code);
});

function pressVirtualKey(code) {
  if (!code) return;
  if (!keys[code]) {
    justPressed[code] = true;
    if ((code === "ArrowLeft" || code === "KeyA") && !keys["ArrowLeft"] && !keys["KeyA"]) {
      justPressedHorizontal.left = true;
    }
    if ((code === "ArrowRight" || code === "KeyD") && !keys["ArrowRight"] && !keys["KeyD"]) {
      justPressedHorizontal.right = true;
    }
  }
  keys[code] = true;
  virtualKeyHolds.set(code, (virtualKeyHolds.get(code) || 0) + 1);
}

function releaseVirtualKey(code) {
  if (!code) return;
  const holdCount = virtualKeyHolds.get(code) || 0;
  if (holdCount > 1) {
    virtualKeyHolds.set(code, holdCount - 1);
    return;
  }
  virtualKeyHolds.delete(code);
  keys[code] = physicalKeys.has(code);
}

const touchJoystick = document.getElementById("touchJoystick");
const touchJoystickKnob = document.getElementById("touchJoystickKnob");
let touchJoystickPointerId = null;
const touchJoystickDirections = new Set();
const touchJoystickRadius = 36;
const touchJoystickDeadZone = 11;
const joystickDirectionCodes = [
  ["ArrowRight"],
  ["ArrowRight", "ArrowDown"],
  ["ArrowDown"],
  ["ArrowLeft", "ArrowDown"],
  ["ArrowLeft"],
  ["ArrowLeft", "ArrowUp"],
  ["ArrowUp"],
  ["ArrowRight", "ArrowUp"]
];

function updateTouchJoystick(event) {
  if (event.pointerId !== touchJoystickPointerId) return;
  const rect = touchJoystick.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const rawX = event.clientX - centerX;
  const rawY = event.clientY - centerY;
  const distance = Math.hypot(rawX, rawY);
  const scale = distance > touchJoystickRadius ? touchJoystickRadius / distance : 1;
  const knobX = rawX * scale;
  const knobY = rawY * scale;
  touchJoystickKnob.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;

  const nextDirections = new Set();
  if (distance > touchJoystickDeadZone) {
    const angle = Math.atan2(rawY, rawX);
    const sector = (Math.round(angle / (Math.PI / 4)) + 8) % 8;
    for (const code of joystickDirectionCodes[sector]) nextDirections.add(code);
  }

  for (const code of touchJoystickDirections) {
    if (!nextDirections.has(code)) releaseVirtualKey(code);
  }
  for (const code of nextDirections) {
    if (!touchJoystickDirections.has(code)) pressVirtualKey(code);
  }
  touchJoystickDirections.clear();
  for (const code of nextDirections) touchJoystickDirections.add(code);
}

function resetTouchJoystick(pointerId = touchJoystickPointerId) {
  if (touchJoystickPointerId === null || pointerId !== touchJoystickPointerId) return;
  const capturedPointerId = touchJoystickPointerId;
  touchJoystickPointerId = null;
  for (const code of touchJoystickDirections) releaseVirtualKey(code);
  touchJoystickDirections.clear();
  touchJoystickKnob.style.transform = "translate(-50%, -50%)";
  if (touchJoystick.hasPointerCapture(capturedPointerId)) {
    touchJoystick.releasePointerCapture(capturedPointerId);
  }
}

touchJoystick.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (touchJoystickPointerId !== null) return;
  touchJoystickPointerId = event.pointerId;
  try {
    touchJoystick.setPointerCapture(event.pointerId);
  } catch (error) {
    touchJoystickPointerId = null;
    return;
  }
  updateTouchJoystick(event);
});
touchJoystick.addEventListener("pointermove", updateTouchJoystick);
touchJoystick.addEventListener("pointerup", (event) => resetTouchJoystick(event.pointerId));
touchJoystick.addEventListener("pointercancel", (event) => resetTouchJoystick(event.pointerId));
touchJoystick.addEventListener("lostpointercapture", (event) => resetTouchJoystick(event.pointerId));

const activeMobileButtonPointers = new Map();
const mobileActionButtons = document.querySelectorAll("#mobileControls [data-key]");
for (const button of mobileActionButtons) {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (activeMobileButtonPointers.has(event.pointerId)) return;
    ensureSFXAudioContext();
    activeMobileButtonPointers.set(event.pointerId, { button, code: button.dataset.key });
    button.classList.add("is-pressed");
    pressVirtualKey(button.dataset.key);
    try {
      button.setPointerCapture(event.pointerId);
    } catch (error) {
      activeMobileButtonPointers.delete(event.pointerId);
      button.classList.remove("is-pressed");
      releaseVirtualKey(button.dataset.key);
    }
  });

  const finishButtonPointer = (event) => {
    const activePointer = activeMobileButtonPointers.get(event.pointerId);
    if (!activePointer || activePointer.button !== button) return;
    activeMobileButtonPointers.delete(event.pointerId);
    releaseVirtualKey(activePointer.code);
    const buttonStillHeld = Array.from(activeMobileButtonPointers.values())
      .some((active) => active.button === button);
    if (!buttonStillHeld) button.classList.remove("is-pressed");
  };

  button.addEventListener("pointerup", finishButtonPointer);
  button.addEventListener("pointercancel", finishButtonPointer);
  button.addEventListener("lostpointercapture", finishButtonPointer);
}

function releaseAllVirtualKeys() {
  for (const code of virtualKeyHolds.keys()) {
    keys[code] = false;
    justPressed[code] = false;
  }
  virtualKeyHolds.clear();
  physicalKeys.clear();
  for (const code of Object.keys(keys)) keys[code] = false;
  for (const code of Object.keys(justPressed)) justPressed[code] = false;
  justPressedHorizontal.left = false;
  justPressedHorizontal.right = false;

  activeMobileButtonPointers.clear();
  for (const button of mobileActionButtons) button.classList.remove("is-pressed");
  touchJoystickPointerId = null;
  touchJoystickDirections.clear();
  touchJoystickKnob.style.transform = "translate(-50%, -50%)";
}
window.addEventListener("blur", releaseAllVirtualKeys);

// Función auxiliar para enviar rectángulos a WebGL
function drawQuad(x1, y1, x2, y2, u1, v1, u2, v2, color = null) {
  gl.uniform1i(useColorLocation, color ? 1 : 0);
  if (color) gl.uniform4fv(colorLocation, color);

  quadPositions[0] = x1; quadPositions[1] = y1; quadPositions[2] = x2; quadPositions[3] = y1;
  quadPositions[4] = x1; quadPositions[5] = y2; quadPositions[6] = x1; quadPositions[7] = y2;
  quadPositions[8] = x2; quadPositions[9] = y1; quadPositions[10] = x2; quadPositions[11] = y2;
  quadTexCoords[0] = u1; quadTexCoords[1] = v1; quadTexCoords[2] = u2; quadTexCoords[3] = v1;
  quadTexCoords[4] = u1; quadTexCoords[5] = v2; quadTexCoords[6] = u1; quadTexCoords[7] = v2;
  quadTexCoords[8] = u2; quadTexCoords[9] = v1; quadTexCoords[10] = u2; quadTexCoords[11] = v2;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, quadPositions);
  gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, quadTexCoords);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function drawSolidRect(x1, y1, x2, y2, color) {
  drawQuad(x1, y1, x2, y2, 0, 0, 1, 1, color);
}

function createNearestTexture(imgSource) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgSource);
  return texture;
}

// 3. Cargar JSON y Textura
async function init() {
  drawCenteredOverlayMessage("CARGANDO ASSETS...");
  let atlasData;
  let image;
  let texture;
  let venomImage = null;
  let enemyImage = null;
  try {
    let response;
    try {
      response = await fetch("./assets/spiderman.json");
    } catch (error) {
      throw new Error(`./assets/spiderman.json: ${error.message || String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ./assets/spiderman.json`);
    }
    try {
      atlasData = await response.json();
    } catch (error) {
      throw new Error(`./assets/spiderman.json: ${error.message || String(error)}`);
    }

    image = new Image();
    image.src = "./assets/spiderman_limpio.png";
    try {
      await image.decode();
    } catch (error) {
      throw new Error(`./assets/spiderman_limpio.png: ${error.message || String(error)}`);
    }

    texture = createNearestTexture(image);
    if (!texture) throw new Error("WebGL no pudo crear la textura de ./assets/spiderman_limpio.png.");
  } catch (error) {
    const exactError = error && error.message ? error.message : String(error);
    drawCenteredOverlayMessage(`ERROR AL CARGAR SPIDER-MAN\n${exactError}`, "#ff737d");
    console.error("Error al cargar los assets principales de Spider-Man:", error);
    return;
  }

  const frames = atlasData.frames;

  let levelBackground = null;
  try {
    const bgImage = new Image();
    bgImage.src = "./assets/bg_ny_street.png";
    await bgImage.decode();
    const bgTexture = createNearestTexture(bgImage);
    levelBackground = { texture: bgTexture, width: bgImage.width, height: bgImage.height };
  } catch (error) {
    levelBackground = null;
  }

  let venomAtlas = null;
  try {
    const venomResponse = await fetch("./assets/venom.json");
    if (!venomResponse.ok) throw new Error("No se pudo cargar ./assets/venom.json");
    const venomData = await venomResponse.json();
    venomImage = new Image();
    venomImage.src = "./assets/venom_limpio.png";
    await venomImage.decode();
    const venomTexture = createNearestTexture(venomImage);
    venomAtlas = { texture: venomTexture, frames: venomData.frames, width: venomImage.width, height: venomImage.height };
  } catch (error) {
    venomAtlas = null;
  }

  let enemyAtlas = null;
  try {
    const [enemyResponse, loadedEnemyImage] = await Promise.all([
      fetch("./assets/enemies.json"),
      (async () => {
        const image = new Image();
        image.src = "./assets/enemies_limpios.png";
        await image.decode();
        return image;
      })()
    ]);
    enemyImage = loadedEnemyImage;
    if (!enemyResponse.ok) throw new Error(`No se pudo cargar ./assets/enemies.json (${enemyResponse.status}).`);
    const enemyData = await enemyResponse.json();
    const enemyTexture = createNearestTexture(enemyImage);
    if (!enemyTexture) throw new Error("WebGL no pudo crear la textura del atlas de enemigos.");
    enemyAtlas = { texture: enemyTexture, frames: enemyData.frames, width: enemyImage.width, height: enemyImage.height };
  } catch (error) {
    console.error("No se pudo cargar el atlas de enemigos (./assets/enemies.json / ./assets/enemies_limpios.png):", error);
    enemyAtlas = null;
  }

  // Mapa exclusivo de Spider-Man: cada lista enumera fotogramas reales de su atlas.
  const animations = {
    idle: { frames: ["idle_01", "idle_02", "idle_03", "idle_02"], speed: 0.16, loop: true },
    walk: { frames: ["walk_01", "walk_02", "walk_03", "walk_04", "walk_05", "walk_06", "walk_07", "walk_08"], speed: 0.08, loop: true },
    run: { frames: ["run_01", "run_02", "run_03", "run_04", "run_05", "run_06", "run_07", "run_08"], speed: 0.06, loop: true },
    climb: { frames: ["climb_01", "climb_02", "climb_03", "climb_04", "climb_05", "climb_06", "climb_07", "climb_08"], speed: 0.09, loop: true },
    climb_sideways: { frames: ["climb_sideways_01", "climb_sideways_02", "climb_sideways_03", "climb_sideways_04", "climb_sideways_05", "climb_sideways_06"], speed: 0.09, loop: true },
    jump_from_wall: { frames: ["jump_from_wall_01"], speed: 0.14, loop: false },
    jump_up: { frames: ["jump_up_01"], speed: 0.1, loop: false },
    jump_forward: { frames: ["jump_forward_01", "jump_forward_02", "jump_forward_03", "jump_forward_04", "jump_forward_05"], speed: 0.085, loop: false },
    jump_back: { frames: ["jump_back_01"], speed: 0.1, loop: false },
    jump_kick: { frames: ["jump_kick_01"], speed: 0.1, loop: false },
    jump_up_kick: { frames: ["jump_up_kick_01", "jump_up_kick_02", "jump_up_kick_03", "jump_up_kick_04", "jump_up_kick_05"], speed: 0.07, loop: false },
    punch: { frames: ["punch_01", "punch_02"], speed: 0.08, loop: false },
    knee: { frames: ["knee_01", "knee_02"], speed: 0.08, loop: false },
    power_hit: { frames: ["power_hit_01", "power_hit_02", "power_hit_03", "power_hit_04"], speed: 0.075, loop: false },
    uppercut: { frames: ["uppercut_01", "uppercut_02", "uppercut_03", "uppercut_04"], speed: 0.07, loop: false },
    shoot_web: { frames: ["shoot_web_01"], speed: 0.08, loop: true },
    web_shield: { frames: ["web_shield_01", "web_shield_02", "web_shield_03", "web_shield_04", "web_shield_05", "web_shield_06"], speed: 0.06, loop: true },
    web_swing: { frames: ["web_swing_01", "web_swing_02", "web_swing_03", "web_swing_04", "web_swing_05", "web_swing_06", "web_swing_07", "web_swing_08", "web_swing_09", "web_swing_10", "web_swing_11", "web_swing_12"], speed: 0.095, loop: false },
    backflip: { frames: ["backflip_01", "backflip_02", "backflip_03", "backflip_04"], speed: 0.08, loop: false },
    special_attack: { frames: ["special_attack_01", "special_attack_02", "special_attack_03", "special_attack_04", "special_attack_05", "special_attack_06"], speed: 0.07, loop: false },
    grab: { frames: ["grab_01"], speed: 0.1, loop: false },
    hold: { frames: ["hold_01"], speed: 0.1, loop: true },
    lift: { frames: ["lift_01"], speed: 0.1, loop: false },
    lift_hold: { frames: ["lift_hold_01"], speed: 0.1, loop: true },
    grab_punch: { frames: ["grab_punch_ready_01", "grab_punch_01"], speed: 0.09, loop: false },
    grab_uppercut: { frames: ["grab_uppercut_01", "grab_uppercut_02"], speed: 0.09, loop: false },
    hold_walk: { frames: ["hold_01", "grab_01"], speed: 0.16, loop: true },
    lift_walk: { frames: ["hold_walk_01", "hold_walk_02", "hold_walk_03", "hold_walk_04"], speed: 0.12, loop: true },
    throw: { frames: ["throw_01", "throw_02", "throw_03"], speed: 0.09, loop: false },
    release: { frames: ["release_01"], speed: 0.1, loop: false },
    pain: { frames: ["pain_01"], speed: 0.25, loop: false },
    dead: { frames: ["dead_01"], speed: 0.5, loop: false }
  };
  // Mapa independiente de Venom; knee usa power_hit porque no existe knee en su atlas.
  const venomAnimations = {
    idle: { frames: ["idle_01", "idle_02", "idle_03", "idle_02"], speed: 0.16, loop: true },
    walk: { frames: ["walk_01", "walk_02", "walk_03", "walk_04", "walk_05", "walk_06", "walk_07"], speed: 0.085, loop: true },
    run: { frames: ["run_01", "run_02", "run_03", "run_04", "run_05", "run_06", "run_07"], speed: 0.065, loop: true },
    climb: { frames: ["climb_01", "climb_02", "climb_03", "climb_04", "climb_05", "climb_06", "climb_07"], speed: 0.10, loop: true },
    climb_sideways: { frames: ["climb_sideways_01", "climb_sideways_02", "climb_sideways_03"], speed: 0.10, loop: true },
    jump_from_wall: { frames: ["jump_from_wall_01"], speed: 0.14, loop: false },
    run_attack: { frames: ["run_attack_01"], speed: 0.25, loop: false },
    jump_up: { frames: ["jump_up_01"], speed: 0.1, loop: false },
    jump_forward: { frames: ["jump_forward_01", "jump_forward_02", "jump_forward_03"], speed: 0.085, loop: false },
    jump_kick: { frames: ["jump_kick_01"], speed: 0.1, loop: false },
    jump_up_kick: { frames: ["jump_up_kick_01", "jump_up_kick_02", "jump_up_kick_03"], speed: 0.07, loop: false },
    punch: { frames: ["punch_01", "punch_02"], speed: 0.08, loop: false },
    knee: { frames: ["power_hit_01", "power_hit_02", "power_hit_03", "power_hit_04", "power_hit_05"], speed: 0.045, loop: false },
    uppercut: { frames: ["uppercut_01", "uppercut_02", "uppercut_03"], speed: 0.093, loop: false },
    shoot_web: { frames: ["shoot_web_01", "shoot_web_02", "shoot_web_03", "shoot_web_04", "shoot_web_05", "shoot_web_06"], speed: 0.08, loop: false },
    web_shield: { frames: ["web_shield_01", "web_shield_02", "web_shield_03", "web_shield_04", "web_shield_05", "web_shield_06", "web_shield_07"], speed: 0.06, loop: true },
    web_swing: { frames: ["web_swing_01", "web_swing_02", "web_swing_03", "web_swing_04", "web_swing_05", "web_swing_06", "web_swing_07", "web_swing_08", "web_swing_09", "web_swing_10", "web_swing_11", "web_swing_12"], speed: 0.055, loop: false },
    backflip: { frames: ["backflip_01", "backflip_02", "backflip_03"], speed: 0.1067, loop: false },
    special_attack: { frames: ["special_attack_01", "special_attack_02", "special_attack_03", "special_attack_04"], speed: 0.105, loop: false },
    grab: { frames: ["grab_punch_ready_01"], speed: 0.1, loop: false },
    hold: { frames: ["grab_punch_ready_01"], speed: 0.1, loop: true },
    lift: { frames: ["grab_smash_01"], speed: 0.1, loop: false },
    lift_hold: { frames: ["grab_smash_01"], speed: 0.1, loop: true },
    lift_walk: { frames: ["grab_smash_01", "grab_smash_02"], speed: 0.12, loop: true },
    grab_punch: { frames: ["grab_punch_ready_01", "grab_punch_01"], speed: 0.09, loop: false },
    grab_uppercut: { frames: ["grab_smash_01", "grab_smash_02"], speed: 0.09, loop: false },
    hold_walk: { frames: ["grab_punch_ready_01", "walk_01", "grab_punch_ready_01", "walk_04"], speed: 0.15, loop: true },
    throw: { frames: ["grab_uppercut_01", "grab_uppercut_02", "grab_uppercut_03"], speed: 0.09, loop: false },
    release: { frames: ["grab_punch_ready_01"], speed: 0.1, loop: false },
    pain: { frames: ["pain_01"], speed: 0.25, loop: false },
    dead: { frames: ["dead_01"], speed: 0.5, loop: false },
    jump_land: { frames: ["jump_land_01"], speed: 0.12, loop: false }
  };
  const activeAttackFrames = new Set([
    "punch_02", "knee_02", "power_hit_03", "uppercut_03", "jump_kick_01", "jump_up_kick_03", "special_attack_03", "run_attack_01"
  ]);
  const activeDroneShotFrames = new Set([
    "drone_chun_shoot_02", "drone_chun_shoot_03", "drone_chun_shoot_04"
  ]);

  const SPIDERMAN_MAX_HP = 100;
  const VENOM_MAX_HP = 160;

  // Estado y Físicas de Spider-Man
  const player = {
    x: 160,
    y: 218,
    z: 0,               // Altura sobre el suelo
    vz: 0,              // Velocidad vertical (salto)
    jumpDirX: 0,        // Inercia horizontal durante el salto
    jumpDirY: 0,        // Inercia de profundidad durante el salto
    speedX: 85,
    speedY: 50,
    facingRight: true,
    isAttacking: false,
    hasHitThisAttack: false,
    score: 0,
    lives: 3,
    hp: SPIDERMAN_MAX_HP,
    maxHp: SPIDERMAN_MAX_HP,
    hurtTimer: 0,
    invulnTimer: 0,
    isDead: false,
    invincible: false,
    character: "spiderman",
    isTransforming: false,
    transformTimer: 0,
    transformSwitched: false,
    isSwinging: false,
    swingStartX: 160,
    maxJumpZ: 0,
    isBackflipping: false,
    isSpecialAttacking: false,
    isClimbing: false,
    specialMoveTimer: 0,
    wallJumpTimer: 0,
    grabbedEnemy: null,
    isGrabbing: false,
    grappleTimer: 0,
    grabHits: 0,
    isReleasing: false,
    comboWindowTimer: 0,
    comboWindowStage: 0,
    isShootingWeb: false,
    shootWebTimer: 0,
    webYankEnemy: null,
    webYankStartFrame: 0,
    webYankStartDistance: 0,
    state: "idle",
    frameIndex: 0,
    animTimer: 0
  };

  function getPlayerAnimations() {
    return player.character === "venom" && venomAtlas ? venomAnimations : animations;
  }
  function getAnimationDuration(state) {
    const animation = getPlayerAnimations()[state];
    return animation ? animation.frames.length * animation.speed : 0;
  }
  function validateAnimationMap(label, map, atlasFrames, reachableStates) {
    const errors = [];
    for (const [state, animation] of Object.entries(map)) {
      if (!Array.isArray(animation.frames) || animation.frames.length === 0) errors.push(`${state}: lista vacía`);
      for (const frameName of animation.frames) {
        if (!atlasFrames || !atlasFrames[frameName]) errors.push(`${state}: frame inexistente ${frameName}`);
        if (state !== "idle" && /^idle_/.test(frameName)) errors.push(`${state}: usa idle como sustituto (${frameName})`);
      }
      if (!reachableStates.has(state)) errors.push(`${state}: estado sin ruta de ejecución`);
    }
    if (errors.length) console.error(`[Animaciones ${label}]`, errors);
    else console.info(`[Animaciones ${label}] ${Object.keys(map).length} estados validados; atlas independiente.`);
    return errors.length === 0;
  }
  const reachableAnimationStates = new Set([
    "idle", "walk", "run", "climb", "climb_sideways", "jump_from_wall", "jump_up", "jump_forward", "jump_back", "jump_kick", "jump_up_kick", "punch", "knee", "power_hit", "run_attack", "uppercut",
    "shoot_web", "web_shield", "web_swing", "backflip", "special_attack", "grab", "hold", "grab_punch",
    "grab_uppercut", "hold_walk", "lift", "lift_hold", "lift_walk", "throw", "release", "pain", "dead", "jump_land"
  ]);
  validateAnimationMap("Spider-Man", animations, frames, reachableAnimationStates);
  if (venomAtlas) validateAnimationMap("Venom", venomAnimations, venomAtlas.frames, reachableAnimationStates);

  function createEnemyAnimationMap(prefix, specs) {
    const map = {};
    for (const [state, count, speed, loop] of specs) {
      const names = [];
      for (let index = 1; index <= count; index++) {
        const frameName = `${prefix}_${state}_${String(index).padStart(2, "0")}`;
        if (enemyAtlas && enemyAtlas.frames[frameName]) names.push(frameName);
        else console.error(`[Atlas enemigos] Falta el fotograma ${frameName}.`);
      }
      if (names.length) map[state] = { frames: names, speed, loop };
    }
    return map;
  }
  const enemyAnimationMaps = enemyAtlas ? {
    trench_thug: createEnemyAnimationMap("trench_thug", [
      ["idle", 2, 0.18, true], ["walk", 4, 0.12, true], ["punch", 2, 0.1, false],
      ["hurt", 1, 0.18, false], ["knockdown", 3, 0.15, false], ["dead", 1, 0.5, false], ["getup", 3, 0.15, false]
    ]),
    shades_thug: createEnemyAnimationMap("shades_thug", [
      ["idle", 2, 0.17, true], ["walk", 4, 0.1, true], ["punch", 1, 0.1, false], ["kick", 3, 0.09, false],
      ["hurt", 2, 0.12, false], ["knockdown", 2, 0.15, false], ["dead", 1, 0.5, false], ["getup", 3, 0.15, false]
    ]),
    female_thug: createEnemyAnimationMap("female_thug", [
      ["idle", 2, 0.18, true], ["walk", 4, 0.11, true], ["punch", 2, 0.1, false], ["kick", 2, 0.1, false],
      ["high_kick", 2, 0.1, false], ["whip", 4, 0.09, false],
      ["hurt", 3, 0.12, false], ["knockdown", 3, 0.15, false], ["dead", 1, 0.5, false], ["getup", 3, 0.15, false]
    ]),
    fat_thug: createEnemyAnimationMap("fat_thug", [
      ["idle", 2, 0.18, true], ["walk", 4, 0.13, true], ["attack", 3, 0.1, false],
      ["charge", 3, 0.09, false], ["hurt", 1, 0.18, false], ["knockdown", 3, 0.15, false],
      ["dead", 1, 0.5, false], ["getup", 2, 0.16, false]
    ]),
    umbrella_thug: createEnemyAnimationMap("umbrella_thug", [
      ["idle", 2, 0.18, true], ["walk", 4, 0.11, true], ["attack", 1, 0.14, false],
      ["shield", 1, 0.2, true], ["hurt", 2, 0.13, false], ["knockdown", 2, 0.15, false],
      ["dead", 1, 0.5, false], ["getup", 2, 0.16, false]
    ]),
    pistol_thug: createEnemyAnimationMap("pistol_thug", [
      ["idle", 1, 0.18, true], ["walk", 5, 0.1, true], ["melee", 2, 0.1, false],
      ["shoot", 2, 0.12, false], ["hurt", 1, 0.18, false], ["knockdown", 2, 0.15, false],
      ["dead", 1, 0.5, false], ["getup", 2, 0.16, false]
    ]),
    drone_chun: createEnemyAnimationMap("drone_chun", [
      ["idle", 1, 0.12, true], ["shoot", 4, 0.09, false]
    ])
  } : {};
  if (enemyAtlas) {
    for (const [type, map] of Object.entries(enemyAnimationMaps)) {
      for (const [state, animation] of Object.entries(map)) {
        if (!animation.frames.length || animation.frames.some((name) => !enemyAtlas.frames[name])) {
          console.error(`[Animaciones enemigas] ${type}.${state} contiene fotogramas inválidos.`);
        }
      }
      if (!map.idle || (type !== "drone_chun" && !map.walk) || (type === "drone_chun" && !map.shoot)) {
        console.error(`[Animaciones enemigas] ${type} no tiene sus animaciones base disponibles.`);
      }
    }
  }

  function createEnemy(x, y, type = "trench_thug") {
    const maxHp = type === "fat_thug" ? 140 : 100;
    return {
      x, y, z: 0, w: 32, h: 76, hp: maxHp, maxHp, hurtTimer: 0, webStunTimer: 0, shieldTimer: 0, facingRight: false,
      isGrabbed: false, isThrown: false, vx: 0, vz: 0, attackCooldown: 0, attackWindup: 0, isAttacking: false,
      downState: null, downTimer: 0, readyToRemove: false,
      type, animations: enemyAnimationMaps[type] || enemyAnimationMaps.trench_thug || {},
      animState: "idle", frameIndex: 0, animTimer: 0, isMoving: false, attackAnimation: "punch", attackCount: 0,
      attackHitResolved: false, webPullState: null, webPullTimer: 0, webPullStartDistance: 0
    };
  }
  let nextEnemyTypeIndex = 0;
  const enemyTypes = ["trench_thug", "shades_thug", "female_thug", "drone_chun", "fat_thug", "umbrella_thug", "pistol_thug"];
  const femaleThugAttacks = ["punch", "kick", "high_kick", "whip"];
  const enemyDisplayNames = {
    trench_thug: "BRET",
    shades_thug: "SLADE",
    female_thug: "VIXEN",
    drone_chun: "DRONE",
    fat_thug: "BRUTE",
    umbrella_thug: "GENT",
    pistol_thug: "GUNNER"
  };
  const enemies = [createEnemy(260, 218, "trench_thug")];
  const waves = [
    { triggerX: 300, lockCameraX: 160, spawned: false, cleared: false, spawns: [{ x: 490, y: 202 }, { x: 510, y: 218 }] },
    { triggerX: 750, lockCameraX: 600, spawned: false, cleared: false, spawns: [{ x: 940, y: 205 }, { x: 960, y: 220 }, { x: 950, y: 226 }] },
    { triggerX: 1200, lockCameraX: 1050, spawned: false, cleared: false, spawns: [{ x: 1400, y: 208 }, { x: 1420, y: 224 }, { x: 1380, y: 228 }] }
  ];
  let lastTargetEnemy = null;
  let goArrowTimer = 0;
  let showHitboxes = false;
  let showDebugHelp = false;
  let screenShakeTimer = 0;
  const swingHandOffsets = {
    web_swing_01: { dx: 4, dy: 103 },
    web_swing_02: { dx: 1, dy: 145 },
    web_swing_03: { dx: -1, dy: 134 },
    web_swing_04: { dx: 8, dy: 134 },
    web_swing_05: { dx: 5, dy: 127 },
    web_swing_06: { dx: 4, dy: 139 },
    web_swing_07: { dx: -24, dy: 156 },
    web_swing_08: { dx: -2, dy: 144 },
    web_swing_09: { dx: -7, dy: 135 },
    web_swing_10: { dx: -13, dy: 134 },
    web_swing_11: { dx: -12, dy: 129 },
    web_swing_12: { dx: -6, dy: 142 }
  };
  const linkPattern = [
    "..####..",
    ".#W#W#..",
    "#W###W##",
    ".#G#G#..",
    "..####.."
  ];
  const linkPatternColorPriority = { G: 1, W: 2, "#": 3 };
  const linkPatternPalettes = {
    spiderman: {
      "#": [0.03, 0.03, 0.05, 1],
      W: [1, 1, 1, 1],
      G: [0.76, 0.80, 0.86, 1]
    }
  };
  const GO_ARROW_COLOR = [1, 0.85, 0.12, 1];
  const linkPixelMap = new Map();
  const linkPixelEntries = [];
  const renderList = [];
  const renderItemsByEntity = new WeakMap();
  const loggedEnemyFrameErrors = new Set();
  const playerRenderItem = { type: "player", entity: player };

  function cacheLinkPixel(px, py, symbol, pixelCount) {
    const key = ((px + 1024) << 16) | (py + 1024);
    const existing = linkPixelMap.get(key);
    if (existing) {
      if (linkPatternColorPriority[symbol] > linkPatternColorPriority[existing.symbol]) {
        existing.symbol = symbol;
      }
      return pixelCount;
    }

    let entry = linkPixelEntries[pixelCount];
    if (!entry) {
      entry = { x: px, y: py, symbol };
      linkPixelEntries[pixelCount] = entry;
    } else {
      entry.x = px;
      entry.y = py;
      entry.symbol = symbol;
    }
    linkPixelMap.set(key, entry);
    return pixelCount + 1;
  }

  function drawCachedLinkPixels(pixelCount, colors) {
    for (let i = 0; i < pixelCount; i++) {
      const pixel = linkPixelEntries[i];
      drawSolidRect(pixel.x, pixel.y, pixel.x + 1, pixel.y + 1, colors[pixel.symbol]);
    }
  }

  function getRenderItem(type, entity) {
    let item = renderItemsByEntity.get(entity);
    if (!item) {
      item = { type, entity };
      renderItemsByEntity.set(entity, item);
    } else {
      item.type = type;
    }
    return item;
  }
  function compareRenderItems(a, b) {
    return a.entity.y - b.entity.y;
  }

  const STREET_TOP = 188;
  const STREET_BOTTOM = 230;
  const LEVEL_WIDTH = 1600;
  let cameraX = 0;
  const GRAVITY = 680;      // Fuerza de caída (píxeles/s²)
  const JUMP_FORCE = 250;   // Impulso inicial del salto
  const VENOM_JUMP_FORCE = 315;
  const WALK_SPEED_X = 85;
  const RUN_SPEED_X = 150;
  const DOUBLE_TAP_INTERVAL = 0.25;
  const COMBO_WINDOW = 0.25;

  let isRunning = false;
  let lastLeftTap = -Infinity;
  let lastRightTap = -Infinity;

  function setState(newState) {
    if (player.state !== newState) {
      player.state = newState;
      player.frameIndex = 0;
      player.animTimer = 0;
    }
  }

  function isHoldingDrone() {
    return player.grabbedEnemy?.type === "drone_chun";
  }

  function getGrabStartState() {
    return isHoldingDrone() ? "lift" : "grab";
  }

  function getGrabMovementState(isMoving) {
    if (isHoldingDrone()) return isMoving ? "lift_walk" : "lift_hold";
    return isMoving ? "hold_walk" : "hold";
  }

  function positionGrabbedEnemy() {
    const enemy = player.grabbedEnemy;
    if (!enemy) return;
    if (isHoldingDrone()) {
      const isVenom = player.character === "venom";
      enemy.x = player.x + (player.facingRight ? (isVenom ? 4 : 2) : (isVenom ? -4 : -2));
      enemy.y = player.y + 1;
      enemy.z = isVenom ? 42 : 36;
    } else {
      enemy.x = player.x + (player.facingRight ? 20 : -20);
      enemy.y = player.y;
      enemy.z = 0;
    }
    enemy.facingRight = !player.facingRight;
  }

  const loggedEnemyAnimationFallbacks = new Set();
  function setEnemyAnimation(enemy, requestedState) {
    const nextState = enemy.animations && enemy.animations[requestedState] ? requestedState : "idle";
    if (nextState !== requestedState) {
      const key = `${enemy.type}.${requestedState}`;
      if (!loggedEnemyAnimationFallbacks.has(key)) {
        loggedEnemyAnimationFallbacks.add(key);
        console.error(`[Animación enemiga] ${key} no existe; se usa idle.`);
      }
    }
    if (enemy.animState !== nextState) {
      enemy.animState = nextState;
      enemy.frameIndex = 0;
      enemy.animTimer = 0;
    }
  }

  function updateEnemyAnimation(enemy, dt) {
    if (!enemy.animations) return;
    const downAnimation = enemy.downState && enemy.animations[enemy.downState]
      ? enemy.downState
      : null;
    const requestedState = downAnimation || (enemy.shieldTimer > 0 && enemy.animations.shield
      ? "shield"
      : enemy.type === "drone_chun"
        ? (enemy.isAttacking ? "shoot" : "idle")
        : enemy.isThrown ? "knockdown"
          : enemy.hurtTimer > 0 ? "hurt"
            : enemy.isAttacking ? enemy.attackAnimation
              : enemy.isMoving ? "walk" : "idle");
    setEnemyAnimation(enemy, requestedState);
    const animation = enemy.animations[enemy.animState] || enemy.animations.idle;
    if (!animation || animation.frames.length === 0) return;
    enemy.animTimer += dt;
    while (enemy.animTimer >= animation.speed) {
      enemy.animTimer -= animation.speed;
      if (animation.loop) enemy.frameIndex = (enemy.frameIndex + 1) % animation.frames.length;
      else if (enemy.frameIndex < animation.frames.length - 1) enemy.frameIndex++;
      else {
        enemy.animTimer = 0;
        break;
      }
    }
  }

  function startGroundAttack(newState) {
    player.isAttacking = true;
    player.hasHitThisAttack = false;
    player.comboWindowTimer = 0;
    player.comboWindowStage = 0;
    player.isShootingWeb = false;
    player.shootWebTimer = 0;
    setState(newState);
  }

  function finishGroundAttack() {
    player.isAttacking = false;
    player.comboWindowTimer = 0;
    player.comboWindowStage = 0;
    setState(player.grabbedEnemy ? getGrabMovementState(false) : "idle");
  }

  function finishPunchAndOpenComboWindow() {
    player.isAttacking = false;
    player.comboWindowTimer = COMBO_WINDOW;
    player.comboWindowStage = 1;
    setState("idle");
  }

  function releaseGrapple() {
    if (player.grabbedEnemy) {
      player.grabbedEnemy.isGrabbed = false;
      player.grabbedEnemy.z = 0;
      cancelEnemyAttack(player.grabbedEnemy);
    }
    player.grabbedEnemy = null;
    player.isGrabbing = false;
    player.grappleTimer = 0;
    player.grabHits = 0;
    player.isAttacking = false;
    player.isReleasing = true;
    setState("release");
  }

  function cancelEnemyAttack(enemy) {
    enemy.isAttacking = false;
    enemy.attackWindup = 0;
  }

  function cancelWebYank() {
    const enemy = player.webYankEnemy;
    if (enemy) {
      enemy.webPullState = null;
      enemy.webPullTimer = 0;
      enemy.webPullStartDistance = 0;
    }
    player.webYankEnemy = null;
    player.webYankStartFrame = 0;
    player.webYankStartDistance = 0;
    player.isShootingWeb = false;
    player.shootWebTimer = 0;
  }

  function clearPlayerActionStates(releaseGrab = true) {
    if (player.webYankEnemy) cancelWebYank();
    if (releaseGrab && player.grabbedEnemy) {
      const enemy = player.grabbedEnemy;
      enemy.isGrabbed = false;
      enemy.z = 0;
      cancelEnemyAttack(enemy);
    }
    if (releaseGrab) {
      player.grabbedEnemy = null;
      player.grappleTimer = 0;
      player.grabHits = 0;
    }

    player.isAttacking = false;
    player.isSwinging = false;
    player.isBackflipping = false;
    player.isSpecialAttacking = false;
    player.isClimbing = false;
    player.isTransforming = false;
    player.isReleasing = false;
    player.isShootingWeb = false;
    player.isGrabbing = false;
    player.specialMoveTimer = 0;
    player.wallJumpTimer = 0;
    player.transformTimer = 0;
    player.transformSwitched = false;
    player.shootWebTimer = 0;
    player.comboWindowTimer = 0;
    player.comboWindowStage = 0;
    player.webYankStartFrame = 0;
    player.webYankStartDistance = 0;
  }

  function finishWebYank(enemy) {
    if (!enemy || player.webYankEnemy !== enemy || enemy.hp <= 0 || enemy.downState !== null || enemy.isThrown || enemy.isGrabbed) return;
    enemy.webPullState = null;
    enemy.webPullTimer = 0;
    enemy.webPullStartDistance = 0;
    enemy.hurtTimer = 0;
    enemy.webStunTimer = 0;
    enemy.isGrabbed = true;
    enemy.z = 0;
    enemy.vx = 0;
    enemy.vz = 0;
    cancelEnemyAttack(enemy);

    player.webYankEnemy = null;
    player.webYankStartFrame = 0;
    player.webYankStartDistance = 0;
    player.isShootingWeb = false;
    player.shootWebTimer = 0;
    player.grabbedEnemy = enemy;
    player.isGrabbing = true;
    player.grappleTimer = 2.5;
    player.grabHits = 0;
    player.isAttacking = false;
    player.isReleasing = false;
    player.hasHitThisAttack = false;
    positionGrabbedEnemy();
    setState(getGrabStartState());
  }

  function markPlayerDead() {
    player.isDead = true;
    player.hurtTimer = 0;
    player.invulnTimer = 0;
    clearPlayerActionStates();
    player.z = 0;
    player.vz = 0;
    setState("dead");
  }

  function resetGame() {
    clearPlayerActionStates();
    Object.assign(player, {
      x: 160, y: 218, z: 0, vz: 0, jumpDirX: 0, jumpDirY: 0, speedX: WALK_SPEED_X, speedY: 50,
      facingRight: true, swingStartX: 160, maxJumpZ: 0, hasHitThisAttack: false,
      isClimbing: false, wallJumpTimer: 0,
      score: 0, lives: 3, hp: SPIDERMAN_MAX_HP, maxHp: SPIDERMAN_MAX_HP,
      hurtTimer: 0, invulnTimer: 0, isDead: false, invincible: false,
      character: "spiderman", state: "idle", frameIndex: 0, animTimer: 0
    });
    enemies.length = 0;
    enemies.push(createEnemy(260, 218, "trench_thug"));
    nextEnemyTypeIndex = 0;
    for (const wave of waves) { wave.spawned = false; wave.cleared = false; }
    cameraX = 0;
    lastTargetEnemy = null;
    goArrowTimer = 0;
    screenShakeTimer = 0;
    isRunning = false;
    lastLeftTap = -Infinity;
    lastRightTap = -Infinity;
  }

  function drawHUD() {
    if (player.isDead) drawSolidRect(0, 0, canvas.width, canvas.height, [0.25, 0, 0, 0.45]);
    if (goArrowTimer > 0 && Math.floor(goArrowTimer * 10) % 2 === 0) {
      const x = canvas.width - 42, y = 22;
      drawSolidRect(x - 12, y - 3, x + 4, y + 3, GO_ARROW_COLOR);
      drawSolidRect(x + 2, y - 8, x + 10, y + 8, GO_ARROW_COLOR);
    }
    drawGodModeStatus();
  }

  function drawAtlasPortrait(context, x, y, size, img, frameData, cropTopRatio = 0.42) {
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#0b0e17";
    context.fillRect(x, y, size, size);
    context.fillStyle = "#cfd6e6";
    context.fillRect(x, y, size, size);
    context.fillStyle = "#283044";
    context.fillRect(x + 1, y + 1, size - 2, size - 2);
    context.fillStyle = "#0b0e17";
    context.fillRect(x + 2, y + 2, size - 4, size - 4);

    const frame = frameData?.frame || frameData;
    if (!img || !frame || !frame.w || !frame.h) return;
    const sx = frame.x;
    const sy = frame.y;
    const sw = frame.w;
    const sh = Math.max(12, Math.floor(frame.h * cropTopRatio));
    const innerSize = size - 6;
    const scale = Math.min(innerSize / sw, innerSize / sh);
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const dx = x + Math.floor((size - dw) / 2);
    const dy = y + Math.floor((size - dh) / 2);
    context.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function drawHorizontalHealthBar(context, x, y, width, height, ratio, isPlayer) {
    const health = Math.max(0, Math.min(1, ratio));
    context.fillStyle = "#080a10";
    context.fillRect(x, y, width, height);
    context.fillStyle = "#8e97ab";
    context.fillRect(x + 1, y + 1, width - 2, height - 2);
    context.fillStyle = "#5a141c";
    context.fillRect(x + 2, y + 2, width - 4, height - 4);

    const fillWidth = Math.round((width - 4) * health);
    if (fillWidth > 0) {
      let fillColor;
      let shineColor;
      if (!isPlayer) {
        fillColor = "#e84830";
        shineColor = "#ff9d7a";
      } else if (player.character === "venom") {
        fillColor = "#22d8ff";
        shineColor = "#b8f5ff";
      } else {
        fillColor = "#f5d130";
        shineColor = "#fff3a1";
      }
      const gradient = context.createLinearGradient(0, y + 2, 0, y + height - 2);
      gradient.addColorStop(0, shineColor);
      gradient.addColorStop(0.4, fillColor);
      gradient.addColorStop(1, fillColor);
      context.fillStyle = gradient;
      context.fillRect(x + 2, y + 2, fillWidth, height - 4);
      context.fillStyle = shineColor;
      context.fillRect(x + 2, y + 2, fillWidth, 1);
    }

    context.fillStyle = "rgba(8, 10, 16, 0.72)";
    for (let dividerX = x + 2 + 8; dividerX < x + width - 2; dividerX += 8) {
      context.fillRect(dividerX, y + 1, 1, height - 2);
    }
    context.fillStyle = "#cfd6e6";
    context.fillRect(x + 1, y + 1, width - 2, 1);
  }

  function drawRetroHUD(context) {
    context.imageSmoothingEnabled = false;
    const heroImage = player.character === "venom" ? venomImage : image;
    const heroFrame = player.character === "venom"
      ? venomAtlas?.frames?.idle_01
      : frames.idle_01;
    drawAtlasPortrait(context, 8, 7, 20, heroImage, heroFrame);
    const healthBarWidth = player.character === "venom" ? 116 : 96;
    drawHorizontalHealthBar(context, 31, 18, healthBarWidth, 7, player.hp / player.maxHp, true);

    context.textBaseline = "top";
    context.textAlign = "left";
    context.font = "bold 6px monospace";
    context.lineWidth = 1;
    context.strokeStyle = "#000000";
    context.fillStyle = "#ffffff";
    const heroName = player.character === "venom" ? "VENOM" : "SPIDER-MAN";
    context.strokeText(heroName, 31, 8);
    context.fillText(heroName, 31, 8);
    let statsX = 31 + context.measureText(heroName).width + 4;
    context.fillStyle = "#f5d130";
    context.strokeText(`x${player.lives}`, statsX, 8);
    context.fillText(`x${player.lives}`, statsX, 8);
    statsX += context.measureText(`x${player.lives}`).width + 4;
    context.fillStyle = "#ffffff";
    const scoreText = String(player.score).padStart(6, "0").slice(-6);
    context.strokeText(scoreText, statsX, 8);
    context.fillText(scoreText, statsX, 8);

    if (lastTargetEnemy && lastTargetEnemy.hp > 0) {
      const enemyFrameName = `${lastTargetEnemy.type}_idle_01`;
      const enemyFrame = enemyAtlas?.frames?.[enemyFrameName];
      drawAtlasPortrait(context, canvas.width - 28, 7, 20, enemyImage, enemyFrame);
      drawHorizontalHealthBar(
        context,
        canvas.width - 105,
        18,
        74,
        6,
        lastTargetEnemy.hp / lastTargetEnemy.maxHp,
        false
      );
      context.font = "bold 6px monospace";
      context.textAlign = "right";
      context.strokeStyle = "#000000";
      context.fillStyle = "#ffffff";
      const enemyName = enemyDisplayNames[lastTargetEnemy.type] || "ENEMY";
      context.strokeText(enemyName, canvas.width - 31, 8);
      context.fillText(enemyName, canvas.width - 31, 8);
      context.textAlign = "left";
    }

    if (player.isDead) {
      context.font = "bold 8px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.lineWidth = 2;
      context.strokeStyle = "#100b10";
      context.fillStyle = "#f2d14c";
      const message = "GAME OVER - PRESIONA ENTER O R";
      context.strokeText(message, canvas.width / 2, canvas.height / 2);
      context.fillText(message, canvas.width / 2, canvas.height / 2);
      context.textAlign = "start";
    }
  }
  function drawGodModeStatus() {
    const testMessage = "CONTROLES MOVILES FIFA MOBILE: Joystick izquierdo 8 direcciones (x2 correr) + Botones [GOLPE, SALTO, RED, ESCUDO, ESPECIAL, FUERTE, VENOM] multi-touch";
    const stateMessage = "Personaje: " + player.character.toUpperCase()
      + " | Shake: " + (screenShakeTimer > 0 ? "ACTIVO" : "NO")
      + " | God Mode [G]: " + (player.invincible ? "ON" : "OFF");
    const context = statusOverlayContext;
    context.clearRect(0, 0, statusOverlay.width, statusOverlay.height);
    context.imageSmoothingEnabled = false;
    drawRetroHUD(context);
    const maxWidth = canvas.width - 8;
    context.textBaseline = "top";
    context.lineWidth = 1;
    context.strokeStyle = "rgba(0, 0, 0, 0.9)";
    const drawStatusLine = (message, y, color) => {
      context.font = "4px monospace";
      const fontSize = Math.min(4, maxWidth / Math.max(context.measureText(message).width, 1) * 4);
      context.font = `${fontSize}px monospace`;
      context.fillStyle = color;
      context.strokeText(message, 4, y);
      context.fillText(message, 4, y);
    };
    if (showDebugHelp) drawStatusLine(testMessage, 36, "#ffffff");
    if (showDebugHelp) drawStatusLine(stateMessage, 43, player.invincible ? "#a8ffb0" : "#fff0a0");
    context.font = "bold 5px monospace";
    context.textAlign = "right";
    context.strokeStyle = "#000000";
    context.fillStyle = "#d4dae6";
    context.strokeText("[F1] Controles", canvas.width - 5, canvas.height - 8);
    context.fillText("[F1] Controles", canvas.width - 5, canvas.height - 8);
    context.textAlign = "left";
  }

  function damagePlayer(attacker) {
    if (player.invincible || player.isDead || player.invulnTimer > 0 || player.z >= 20) return false;

    clearPlayerActionStates();

    player.hp = Math.max(0, player.hp - 12);
    playSFX("hurt");
    player.hurtTimer = 0.28;
    player.invulnTimer = 1.0;

    player.jumpDirX = 0;
    player.jumpDirY = 0;

    const knockbackDirection = Math.sign(player.x - attacker.x) || (attacker.facingRight ? 1 : -1);
    player.x += knockbackDirection * 18;
    player.x = Math.max(cameraX + 20, Math.min(cameraX + canvas.width - 20, player.x));

    if (player.hp <= 0) {
      markPlayerDead();
    } else {
      setState("pain");
    }
    return true;
  }

  function launchEnemy(enemy, direction) {
    enemy.isGrabbed = false;
    cancelEnemyAttack(enemy);
    enemy.isThrown = true;
    enemy.vx = direction * 260;
    enemy.vz = 220;
  }

  function throwGrabbedEnemy(invertDirection = true) {
    const enemy = player.grabbedEnemy;
    if (!enemy) return;

    const wasElevated = enemy.z > 0;
    if (invertDirection) player.facingRight = !player.facingRight;
    const launchDirection = player.facingRight ? 1 : -1;
    launchEnemy(enemy, launchDirection);
    if (wasElevated) {
      enemy.z = 36;
      enemy.vz = 140;
      enemy.vx = launchDirection * 280;
      playSFX("web");
    } else {
      playSFX("punch");
    }
    player.grabbedEnemy = null;
    player.isGrabbing = false;
    player.grappleTimer = 0;
    player.grabHits = 0;
    player.isAttacking = true;
    player.isReleasing = false;
    player.hasHitThisAttack = true;
    setState("throw");
  }

  function performGrabPunch() {
    const enemy = player.grabbedEnemy;
    if (!enemy) return;

    player.grabHits++;
    player.isAttacking = true;
    player.isReleasing = false;
    if (player.grabHits >= 3) {
      damageEnemy(enemy, 25);
      playSFX("punch");
      enemy.hurtTimer = 0.25;
      enemy.webStunTimer = 0;
      launchEnemy(enemy, player.facingRight ? 1 : -1);
      startEnemyKnockdown(enemy);
      player.grabbedEnemy = null;
      player.isGrabbing = false;
      player.grappleTimer = 0;
      player.grabHits = 0;
      setState("grab_uppercut");
      return;
    }

    damageEnemy(enemy, 15);
    playSFX("punch");
    enemy.hurtTimer = 0.25;
    enemy.webStunTimer = 0;
    setState("grab_punch");
    if (enemy.hp <= 0) {
      enemy.isGrabbed = false;
      enemy.z = 0;
      player.grabbedEnemy = null;
      player.grappleTimer = 0;
      player.grabHits = 0;
    }
  }

  function getPlayerAttackHitbox() {
    const currentAnimation = getPlayerAnimations()[player.state];
    if (!currentAnimation) return null;
    const frameName = currentAnimation.frames[player.frameIndex];
    if (player.state === "shoot_web" && player.isShootingWeb && !player.webYankEnemy) {
      if (player.character !== "spiderman") return null;
      const forward = player.facingRight ? 1 : -1;
      let webStart;
      let webEnd;
      if (player.shootWebTimer <= 0.28) {
        webStart = player.x + forward * 20;
        webEnd = webStart + forward * 135;
      } else {
        return null;
      }
      return {
        type: "web",
        x1: Math.min(webStart, webEnd),
        x2: Math.max(webStart, webEnd),
        z1: player.z + 20,
        z2: player.z + 54
      };
    }
    if (!activeAttackFrames.has(frameName)) return null;

    const width = 44;
    const x1 = player.facingRight ? player.x + 8 : player.x - 8 - width;
    return {
      x1,
      x2: x1 + width,
      z1: player.z + 12,
      z2: player.z + 64
    };
  }

  function damageEnemy(enemy, amount) {
    if (!enemy || enemy.hp <= 0) return false;
    lastTargetEnemy = enemy;
    enemy.hp = Math.max(0, enemy.hp - amount);
    player.score += 100;
    playSFX("hurt");
    if (enemy.hp <= 0) {
      player.score += 500;
      startEnemyKnockdown(enemy);
    }
    return true;
  }

  function setEnemyDownState(enemy, state, timer) {
    enemy.downState = state;
    enemy.downTimer = timer;
    enemy.frameIndex = 0;
    enemy.animTimer = 0;
  }

  function startEnemyKnockdown(enemy) {
    if (!enemy || (enemy.type === "drone_chun" && enemy.hp > 0)) return;
    cancelEnemyAttack(enemy);
    enemy.isMoving = false;
    enemy.webStunTimer = 0;
    enemy.webPullState = null;
    enemy.webPullTimer = 0;
    enemy.webPullStartDistance = 0;

    if (player.webYankEnemy === enemy) {
      cancelWebYank();
      setState("idle");
    }
    if (player.grabbedEnemy === enemy) {
      player.grabbedEnemy = null;
      player.isGrabbing = false;
      player.grappleTimer = 0;
      player.grabHits = 0;
      enemy.isGrabbed = false;
      enemy.z = 0;
    }

    if (enemy.type === "drone_chun") {
      enemy.isThrown = false;
      enemy.vx = 0;
      enemy.vz = 0;
      enemy.z = 0;
      if (enemy.downState === "dead") return;
      setEnemyDownState(enemy, "dead", 0.35);
      return;
    }

    setEnemyDownState(enemy, "knockdown", 0.45);
  }

  function removeDeadEnemies() {
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].hp > 0 || enemies[i].readyToRemove !== true) continue;
      if (player.webYankEnemy === enemies[i]) {
        cancelWebYank();
        setState("idle");
      }
      if (player.grabbedEnemy === enemies[i]) releaseGrapple();
      enemies.splice(i, 1);
    }
  }

  function resolveEnemyAttack(enemy) {
    const direction = enemy.facingRight ? 1 : -1;
    const hitboxLeft = direction > 0 ? enemy.x : enemy.x - 42;
    const hitboxRight = direction > 0 ? enemy.x + 42 : enemy.x;
    const inMeleeRange = player.x >= hitboxLeft && player.x <= hitboxRight;
    const inPistolRange = enemy.type === "pistol_thug" && enemy.attackAnimation === "shoot"
      && Math.abs(player.x - enemy.x) <= 95 && (direction > 0 ? player.x >= enemy.x : player.x <= enemy.x);
    const playerInFront = (inMeleeRange || inPistolRange)
      && Math.abs(player.y - enemy.y) < 12 && player.z < 20;

    if (playerInFront) {
      if (player.state === "web_shield") {
        if (!tryShieldBlock(enemy)) damagePlayer(enemy);
      } else if (player.invulnTimer <= 0) {
        damagePlayer(enemy);
      }
    }

    enemy.attackCooldown = 1.2;
    cancelEnemyAttack(enemy);
  }

  function resolveDroneAttackHitbox(enemy) {
    if (!enemyAtlas || !enemy.animations.shoot || enemy.type !== "drone_chun" || enemy.animState !== "shoot") return false;
    const frameName = enemy.animations.shoot.frames[enemy.frameIndex];
    if (!activeDroneShotFrames.has(frameName)) return false;

    const shotFrameData = enemyAtlas.frames[frameName];
    const idleFrameData = enemyAtlas.frames.drone_chun_idle_01;
    if (!shotFrameData || !idleFrameData) return false;
    const shotFrame = shotFrameData.frame;
    const idleFrame = idleFrameData.frame;
    const direction = enemy.facingRight ? 1 : -1;
    const shotOriginX = enemy.x + (enemy.facingRight ? 18 : -18);
    const rayEndX = shotOriginX + direction * Math.max(0, shotFrame.w - idleFrame.w);
    const hitboxLeft = Math.min(shotOriginX, rayEndX);
    const hitboxRight = Math.max(shotOriginX, rayEndX);
    if (player.x < hitboxLeft || player.x > hitboxRight || Math.abs(player.y - enemy.y) >= 14) return false;

    if (player.state === "web_shield") {
      if (!tryShieldBlock(enemy)) damagePlayer(enemy);
    } else {
      damagePlayer(enemy);
    }
    return true;
  }

  function tryShieldBlock(attacker) {
    if (player.state !== "web_shield" || Math.random() >= 0.5) return false;

    const knockbackDirection = Math.sign(attacker.x - player.x)
      || (attacker.facingRight ? -1 : 1);
    attacker.x = Math.max(20, Math.min(LEVEL_WIDTH - 20, attacker.x + knockbackDirection * 25));
    playSFX("web");
    return true;
  }

  function updateEnemies(dt) {
    for (const enemy of enemies) {
      enemy.isMoving = false;
      enemy.shieldTimer = Math.max(0, enemy.shieldTimer - dt);

      if (enemy.hp <= 0 && enemy.downState === null) startEnemyKnockdown(enemy);
      if (enemy.downState !== null) {
        cancelEnemyAttack(enemy);
        const thrownDuringKnockdown = enemy.downState === "knockdown" && enemy.isThrown;
        if (!thrownDuringKnockdown) {
          enemy.downTimer = Math.max(0, enemy.downTimer - dt);
          if (enemy.downTimer <= 0) {
            if (enemy.downState === "knockdown") {
              setEnemyDownState(enemy, "dead", enemy.hp <= 0 ? 0.65 : 0.45);
            } else if (enemy.downState === "dead") {
              if (enemy.hp <= 0) {
                enemy.readyToRemove = true;
              } else {
                setEnemyDownState(enemy, "getup", 0.45);
              }
            } else if (enemy.downState === "getup") {
              enemy.downState = null;
              enemy.downTimer = 0;
              enemy.frameIndex = 0;
              enemy.animTimer = 0;
            }
          }
          continue;
        }
      }

      if (enemy.webPullState === "stunned") {
        cancelEnemyAttack(enemy);
        enemy.webPullTimer = Math.max(0, enemy.webPullTimer - dt);
        enemy.hurtTimer = Math.max(0, enemy.hurtTimer - dt);
        if (enemy.webPullTimer > 0) continue;
        enemy.webPullState = "pulling";
      }

      if (enemy.webPullState === "pulling") {
        cancelEnemyAttack(enemy);
        enemy.hurtTimer = Math.max(0, enemy.hurtTimer - dt);
        const forward = player.facingRight ? 1 : -1;
        const targetX = player.x + forward * 20;
        const dx = targetX - enemy.x;
        const dy = player.y - enemy.y;
        const distance = Math.hypot(dx, dy);
        const step = Math.min(distance, 320 * dt);
        if (distance > 0) {
          enemy.x += (dx / distance) * step;
          enemy.y += (dy / distance) * step;
        }
        enemy.x = Math.max(20, Math.min(LEVEL_WIDTH - 20, enemy.x));
        enemy.y = Math.max(STREET_TOP, Math.min(STREET_BOTTOM, enemy.y));
        enemy.facingRight = enemy.x < player.x;

        const progress = Math.max(0, Math.min(1, 1 - distance / Math.max(1, enemy.webPullStartDistance)));
        player.frameIndex = player.character === "venom"
          ? venomAnimations.shoot_web.frames.length - 1
          : Math.max(0, player.webYankStartFrame - Math.round(player.webYankStartFrame * progress));
        player.animTimer = 0;
        const enemyIsInFront = player.facingRight ? enemy.x >= player.x : enemy.x <= player.x;
        if (enemyIsInFront && Math.abs(enemy.x - player.x) < 24 && Math.abs(enemy.y - player.y) < 12) finishWebYank(enemy);
        continue;
      }

      enemy.hurtTimer = Math.max(0, enemy.hurtTimer - dt);
      enemy.webStunTimer = Math.max(0, enemy.webStunTimer - dt);
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);

      if (enemy.isGrabbed) {
        cancelEnemyAttack(enemy);
        continue;
      }

      if (enemy.shieldTimer > 0) {
        cancelEnemyAttack(enemy);
        continue;
      }

      if (enemy.isThrown) {
        cancelEnemyAttack(enemy);
        enemy.x += enemy.vx * dt;
        enemy.z = Math.max(0, enemy.z + enemy.vz * dt);
        enemy.vz -= GRAVITY * dt;
        enemy.facingRight = enemy.vx > 0;

        if (enemy.x < 20 || enemy.x > LEVEL_WIDTH - 20) {
          enemy.x = Math.max(20, Math.min(LEVEL_WIDTH - 20, enemy.x));
          enemy.vx = 0;
        }

        let hitAnotherEnemy = false;
        for (const other of enemies) {
          if (other === enemy || other.hp <= 0) continue;
          if (Math.abs(enemy.y - other.y) >= 16) continue;

          const overlapsX = enemy.x - enemy.w / 2 <= other.x + other.w / 2
            && enemy.x + enemy.w / 2 >= other.x - other.w / 2;
          const overlapsZ = enemy.z <= other.z + other.h && enemy.z + enemy.h >= other.z;
          if (!overlapsX || !overlapsZ) continue;

          damageEnemy(enemy, 30);
          damageEnemy(other, 30);
          playSFX("punch");
          enemy.hurtTimer = 0.25;
          other.hurtTimer = 0.25;
          enemy.webStunTimer = 0;
          other.webStunTimer = 0;
          cancelEnemyAttack(enemy);
          cancelEnemyAttack(other);
          enemy.isThrown = false;
          enemy.vx = 0;
          enemy.vz = 0;
          enemy.z = 0;
          startEnemyKnockdown(enemy);
          hitAnotherEnemy = true;
          break;
        }

        if (!hitAnotherEnemy && enemy.isThrown && enemy.z <= 0) {
          enemy.isThrown = false;
          enemy.vx = 0;
          enemy.vz = 0;
          enemy.z = 0;
          damageEnemy(enemy, 25);
          playSFX("punch");
          enemy.hurtTimer = 0.25;
          startEnemyKnockdown(enemy);
        }
        continue;
      }

      const isActive = !player.isDead && enemy.hurtTimer <= 0 && enemy.webStunTimer <= 0;
      if (!isActive) {
        cancelEnemyAttack(enemy);
        continue;
      }

      const dx = player.x - enemy.x;
      const dy = player.y - enemy.y;
      if (enemy.type === "drone_chun") enemy.facingRight = player.x > enemy.x;
      if (enemy.isAttacking) {
        if (enemy.type === "drone_chun") {
          if (!enemy.attackHitResolved && resolveDroneAttackHitbox(enemy)) enemy.attackHitResolved = true;
          enemy.attackWindup -= dt;
          if (enemy.attackWindup <= 0) {
            enemy.attackCooldown = 1.2;
            cancelEnemyAttack(enemy);
          }
          continue;
        }
        enemy.attackWindup -= dt;
        if (enemy.attackWindup <= 0) resolveEnemyAttack(enemy);
        continue;
      }

      const attackRange = enemy.type === "drone_chun" ? 46
        : enemy.type === "pistol_thug" ? 95
          : 34;
      const attackDepth = enemy.type === "drone_chun" ? 14 : 12;
      if (Math.abs(dx) < attackRange && Math.abs(dy) < attackDepth && enemy.attackCooldown <= 0) {
        enemy.isAttacking = true;
        enemy.attackWindup = enemy.type === "drone_chun" ? 0.4 : 0.35;
        enemy.facingRight = dx > 0;
        enemy.attackHitResolved = false;
        if (enemy.type === "drone_chun") {
          enemy.attackAnimation = "shoot";
        } else if (enemy.type === "fat_thug") {
          enemy.attackAnimation = enemy.attackCount++ % 2 === 0 ? "attack" : "charge";
        } else if (enemy.type === "umbrella_thug") {
          enemy.attackAnimation = "attack";
        } else if (enemy.type === "pistol_thug") {
          enemy.attackAnimation = Math.abs(dx) < 36 ? "melee" : "shoot";
        } else if (enemy.type === "female_thug") {
          enemy.attackAnimation = femaleThugAttacks[enemy.attackCount++ % femaleThugAttacks.length];
        } else if (enemy.type === "shades_thug") {
          enemy.attackAnimation = enemy.attackCount++ % 2 === 0 ? "kick" : "punch";
        } else {
          enemy.attackAnimation = "punch";
        }
        continue;
      }

      const distance = Math.hypot(dx, dy);
      if (distance > 1) {
        enemy.x += (dx / distance) * 24 * dt;
        enemy.y += (dy / distance) * 18 * dt;
        enemy.facingRight = dx > 0;
        enemy.isMoving = true;
      }
      enemy.x = Math.max(20, Math.min(LEVEL_WIDTH - 20, enemy.x));
      enemy.y = Math.max(STREET_TOP, Math.min(STREET_BOTTOM, enemy.y));
    }
    for (const enemy of enemies) {
      if (!enemy.readyToRemove) updateEnemyAnimation(enemy, dt);
    }
    removeDeadEnemies();
  }

  function applyAttackHitbox(hitbox) {
    if (!hitbox || player.hasHitThisAttack
      || (player.character === "venom" && hitbox.type === "web")) return;

    for (const enemy of enemies) {
      if (enemy.hp <= 0) continue;
      if (hitbox.type === "web" && enemy.downState !== null) continue;
      if (hitbox.type === "web" && (enemy.isThrown || enemy.isGrabbed || enemy.webPullState)) continue;
      if (Math.abs(player.y - enemy.y) >= 16) continue;

      const enemyLeft = enemy.x - enemy.w / 2;
      const enemyRight = enemy.x + enemy.w / 2;
      const enemyBottomZ = enemy.z;
      const enemyTopZ = enemy.z + enemy.h;
      const overlapsXZ = hitbox.x1 <= enemyRight && hitbox.x2 >= enemyLeft
        && hitbox.z1 <= enemyTopZ && hitbox.z2 >= enemyBottomZ;
      if (!overlapsXZ) continue;

      player.hasHitThisAttack = true;
      if (hitbox.type === "web") {
        player.score += 100;
        lastTargetEnemy = enemy;
        const forward = player.facingRight ? 1 : -1;
        enemy.webPullState = "stunned";
        enemy.webPullTimer = 0.45;
        enemy.hurtTimer = 0.6;
        enemy.webStunTimer = 0;
        enemy.webPullStartDistance = Math.max(1, Math.hypot(
          enemy.x - (player.x + forward * 20),
          enemy.y - player.y
        ));
        player.webYankEnemy = enemy;
        player.webYankStartFrame = player.frameIndex;
        player.webYankStartDistance = enemy.webPullStartDistance;
        player.shootWebTimer = 0;
        cancelEnemyAttack(enemy);
        break;
      }
      lastTargetEnemy = enemy;
      const isPowerHit = player.character === "spiderman" && player.state === "power_hit";
      const isVenomRunAttack = player.character === "venom" && player.state === "run_attack";
      const guardedByUmbrella = enemy.type === "umbrella_thug" && enemy.downState === null
        && !enemy.isThrown && !enemy.isGrabbed && !enemy.isAttacking && enemy.shieldTimer <= 0
        && (enemy.facingRight ? player.x > enemy.x : player.x < enemy.x)
        && Math.random() < 0.3;
      if (guardedByUmbrella) enemy.shieldTimer = 0.3;
      const damage = isPowerHit ? 30 : isVenomRunAttack ? 35 : player.character === "venom" ? 30 : 20;
      damageEnemy(enemy, damage);
      playSFX("punch");
      enemy.hurtTimer = 0.25;
      enemy.webStunTimer = 0;
      cancelEnemyAttack(enemy);
      if (player.state === "uppercut" || player.state === "special_attack"
        || player.state === "jump_kick" || player.state === "jump_up_kick" || isPowerHit || isVenomRunAttack) {
        startEnemyKnockdown(enemy);
      }
      if (guardedByUmbrella && enemy.hp > 0 && enemy.downState === null) setEnemyAnimation(enemy, "shield");
      if (!guardedByUmbrella) enemy.x += (player.facingRight ? 1 : -1) * 24;
      enemy.x = Math.max(20, Math.min(LEVEL_WIDTH - 20, enemy.x));
      break;
    }
  }

  function triggerVenomGroundSlam(force = false) {
    if (player.character !== "venom" || (!force && player.maxJumpZ < 35)) return false;

    screenShakeTimer = 0.22;
    playSFX("slam");
    for (const enemy of enemies) {
      if (enemy.hp <= 0 || Math.abs(enemy.x - player.x) >= 52 || Math.abs(enemy.y - player.y) >= 20) continue;
      damageEnemy(enemy, 25);
      startEnemyKnockdown(enemy);
      enemy.hurtTimer = 0.35;
      enemy.webStunTimer = 0;
      cancelEnemyAttack(enemy);
      const knockDirection = enemy.x === player.x
        ? (player.facingRight ? 1 : -1)
        : Math.sign(enemy.x - player.x);
      enemy.x = Math.max(20, Math.min(LEVEL_WIDTH - 20, enemy.x + knockDirection * 32));
      if (enemy.hp <= 0 && player.grabbedEnemy === enemy) {
        enemy.isGrabbed = false;
        enemy.z = 0;
        player.grabbedEnemy = null;
        player.isGrabbing = false;
        player.grappleTimer = 0;
      }
    }
    return true;
  }

  function resolvePlayerLanding() {
    if (player.character === "venom" && player.maxJumpZ >= 35) triggerVenomGroundSlam();
    player.maxJumpZ = 0;
  }

  function drawWorld() {
    drawSolidRect(0, 0, canvas.width, 124, [0.04, 0.04, 0.06, 1]);
    drawSolidRect(0, 124, canvas.width, canvas.height, [0.16, 0.16, 0.21, 1]);
    drawSolidRect(0, 124, canvas.width, 127, [0.09, 0.09, 0.12, 1]);

    if (levelBackground) {
      gl.bindTexture(gl.TEXTURE_2D, levelBackground.texture);
      const BG_SCALE = 0.82;
      const bgY = -44;
      const splitV = 0.49;
      const scaledWidth = levelBackground.width * BG_SCALE;
      const topHeight = levelBackground.height * splitV * BG_SCALE;
      const firstTileX = Math.floor(cameraX / scaledWidth) * scaledWidth;
      for (let tileX = firstTileX; tileX < cameraX + canvas.width; tileX += scaledWidth) {
        const screenX = tileX - cameraX;
        drawQuad(screenX, bgY, screenX + scaledWidth, bgY + topHeight, 0, 0, 1, splitV);
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      return;
    }
    drawSolidRect(0, 120, canvas.width, STREET_TOP, [0.24, 0.25, 0.28, 1]);
    drawSolidRect(0, STREET_TOP, canvas.width, canvas.height, [0.12, 0.13, 0.15, 1]);
    drawSolidRect(0, STREET_TOP - 2, canvas.width, STREET_TOP + 2, [0.34, 0.32, 0.28, 1]);
    drawSolidRect(0, 190, canvas.width, 192, [0.22, 0.23, 0.24, 1]);

    const gridSpacing = 80;
    const firstGridX = Math.floor(cameraX / gridSpacing) * gridSpacing;
    for (let worldX = firstGridX; worldX <= cameraX + canvas.width; worldX += gridSpacing) {
      const screenX = worldX - cameraX;
      drawSolidRect(screenX, 120, screenX + 1, canvas.height, [0.3, 0.31, 0.32, 0.35]);
    }

    const dashSpacing = 120;
    const firstDashX = Math.floor(cameraX / dashSpacing) * dashSpacing;
    for (let worldX = firstDashX; worldX <= cameraX + canvas.width; worldX += dashSpacing) {
      const screenX = worldX - cameraX;
      drawSolidRect(screenX, 205, screenX + 42, 207, [0.42, 0.4, 0.34, 0.8]);
    }
  }

  function drawForeground() {
    if (!levelBackground) return;
    const PROP_SCALE = 1.05;
    const vStart = 0.515;
    const vEnd = 0.725;
    const scaledWidth = levelBackground.width * PROP_SCALE;
    const propHeight = levelBackground.height * (vEnd - vStart) * PROP_SCALE;
    const propY = canvas.height - propHeight + 18;
    const parallaxCameraX = cameraX * 1.18;
    const firstTileX = Math.floor(parallaxCameraX / scaledWidth) * scaledWidth;

    gl.bindTexture(gl.TEXTURE_2D, levelBackground.texture);
    for (let tileX = firstTileX; tileX < parallaxCameraX + canvas.width; tileX += scaledWidth) {
      const screenX = tileX - parallaxCameraX;
      drawQuad(screenX + scaledWidth * 0.065, propY, screenX + scaledWidth * 0.13, propY + propHeight, 0.065, vStart, 0.13, vEnd);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  function drawPixelWebCocoon(enemy, enemyScreenX, enemyBottom, spriteHeight) {
    if (player.character === "venom") return;
    if (enemy.webPullState !== "stunned" && enemy.webPullState !== "pulling" && enemy.webStunTimer <= 0) return;

    const colors = linkPatternPalettes.spiderman;
    linkPixelMap.clear();
    let pixelCount = 0;
    const bandHalfWidth = 17;
    const bands = [
      { centerY: enemyBottom - spriteHeight * 0.66, slope: 0.12 },
      { centerY: enemyBottom - spriteHeight * 0.48, slope: -0.12 }
    ];

    for (const band of bands) {
      for (let distance = -14; distance <= 14; distance += 7) {
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 8; col++) {
            const symbol = linkPattern[row][col];
            if (symbol === ".") continue;

            const localAlong = distance + (col - 3.5);
            if (Math.abs(localAlong) > bandHalfWidth) continue;
            const localPerp = row - 2;
            const curveY = (localAlong / bandHalfWidth) ** 2 * 1.5;
            const px = Math.round(enemyScreenX + localAlong);
            const py = Math.round(band.centerY + band.slope * localAlong + curveY + localPerp);
            pixelCount = cacheLinkPixel(px, py, symbol, pixelCount);
          }
        }
      }
    }

    drawCachedLinkPixels(pixelCount, colors);
  }

  function drawPixelWebThread(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.max(1, Math.hypot(dx, dy));
    const dirX = dx / length;
    const dirY = dy / length;
    const perpX = -dirY;
    const perpY = dirX;
    const step = 7;
    const colors = linkPatternPalettes.spiderman;
    linkPixelMap.clear();
    let pixelCount = 0;

    for (let distance = 0; distance <= length; distance += step) {
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 8; col++) {
          const symbol = linkPattern[row][col];
          if (symbol === ".") continue;

          const localAlong = distance + (col - 3.5);
          const localPerp = row - 2;
          const px = Math.round(x1 + dirX * localAlong + perpX * localPerp - cameraX);
          const py = Math.round(y1 + dirY * localAlong + perpY * localPerp);
          pixelCount = cacheLinkPixel(px, py, symbol, pixelCount);
        }
      }
    }

    drawCachedLinkPixels(pixelCount, colors);
  }

  function drawPixelWebImpact(x, y) {
    const centerX = Math.round(x - cameraX);
    const centerY = Math.round(y);
    const impactPattern = [
      "...#...",
      "..###..",
      ".#G#G#.",
      "##W#W##",
      ".#GWW#.",
      "..#WW##",
      "...###."
    ];
    const colors = {
      "#": [0.03, 0.03, 0.05, 1],
      G: [0.76, 0.80, 0.86, 1],
      W: [1, 1, 1, 1]
    };

    for (let row = 0; row < impactPattern.length; row++) {
      for (let column = 0; column < impactPattern[row].length; column++) {
        const symbol = impactPattern[row][column];
        if (symbol === ".") continue;
        const pixelX = centerX - 3 + column;
        const pixelY = centerY - 3 + row;
        drawSolidRect(pixelX, pixelY, pixelX + 1, pixelY + 1, colors[symbol]);
      }
    }
  }

  function drawPlayerWebThreads() {
    if (player.character !== "spiderman") return;

    if (player.webYankEnemy || (player.isShootingWeb && player.shootWebTimer <= 0.28)) {
      const forward = player.facingRight ? 1 : -1;
      const handX = player.x + (player.facingRight ? 25 : -25);
      const handY = player.y - player.z - 70;
      const enemy = player.webYankEnemy;
      const endX = enemy ? enemy.x : handX + forward * 135;
      const targetY = enemy ? enemy.y - enemy.z - Math.round(enemy.h * 0.62) : handY;
      drawPixelWebThread(handX, handY, endX, targetY);
      if (!enemy) drawPixelWebImpact(endX, targetY);
    }

    if (player.isSwinging) {
      const animation = getPlayerAnimations()[player.state];
      const frameName = animation?.frames[player.frameIndex];
      const offset = swingHandOffsets[frameName];
      if (!offset) return;
      const direction = player.facingRight ? 1 : -1;
      const handX = player.x + direction * offset.dx;
      const handY = player.y - player.z - offset.dy;
      const swingAnchorX = player.swingStartX + direction * 75;
      drawPixelWebThread(handX, handY, swingAnchorX, 0);
    }
  }

  function drawTransformationEffect(actor, spriteY, frame) {
    if (!actor.isTransforming) return;
    const progress = 1 - actor.transformTimer / 0.85;
    const centerX = actor.x - cameraX;
    const chestY = spriteY - frame.h * 0.55;
    const spread = 8 + Math.sin(progress * Math.PI) * Math.max(frame.w * 0.42, frame.h * 0.2);
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8 + progress * Math.PI * 2;
      const x = centerX + Math.cos(angle) * spread;
      const y = chestY + Math.sin(angle) * spread * 0.72;
      const halfW = 3 + Math.abs(Math.cos(angle)) * 4;
      const halfH = 3 + Math.abs(Math.sin(angle)) * 5;
      drawSolidRect(x - halfW - 1, y - halfH - 1, x + halfW + 1, y + halfH + 1, [0.85, 0.88, 0.95, 0.6]);
      drawSolidRect(x - halfW, y - halfH, x + halfW, y + halfH, [0.05, 0.04, 0.08, 0.92]);
    }

    if (Math.abs(progress - 0.5) < 0.04) {
      const pulse = 1 + (0.04 - Math.abs(progress - 0.5)) * 18;
      const halfW = frame.w * 0.55 * pulse;
      const halfH = frame.h * 0.48 * pulse;
      const edge = 2;
      const color = [0.85, 0.9, 1, 0.72];
      drawSolidRect(centerX - halfW, chestY - halfH, centerX + halfW, chestY - halfH + edge, color);
      drawSolidRect(centerX - halfW, chestY + halfH - edge, centerX + halfW, chestY + halfH, color);
      drawSolidRect(centerX - halfW, chestY - halfH, centerX - halfW + edge, chestY + halfH, color);
      drawSolidRect(centerX + halfW - edge, chestY - halfH, centerX + halfW, chestY + halfH, color);
    }
  }

  let lastTime = 0;
  function gameLoop(timestamp) {
    const rawDt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    const dt = Math.min(rawDt, 0.05);

    if (justPressed["KeyG"] || justPressed["F2"]) player.invincible = !player.invincible;
    if (justPressed["F1"]) showDebugHelp = !showDebugHelp;
    if (justPressed["KeyH"]) showHitboxes = !showHitboxes;
    if (player.isDead && (justPressed["Enter"] || justPressed["KeyR"])) resetGame();
    goArrowTimer = Math.max(0, goArrowTimer - dt);
    screenShakeTimer = Math.max(0, screenShakeTimer - dt);

    player.hurtTimer = Math.max(0, player.hurtTimer - dt);
    player.invulnTimer = Math.max(0, player.invulnTimer - dt);
    if (player.isTransforming) {
      player.transformTimer = Math.max(0, player.transformTimer - dt);
      if (!player.transformSwitched && player.transformTimer <= 0.42) {
        const hpRatio = player.hp / player.maxHp;
        player.character = player.character === "spiderman" ? "venom" : "spiderman";
        player.maxHp = player.character === "venom" ? VENOM_MAX_HP : SPIDERMAN_MAX_HP;
        player.hp = Math.round(player.maxHp * hpRatio);
        player.transformSwitched = true;
      }
      if (player.transformTimer <= 0) {
        player.isTransforming = false;
        player.transformSwitched = false;
        setState("idle");
      }
    }
    if (player.hp <= 0 && !player.isDead) markPlayerDead();
    if (player.isDead) {
      setState("dead");
    } else if (player.hurtTimer > 0) {
      setState("pain");
    } else if (player.state === "pain") {
      setState("idle");
    }
    let controlsLocked = player.isDead || player.hurtTimer > 0 || player.isTransforming;

    // --- 1. LECTURA DE CONTROLES ---
    let moveX = 0;
    let moveY = 0;

    if (keys["ArrowLeft"] || keys["KeyA"]) moveX -= 1;
    if (keys["ArrowRight"] || keys["KeyD"]) moveX += 1;
    if (keys["ArrowUp"] || keys["KeyW"]) moveY -= 1;
    if (keys["ArrowDown"] || keys["KeyS"]) moveY += 1;

    if (moveX !== 0 && moveY !== 0) {
      moveX *= 0.7071;
      moveY *= 0.7071;
    }

    const climbUpDown = keys["ArrowUp"] || keys["KeyW"] ? -1
      : keys["ArrowDown"] || keys["KeyS"] ? 1
        : 0;
    const isGrounded = player.z === 0;
    if (!player.isClimbing && !controlsLocked && !player.isDead && player.hurtTimer <= 0
      && player.z >= 18 && player.y <= STREET_TOP + 6
      && (keys["ArrowUp"] || keys["KeyW"])
      && !player.isSwinging && !player.isBackflipping && !player.isSpecialAttacking) {
      player.isClimbing = true;
      player.vz = 0;
      player.jumpDirX = 0;
      player.jumpDirY = 0;
      player.y = STREET_TOP;
      player.isAttacking = false;
      player.wallJumpTimer = 0;
      isRunning = false;
      setState("climb");
    }
    const transformPressed = justPressed["KeyT"] || justPressed["Tab"]
      || (justPressed["KeyC"] && (keys["ShiftLeft"] || keys["ShiftRight"]));
    if (transformPressed && venomAtlas && !controlsLocked && isGrounded
      && !player.isAttacking && !player.isReleasing && !player.isShootingWeb
      && !player.isSwinging && !player.isBackflipping && !player.isSpecialAttacking
      && player.state !== "web_shield") {
      clearPlayerActionStates();
      player.isTransforming = true;
      player.transformTimer = 0.85;
      setState("idle");
      playSFX("transform");
      controlsLocked = true;
    }
    const playerStartX = player.x;
    const playerStartY = player.y;
    const now = timestamp / 1000;
    const activeWave = waves.find((wave) => wave.spawned && !wave.cleared);

    const attackPressed = justPressed["KeyJ"] || justPressed["KeyZ"];
    const powerHitPressed = justPressed["KeyN"] || justPressed["KeyV"];
    const oppositeDirectionHeld = player.facingRight
      ? (keys["ArrowLeft"] || keys["KeyA"])
      : (keys["ArrowRight"] || keys["KeyD"]);
    const oppositeDirectionPressed = player.facingRight
      ? justPressedHorizontal.left
      : justPressedHorizontal.right;
    const throwPressed = justPressed["KeyK"] || justPressed["KeyV"]
      || (oppositeDirectionHeld && attackPressed)
      || (oppositeDirectionPressed && (keys["KeyJ"] || keys["KeyZ"]));

    if (!controlsLocked && isGrounded && player.vz === 0 && player.grabbedEnemy && !player.isGrabbing && !player.isAttacking && !player.isReleasing) {
      if (isHoldingDrone() && (attackPressed || throwPressed)) {
        const invertDroneThrowDirection = oppositeDirectionHeld || oppositeDirectionPressed;
        throwGrabbedEnemy(invertDroneThrowDirection);
      } else if (throwPressed) {
        throwGrabbedEnemy();
      } else if (attackPressed) {
        performGrabPunch();
      }
    } else if (!controlsLocked && isGrounded && player.vz === 0 && player.character === "spiderman"
      && powerHitPressed && !player.grabbedEnemy && !player.isAttacking && !player.isReleasing
      && !player.isShootingWeb && !player.isSwinging && !player.isBackflipping && !player.isSpecialAttacking) {
      startGroundAttack("power_hit");
    } else if (!controlsLocked && isGrounded && player.vz === 0 && attackPressed && !player.grabbedEnemy && !player.isReleasing && !player.isShootingWeb
      && !player.isSwinging && !player.isBackflipping && !player.isSpecialAttacking) {
      if (player.character === "venom" && isRunning) {
        startGroundAttack("run_attack");
      } else if (player.isAttacking) {
        if (player.state === "punch") {
          startGroundAttack("knee");
        } else if (player.state === "knee") {
          startGroundAttack("uppercut");
        }
      } else if (player.comboWindowStage === 1 && player.comboWindowTimer > 0) {
        startGroundAttack("knee");
      } else {
        startGroundAttack("punch");
      }
    }

    if (player.character === "spiderman" && !controlsLocked && isGrounded && player.vz === 0
      && (justPressed["KeyL"] || justPressed["KeyX"])
      && !player.isAttacking && !player.grabbedEnemy && !player.isReleasing
      && !player.isShootingWeb && !player.isSwinging && !player.isBackflipping && !player.isSpecialAttacking) {
      player.isShootingWeb = true;
      player.shootWebTimer = 0;
      player.hasHitThisAttack = false;
      isRunning = false;
      setState("shoot_web");
      playSFX("web");
    }

    const shieldHeld = keys["KeyI"] || keys["KeyC"];
    const isShielding = !controlsLocked && isGrounded && player.vz === 0 && shieldHeld && !player.isAttacking
      && !player.grabbedEnemy && !player.isReleasing
      && !player.isSwinging && !player.isBackflipping && !player.isSpecialAttacking;

    if (!controlsLocked && isGrounded && player.vz === 0 && !player.isAttacking && !player.grabbedEnemy && !player.isReleasing
      && !isShielding && !player.isShootingWeb
      && !player.isSwinging && !player.isBackflipping && !player.isSpecialAttacking) {
      if (justPressed["KeyU"] || justPressed["KeyQ"]) {
        player.comboWindowTimer = 0;
        player.comboWindowStage = 0;
        if (player.character === "venom") {
          player.vz = 290;
          player.jumpDirX = player.facingRight ? 1.45 : -1.45;
          player.jumpDirY = 0;
          player.maxJumpZ = 0;
          setState("jump_forward");
        } else {
          player.isSwinging = true;
          player.swingStartX = player.x;
          player.maxJumpZ = 0;
          player.specialMoveTimer = 0;
          setState("web_swing");
        }
      } else if (justPressed["KeyO"] || justPressed["KeyE"]) {
        player.isBackflipping = true;
        player.specialMoveTimer = 0;
        player.comboWindowTimer = 0;
        player.comboWindowStage = 0;
        setState("backflip");
      } else if (justPressed["KeyP"] || justPressed["ShiftLeft"]) {
        player.isSpecialAttacking = true;
        player.hasHitThisAttack = false;
        player.specialMoveTimer = 0;
        player.comboWindowTimer = 0;
        player.comboWindowStage = 0;
        setState("special_attack");
      }
    }

    const isSpecialMoveActive = player.isSwinging || player.isBackflipping || player.isSpecialAttacking;

    if (!controlsLocked && isGrounded && !player.isAttacking && !player.isShootingWeb && !isShielding && !isSpecialMoveActive && moveX < 0 && justPressedHorizontal.left) {
      if (now - lastLeftTap < DOUBLE_TAP_INTERVAL) isRunning = true;
      lastLeftTap = now;
    }
    if (!controlsLocked && isGrounded && !player.isAttacking && !player.isShootingWeb && !isShielding && !isSpecialMoveActive && moveX > 0 && justPressedHorizontal.right) {
      if (now - lastRightTap < DOUBLE_TAP_INTERVAL) isRunning = true;
      lastRightTap = now;
    }

    if (controlsLocked || moveX === 0 || player.isAttacking || player.isShootingWeb || player.grabbedEnemy || player.isReleasing || isShielding || isSpecialMoveActive) isRunning = false;
    player.speedX = isRunning ? RUN_SPEED_X : WALK_SPEED_X;

    // --- 2. INICIAR SALTO ---
    if (!controlsLocked && (keys["Space"] || keys["KeyK"]) && isGrounded && !player.isAttacking && !player.grabbedEnemy && !player.isReleasing && !isShielding
      && !player.isShootingWeb && !isSpecialMoveActive) {
      player.vz = player.character === "venom" ? VENOM_JUMP_FORCE : JUMP_FORCE;
      player.maxJumpZ = 0;
      player.jumpDirX = moveX;
      player.jumpDirY = moveY;
      player.comboWindowTimer = 0;
      player.comboWindowStage = 0;

      if (moveX !== 0) {
        const isJumpingBackward = player.character === "spiderman"
          && Math.sign(moveX) !== (player.facingRight ? 1 : -1);
        setState(isJumpingBackward ? "jump_back" : "jump_forward");
      } else {
        setState("jump_up");
      }
    }

    // --- 3. ATAQUES AÉREOS ---
    if (!controlsLocked && player.z > 0 && (justPressed["KeyJ"] || justPressed["KeyZ"])) {
      if (player.state === "jump_forward" || player.state === "jump_back") {
        player.hasHitThisAttack = false;
        setState("jump_kick");
        const forwardDirection = player.jumpDirX !== 0
          ? Math.sign(player.jumpDirX)
          : (player.facingRight ? 1 : -1);
        player.jumpDirX += forwardDirection * 0.35;
      } else if (player.state === "jump_up") {
        player.hasHitThisAttack = false;
        setState("jump_up_kick");
      }
    }

    // --- 4. MOVIMIENTO Y FÍSICA EN EL AIRE VS SUELO ---
    if (player.isDead) {
      setState("dead");
    } else if (player.hurtTimer > 0) {
      setState("pain");
      if (player.z > 0) {
        player.z += player.vz * dt;
        player.vz -= GRAVITY * dt;
        if (player.z <= 0) {
          player.z = 0;
          player.vz = 0;
          resolvePlayerLanding();
        }
      }
    } else if (player.isTransforming) {
      // La transformación bloquea el movimiento hasta completarse.
    } else if (player.isClimbing) {
      if (justPressed["Space"] || justPressed["KeyK"]) {
        player.isClimbing = false;
        player.vz = 210;
        player.jumpDirY = 0.85;
        player.jumpDirX = moveX * 0.8;
        player.wallJumpTimer = 0;
        if (moveX !== 0) player.facingRight = moveX > 0;
        setState("jump_from_wall");
      } else {
        player.vz = 0;
        player.z = Math.max(12, Math.min(105, player.z - climbUpDown * 65 * dt));
        player.x += moveX * 60 * dt;
        const minClimbX = activeWave ? activeWave.lockCameraX + 20 : 20;
        const maxClimbX = activeWave ? activeWave.lockCameraX + canvas.width - 20 : LEVEL_WIDTH - 20;
        player.x = Math.max(minClimbX, Math.min(maxClimbX, player.x));
        player.y = STREET_TOP;
        if (moveX !== 0) player.facingRight = moveX > 0;

        if (player.z <= 14) {
          player.isClimbing = false;
          setState("jump_forward");
        } else if (moveX !== 0 || climbUpDown !== 0) {
          setState(moveX !== 0 && Math.abs(moveX) > Math.abs(climbUpDown)
            ? "climb_sideways"
            : "climb");
        }
      }
    } else if (player.isSwinging) {
      const elapsed = player.specialMoveTimer;
      const swingDuration = getAnimationDuration("web_swing");
      const moveDt = Math.min(dt, Math.max(0, swingDuration - elapsed));
      player.specialMoveTimer += dt;
      const progress = Math.min(1, player.specialMoveTimer / swingDuration);
      player.x += (player.facingRight ? 1 : -1) * 135 * moveDt;
      player.z = 45 * Math.sin(Math.PI * progress);
      player.vz = 0;
    } else if (player.isBackflipping) {
      const elapsed = player.specialMoveTimer;
      const backflipDuration = getAnimationDuration("backflip");
      const moveDt = Math.min(dt, Math.max(0, backflipDuration - elapsed));
      player.specialMoveTimer += dt;
      const progress = Math.min(1, player.specialMoveTimer / backflipDuration);
      player.x += (player.facingRight ? -1 : 1) * 130 * moveDt;
      player.z = 30 * Math.sin(Math.PI * progress);
      player.vz = 0;
    } else if (player.isSpecialAttacking) {
      // La animación especial bloquea el movimiento hasta terminar.
    } else if (player.isAttacking && player.state === "run_attack") {
      const attackDuration = getAnimationDuration("run_attack");
      const moveDt = Math.min(dt, Math.max(0, attackDuration - player.animTimer));
      player.x += (player.facingRight ? 1 : -1) * 140 * moveDt;
    } else if (player.grabbedEnemy) {
      player.grappleTimer -= dt;
      if (player.grappleTimer <= 0) {
        releaseGrapple();
      } else {
        if (!player.isAttacking && !player.isGrabbing) {
          player.x += moveX * 45 * dt;
          player.y += moveY * 45 * dt;
          setState(getGrabMovementState(moveX !== 0 || moveY !== 0));
        }
        positionGrabbedEnemy();
      }
    } else if (player.isReleasing) {
      // Mantener la animación de liberación hasta su último frame.
    } else if (isGrounded && player.vz === 0) {
      if (!player.isAttacking && !player.isShootingWeb && !isShielding) {
        player.x += moveX * player.speedX * dt;
        player.y += moveY * player.speedY * dt;

        if (moveX > 0) player.facingRight = true;
        if (moveX < 0) player.facingRight = false;
      }

      if (!player.isAttacking && !player.isShootingWeb) {
        if (isShielding) {
          setState("web_shield");
        } else if (moveX !== 0 || moveY !== 0) {
          setState(isRunning && moveX !== 0 ? "run" : "walk");
        } else {
          setState("idle");
        }
      }
    } else {
      // En el aire conserva la inercia horizontal con ligero control aéreo
      const airMoveX = player.jumpDirX !== 0 ? player.jumpDirX : moveX * 0.4;
      const airMoveY = player.jumpDirY !== 0 ? player.jumpDirY : moveY * 0.4;

      player.x += airMoveX * (player.speedX * 1.15) * dt;
      player.y += airMoveY * player.speedY * dt;

      // Aplicar velocidad vertical y gravedad en el Eje Z
      player.z += player.vz * dt;
      player.vz -= GRAVITY * dt;

      // Aterrizaje al tocar el suelo
      if (player.z <= 0) {
        player.z = 0;
        player.vz = 0;
        resolvePlayerLanding();
        setState(player.character === "venom" ? "jump_land" : "idle");
      }
    }

    player.maxJumpZ = Math.max(player.maxJumpZ, player.z);

    // La cámara sigue al jugador en ambas direcciones salvo durante una oleada activa.
    const maxCameraX = LEVEL_WIDTH - canvas.width;
    const targetCameraX = player.x - canvas.width * 0.45;
    if (activeWave) {
      cameraX = activeWave.lockCameraX;
      player.x = Math.max(cameraX + 20, Math.min(cameraX + canvas.width - 20, player.x));
    } else {
      cameraX = Math.max(0, Math.min(maxCameraX, targetCameraX));
      player.x = Math.max(20, Math.min(LEVEL_WIDTH - 20, player.x));
    }
    player.y = Math.max(STREET_TOP, Math.min(STREET_BOTTOM, player.y));

    if (!controlsLocked && isGrounded && player.z === 0 && player.vz === 0 && !player.grabbedEnemy && !player.isAttacking && !player.isReleasing
      && !player.isShootingWeb && !isShielding && !isSpecialMoveActive && (moveX !== 0 || moveY !== 0)) {
      const target = enemies.find((enemy) => {
        if (enemy.hp <= 0 || enemy.downState !== null || enemy.isGrabbed || enemy.isThrown) return false;
        if (player.character === "venom" && enemy.type === "drone_chun") return false;
        const approachX = enemy.x - playerStartX;
        const approachY = enemy.y - playerStartY;
        const distanceX = enemy.x - player.x;
        const distanceY = enemy.y - player.y;
        const movingTowardEnemy = moveX * approachX + moveY * approachY > 0;
        return movingTowardEnemy && Math.abs(distanceX) < 24 && Math.abs(distanceY) < 12;
      });

      if (target) {
        if (target.x !== player.x) player.facingRight = target.x > player.x;
        player.grabbedEnemy = target;
        player.isGrabbing = true;
        player.grappleTimer = 2.5;
        player.grabHits = 0;
        player.isAttacking = false;
        isRunning = false;
        player.speedX = WALK_SPEED_X;
        target.isGrabbed = true;
        cancelEnemyAttack(target);
        target.vx = 0;
        target.vz = 0;
        target.x = player.x + (player.facingRight ? 20 : -20);
        target.y = player.y;
        target.facingRight = !player.facingRight;
        setState(getGrabStartState());
      }
    }

    if (player.grabbedEnemy) positionGrabbedEnemy();
    for (const wave of waves) {
      if (!wave.spawned && player.x >= wave.triggerX) {
        for (const spawn of wave.spawns) {
          const type = enemyTypes[nextEnemyTypeIndex % enemyTypes.length];
          nextEnemyTypeIndex++;
          enemies.push(createEnemy(spawn.x, spawn.y, type));
        }
        wave.spawned = true;
      }
      if (wave.spawned && !wave.cleared && !enemies.some((enemy) => enemy.hp > 0)) {
        wave.cleared = true;
        goArrowTimer = 2.5;
        playSFX("go");
      }
    }
    updateEnemies(dt);

    // --- 5. ACTUALIZAR ANIMACIÓN ---
    if (player.isShootingWeb && !player.webYankEnemy) {
      player.shootWebTimer += dt;
      player.animTimer = 0;
      const venomWebAnimation = player.character === "venom";
      const webDuration = venomWebAnimation ? getAnimationDuration("shoot_web") : 0.28;
      if (venomWebAnimation) {
        const webAnimation = getPlayerAnimations().shoot_web;
        player.frameIndex = Math.min(webAnimation.frames.length - 1, Math.floor(player.shootWebTimer / webAnimation.speed));
      } else {
        player.frameIndex = 0;
      }
      if (player.shootWebTimer >= webDuration) {
        player.isShootingWeb = false;
        player.shootWebTimer = 0;
        setState("idle");
      }
    }

    if (player.comboWindowTimer > 0) {
      player.comboWindowTimer -= dt;
      if (player.comboWindowTimer <= 0) {
        player.comboWindowTimer = 0;
        player.comboWindowStage = 0;
      }
    }

    let currentAnim = getPlayerAnimations()[player.state];
    const shootingWebAnimationActive = player.state === "shoot_web" && player.isShootingWeb;
    const isClimbingIdle = player.isClimbing && moveX === 0 && climbUpDown === 0;
    if (player.state === "jump_from_wall" && !player.webYankEnemy && !shootingWebAnimationActive) {
      player.wallJumpTimer += dt;
      if (player.wallJumpTimer >= currentAnim.speed) {
        player.wallJumpTimer = 0;
        setState(player.z > 0 ? "jump_forward" : "idle");
      }
    } else if (!player.webYankEnemy && !shootingWebAnimationActive && !isClimbingIdle) {
      player.animTimer += dt;
      if (player.animTimer >= currentAnim.speed) {
        player.animTimer = 0;
        if (currentAnim.loop) {
          player.frameIndex = (player.frameIndex + 1) % currentAnim.frames.length;
        } else if (player.frameIndex < currentAnim.frames.length - 1) {
          player.frameIndex++;
        } else if (player.grabbedEnemy && (player.state === "grab" || player.state === "lift")) {
          player.isGrabbing = false;
          setState(isHoldingDrone() ? "lift_hold" : "hold");
        } else if (player.state === "jump_land") {
          setState("idle");
        } else if (player.isAttacking && player.state === "punch") {
          finishPunchAndOpenComboWindow();
        } else if (player.isAttacking) {
          finishGroundAttack();
        } else if (player.isReleasing && player.state === "release") {
          player.isReleasing = false;
          setState("idle");
        } else if (player.isSwinging && player.state === "web_swing") {
          player.isSwinging = false;
          player.specialMoveTimer = 0;
          player.z = 0;
          player.vz = 0;
          player.maxJumpZ = 0;
          setState("idle");
        } else if (player.isBackflipping && player.state === "backflip") {
          player.isBackflipping = false;
          player.specialMoveTimer = 0;
          player.z = 0;
          player.vz = 0;
          setState("idle");
        } else if (player.isSpecialAttacking && player.state === "special_attack") {
          player.isSpecialAttacking = false;
          player.specialMoveTimer = 0;
          setState("idle");
        }
      }
    }
    currentAnim = getPlayerAnimations()[player.state];

    const activeHitbox = getPlayerAttackHitbox();
    applyAttackHitbox(activeHitbox);
    removeDeadEnemies();

    // --- 6. RENDERIZADO WEBGL ---
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.15, 0.15, 0.2, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(resLocation, canvas.width, canvas.height);
    const screenShakeOffset = screenShakeTimer > 0 ? Math.round((Math.random() * 2 - 1) * 3) : 0;
    gl.uniform1f(yOffsetLocation, screenShakeOffset);
    drawWorld();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    renderList.length = 0;
    renderList.push(playerRenderItem);
    for (const enemy of enemies) {
      if (enemy.hp > 0 || !enemy.readyToRemove) renderList.push(getRenderItem("enemy", enemy));
    }
    renderList.sort(compareRenderItems);

    for (const item of renderList) {
      if (item.type === "player" && player.invulnTimer > 0
        && Math.floor((1.0 - player.invulnTimer) / 0.08) % 2 === 1) {
        continue;
      }

      if (item.type === "enemy") {
        const enemy = item.entity;
        if (enemy.type === "drone_chun" && enemy.hp <= 0 && enemy.downState === "dead"
          && Math.floor((0.35 - enemy.downTimer) / 0.05) % 2 === 1) {
          continue;
        }
        const enemyScreenX = enemy.x - cameraX;
        const enemyBottom = enemy.y - enemy.z;
        let spriteHeight = enemy.h;
        let enemyAnimation = enemy.animations[enemy.animState] || enemy.animations.idle;
        let enemyFrameName = enemyAnimation && enemyAnimation.frames.length
          ? enemyAnimation.frames[enemy.frameIndex % enemyAnimation.frames.length]
          : null;
        let enemyFrame = enemyAtlas && enemyFrameName ? enemyAtlas.frames[enemyFrameName] : null;
        if (enemyAtlas && !enemyFrame && enemy.animations.idle && enemy.animations.idle.frames.length) {
          const fallbackName = enemy.animations.idle.frames[0];
          enemyFrame = enemyAtlas.frames[fallbackName];
          const errorKey = `${enemy.type}.${enemy.animState}.${enemyFrameName}`;
          if (!loggedEnemyFrameErrors.has(errorKey)) {
            loggedEnemyFrameErrors.add(errorKey);
            console.error(`[Atlas enemigos] ${errorKey} no existe; se muestra ${fallbackName}.`);
          }
        }
        if (enemyAtlas && enemyFrame) {
          const frame = enemyFrame.frame;
          spriteHeight = frame.h;
          const isDroneShooting = enemy.type === "drone_chun" && enemy.animState === "shoot";
          const droneBaseWidth = isDroneShooting ? enemyAtlas.frames.drone_chun_idle_01.frame.w : 0;
          const spriteX1 = isDroneShooting
            ? (enemy.facingRight
              ? Math.round(enemyScreenX - Math.floor(droneBaseWidth / 2))
              : Math.round(enemyScreenX + Math.ceil(droneBaseWidth / 2) - frame.w))
            : Math.round(enemyScreenX - frame.w / 2);
          let u1 = frame.x / enemyAtlas.width;
          let u2 = (frame.x + frame.w) / enemyAtlas.width;
          const flipHorizontal = enemy.type === "drone_chun" ? enemy.facingRight : !enemy.facingRight;
          if (flipHorizontal) {
            const temp = u1;
            u1 = u2;
            u2 = temp;
          }
          gl.bindTexture(gl.TEXTURE_2D, enemyAtlas.texture);
          drawQuad(
            spriteX1,
            Math.round(enemyBottom - frame.h),
            isDroneShooting ? spriteX1 + frame.w : Math.round(enemyScreenX + frame.w / 2),
            Math.round(enemyBottom),
            u1,
            frame.y / enemyAtlas.height,
            u2,
            (frame.y + frame.h) / enemyAtlas.height
          );
        } else if (!enemyAtlas) {
          drawSolidRect(enemyScreenX - enemy.w / 2, enemyBottom - enemy.h, enemyScreenX + enemy.w / 2, enemyBottom, [0.68, 0.16, 0.14, 1]);
        }
        drawPixelWebCocoon(enemy, enemyScreenX, enemyBottom, spriteHeight);
        if (enemy.hp > 0) {
          drawSolidRect(enemyScreenX - 16, enemyBottom - spriteHeight - 6, enemyScreenX + 16, enemyBottom - spriteHeight - 3, [0.2, 0.12, 0.12, 1]);
          drawSolidRect(
            enemyScreenX - 15,
            enemyBottom - spriteHeight - 5,
            enemyScreenX - 15 + 30 * enemy.hp / enemy.maxHp,
            enemyBottom - spriteHeight - 4,
            [0.2, 0.85, 0.28, 1]
          );
        }
      } else {
        const actor = item.entity;
        let actorAtlasFrames = frames;
        let actorAnimations = animations;
        let actorTexture = texture;
        let actorWidth = image.width;
        let actorHeight = image.height;
        if (actor === player && venomAtlas) {
          const isMidTransform = player.isTransforming && player.transformTimer <= 0.55 && player.transformTimer >= 0.30;
          const showVenom = isMidTransform
            ? Math.floor(timestamp / 50) % 2 === 1
            : player.character === "venom";
          if (showVenom) {
            actorAtlasFrames = venomAtlas.frames;
            actorAnimations = venomAnimations;
            actorTexture = venomAtlas.texture;
            actorWidth = venomAtlas.width;
            actorHeight = venomAtlas.height;
          }
        }
        const actorAnimation = actorAnimations[actor.state];
        if (!actorAnimation || actorAnimation.frames.length === 0) {
          console.error(`[Animación] Estado vacío o inexistente: ${actor.state} (${actor === player && player.character === "venom" ? "Venom" : "Spider-Man"}).`);
          continue;
        }
        const frameName = actorAnimation.frames[actor.frameIndex % actorAnimation.frames.length];
        const frameData = actorAtlasFrames[frameName];
        if (!frameData) {
          console.error(`[Animación] Frame ${frameName} no existe en el atlas de ${actor === player && player.character === "venom" ? "Venom" : "Spider-Man"}.`);
          continue;
        }
        const frame = frameData.frame;
        gl.bindTexture(gl.TEXTURE_2D, actorTexture);
        const screenX = Math.round(actor.x - cameraX);
        const spriteY = Math.round(actor.y - actor.z);
        const webBaseWidth = 82;
        const isVenomWebShot = actor === player && player.character === "venom" && actor.state === "shoot_web";
        const x1 = isVenomWebShot
          ? (actor.facingRight ? screenX - Math.floor(webBaseWidth / 2) : screenX + Math.ceil(webBaseWidth / 2) - frame.w)
          : screenX - Math.floor(frame.w / 2);
        const y1 = spriteY - frame.h;
        const x2 = x1 + frame.w;
        const y2 = y1 + frame.h;

        let u1 = frame.x / actorWidth;
        let u2 = (frame.x + frame.w) / actorWidth;
        const v1 = frame.y / actorHeight;
        const v2 = (frame.y + frame.h) / actorHeight;

        if (!actor.facingRight) {
          const temp = u1;
          u1 = u2;
          u2 = temp;
        }

        drawQuad(x1, y1, x2, y2, u1, v1, u2, v2);
        if (actor === player) drawTransformationEffect(actor, spriteY, frame);
      }
    }

    if (showHitboxes && activeHitbox) {
      drawSolidRect(
        activeHitbox.x1 - cameraX,
        player.y - activeHitbox.z2,
        activeHitbox.x2 - cameraX,
        player.y - activeHitbox.z1,
        [1, 0.2, 0.12, 0.25]
      );
    }
    drawPlayerWebThreads();
    drawForeground();
    drawHUD();

    requestAnimationFrame(gameLoop);

    for (const code in justPressed) justPressed[code] = false;
    justPressedHorizontal.left = false;
    justPressedHorizontal.right = false;
  }

  requestAnimationFrame(gameLoop);
}

init();
