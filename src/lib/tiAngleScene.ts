import type { Material, Mesh, Texture } from "three";
import {
  cartesianToTiAngle,
  containImageRect,
  frameMarkerRotationDeg,
  normalizeTiAngleDegrees,
  sphericalToTiAngle,
  type TiAngleDragMode,
} from "./tiAngleGeometry";
import { TI_ANGLE_FRAMINGS } from "./tiAngle";
import type { TiAngleConfig, TiAngleLightStyle } from "@/types/workflow";

type ThreeModule = typeof import("./tiAngleThreeRuntime");
type RendererModule = typeof import("./tiAngleThreeRenderer");
type SceneRenderer = InstanceType<RendererModule["WebGLRenderer"]>;

export interface TiAngleSceneApi {
  render: () => void;
  hitTest: (clientX: number, clientY: number) => TiAngleDragMode | null;
  drag: (
    start: TiAngleConfig,
    mode: TiAngleDragMode,
    startClientX: number,
    startClientY: number,
    clientX: number,
    clientY: number,
  ) => TiAngleConfig;
  resize: (width: number, height: number) => void;
  zoom: (deltaY: number) => void;
  dispose: () => void;
}

export interface TiAngleSceneOptions {
  THREE: ThreeModule;
  renderer: SceneRenderer;
  canvas: HTMLCanvasElement;
  image?: string;
  getConfig: () => TiAngleConfig;
  onTextureState: (state: "loaded" | "error") => void;
}

const ORBIT_RADIUS = 1.85;
const MARKER_RADIUS = 1.35;
const ORBIT_Y = -0.94;
const CAMERA_DISTANCE_MIN = 4.2;
const CAMERA_DISTANCE_MAX = 14;
const EPSILON = 1e-8;

const LIGHT_RADIUS = 2.05;

/** Per-style gizmo appearance; "default" applies when lighting.style is unset. coneScale 0 hides the beam. */
const LIGHT_STYLE_APPEARANCES: Record<TiAngleLightStyle | "default", { color: string; markerScale: number; rayOpacity: number; coneScale: number }> = {
  cinematic: { color: "#fbbf24", markerScale: 1, rayOpacity: 0.5, coneScale: 1 },
  studio: { color: "#f8fafc", markerScale: 1, rayOpacity: 0.55, coneScale: 1 },
  soft: { color: "#e2e8f0", markerScale: 1.5, rayOpacity: 0.3, coneScale: 0 },
  volumetric: { color: "#fde68a", markerScale: 1, rayOpacity: 0.65, coneScale: 2.6 },
  stage: { color: "#fca5a5", markerScale: 1, rayOpacity: 0.6, coneScale: 2.2 },
  ambient: { color: "#a5b4fc", markerScale: 0.8, rayOpacity: 0.2, coneScale: 0 },
  default: { color: "#fbbf24", markerScale: 1, rayOpacity: 0.5, coneScale: 1 },
};
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Framing index 0 (全身照) sits out at the orbit ring; the last tier (超特写) closest to the subject. */
const FRAMING_RADIUS_FAR = ORBIT_RADIUS;
const FRAMING_RADIUS_NEAR = 1.0;

/** Camera-rig distance: unspecified framing keeps the legacy MARKER_RADIUS look. */
function markerRadius(config: TiAngleConfig): number {
  if (!config.framing) return MARKER_RADIUS;
  const index = TI_ANGLE_FRAMINGS.findIndex((option) => option.value === config.framing);
  if (index < 0) return MARKER_RADIUS;
  const t = TI_ANGLE_FRAMINGS.length > 1 ? index / (TI_ANGLE_FRAMINGS.length - 1) : 0;
  return FRAMING_RADIUS_FAR - t * (FRAMING_RADIUS_FAR - FRAMING_RADIUS_NEAR);
}

function createRectGeometry(THREE: ThreeModule, width: number, height: number) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-halfWidth, -halfHeight, 0),
    new THREE.Vector3(halfWidth, -halfHeight, 0),
    new THREE.Vector3(halfWidth, halfHeight, 0),
    new THREE.Vector3(-halfWidth, halfHeight, 0),
  ]);
}

function createArcGeometry(THREE: ThreeModule) {
  const points = Array.from({ length: 49 }, (_, index) => {
    const angle = ((-45 + (index / 48) * 105) * Math.PI) / 180;
    return new THREE.Vector3(-Math.cos(angle) * ORBIT_RADIUS, Math.sin(angle) * ORBIT_RADIUS, 0);
  });
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, 0.026, 8, false);
}

/**
 * Builds the 3D preview scene without touching React state. Angles come from
 * `getConfig()` at render time so pointer drags can re-render without a React
 * commit on every move.
 */
export function createTiAngleScene(options: TiAngleSceneOptions): TiAngleSceneApi {
  const { THREE, renderer, canvas, image, getConfig, onTextureState } = options;
  let disposed = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40);
  camera.position.set(4, 3, 6);
  camera.lookAt(0, 0, 0);
  const accent = new THREE.Color("#dfff45");
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3);
  keyLight.position.set(-3, 6, 5);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.7);
  fillLight.position.set(4, 1, -3);
  scene.add(fillLight);

  const imageMaterial = new THREE.MeshBasicMaterial({
    color: image ? 0xffffff : 0x68686b,
    side: THREE.FrontSide,
  });
  const imagePlane = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.8), imageMaterial);
  scene.add(imagePlane);
  // A neutral back prevents the source photograph from looking like a generated rear view.
  const imageBack = new THREE.Mesh(
    new THREE.PlaneGeometry(1.35, 1.8),
    new THREE.MeshBasicMaterial({ color: 0x505054, side: THREE.BackSide }),
  );
  scene.add(imageBack);
  const cardBorder = new THREE.LineLoop(
    createRectGeometry(THREE, 1.35, 1.8),
    new THREE.LineBasicMaterial({ color: 0xbebec2 }),
  );
  scene.add(cardBorder);
  const cardTop = new THREE.Mesh(
    new THREE.ConeGeometry(0.055, 0.12, 3),
    new THREE.MeshBasicMaterial({ color: accent }),
  );
  cardTop.position.set(0, 0.78, 0.012);
  scene.add(cardTop);

  // Faint polar grid gives the eye a ground plane when judging elevation.
  const ground = new THREE.PolarGridHelper(2.4, 8, 3, 64, 0x5c5c60, 0x46464a);
  ground.position.y = ORBIT_Y - 0.03;
  const groundMaterial = ground.material as Material & { transparent: boolean; opacity: number };
  groundMaterial.transparent = true;
  groundMaterial.opacity = 0.45;
  scene.add(ground);

  const orbitMaterial = new THREE.MeshStandardMaterial({ color: 0xc5c5c8, roughness: 0.48, metalness: 0.15 });
  const orbit = new THREE.Mesh(new THREE.TorusGeometry(ORBIT_RADIUS, 0.028, 8, 96), orbitMaterial);
  orbit.rotation.x = Math.PI / 2;
  orbit.position.y = ORBIT_Y;
  scene.add(orbit);
  const elevationArc = new THREE.Mesh(createArcGeometry(THREE), orbitMaterial);
  scene.add(elevationArc);

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 24, 16),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.25, roughness: 0.35 }),
  );
  scene.add(ball);

  const cameraRig = new THREE.Group();
  const cameraArrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.36, 4),
    new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 }),
  );
  cameraArrow.rotation.x = Math.PI / 2;
  cameraArrow.position.z = 0.3;
  cameraRig.add(cameraArrow);
  const frame = new THREE.LineLoop(
    createRectGeometry(THREE, 0.38, 0.27),
    new THREE.LineBasicMaterial({ color: accent }),
  );
  const frameTop = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.06, 0.135, 0),
      new THREE.Vector3(0, 0.22, 0),
      new THREE.Vector3(0.06, 0.135, 0),
    ]),
    new THREE.LineBasicMaterial({ color: accent }),
  );
  frame.add(frameTop);
  frame.position.z = 0.52;
  cameraRig.add(frame);
  // Roll knob rides on the viewfinder frame so its orbit visualizes the tilt axis.
  const rollKnob = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1 }),
  );
  rollKnob.position.set(0, 0.2, 0);
  frame.add(rollKnob);
  scene.add(cameraRig);

  const azimuthHandle = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.24, metalness: 0.2 }),
  );
  scene.add(azimuthHandle);

  const elevationHandle = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0xaaaaae, roughness: 0.3, metalness: 0.18 }),
  );
  scene.add(elevationHandle);

  const createHitTarget = (radius: number) => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    material.colorWrite = false;
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material);
  };
  const ballHitTarget = createHitTarget(0.28);
  const azimuthHitTarget = createHitTarget(0.22);
  const elevationHitTarget = createHitTarget(0.22);
  const rollHitTarget = createHitTarget(0.2);
  rollKnob.add(rollHitTarget);
  scene.add(ballHitTarget, azimuthHitTarget, elevationHitTarget);

  // Amber lamp gizmo on an outer sphere; hidden unless config.lighting is set.
  const lightColor = new THREE.Color("#fbbf24");
  const lightMaterial = new THREE.MeshStandardMaterial({
    color: lightColor,
    emissive: lightColor,
    emissiveIntensity: 0.85,
    roughness: 0.35,
  });
  const lightGroup = new THREE.Group();
  const lightMarker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), lightMaterial);
  const lightAim = new THREE.Group();
  const lightCone = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 8), lightMaterial);
  lightCone.rotation.x = Math.PI / 2;
  lightCone.position.z = 0.18;
  lightAim.add(lightCone);
  const lightRayMaterial = new THREE.LineBasicMaterial({ color: lightColor, transparent: true, opacity: 0.5 });
  const lightRay = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    lightRayMaterial,
  );
  const lightHitTarget = createHitTarget(0.26);
  lightGroup.add(lightMarker, lightAim, lightRay, lightHitTarget);
  lightGroup.visible = false;
  scene.add(lightGroup);
  const lightRayPositions = lightRay.geometry.getAttribute("position");

  const directionLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0.2),
      new THREE.Vector3(0, 0, 0.2),
    ]),
    new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.9 }),
  );
  scene.add(directionLine);
  const directionPositions = directionLine.geometry.getAttribute("position");

  let loadedTexture: Texture | null = null;
  let imageWidth = 0;
  let imageHeight = 0;

  const fitImagePlane = (width: number, height: number) => {
    const fit = containImageRect(width, height, 160, 180);
    const planeWidth = fit.width / 100;
    const planeHeight = fit.height / 100;
    imagePlane.geometry.dispose();
    imagePlane.geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    imageBack.geometry.dispose();
    imageBack.geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    cardBorder.geometry.dispose();
    cardBorder.geometry = createRectGeometry(THREE, planeWidth, planeHeight);
    cardTop.position.y = planeHeight / 2 - 0.08;
  };

  const render = () => {
    const current = getConfig();
    const position = sphericalToTiAngle(current, markerRadius(current));
    const markerPosition = new THREE.Vector3(
      position.x,
      position.y,
      position.z,
    );
    ball.position.copy(markerPosition);
    ballHitTarget.position.copy(markerPosition);
    cameraRig.position.copy(markerPosition);
    cameraRig.lookAt(0, 0, 0);

    const azimuthRadians = (current.azimuthDeg * Math.PI) / 180;
    const azimuthPosition = new THREE.Vector3(
      Math.sin(azimuthRadians) * ORBIT_RADIUS,
      ORBIT_Y,
      Math.cos(azimuthRadians) * ORBIT_RADIUS,
    );
    azimuthHandle.position.copy(azimuthPosition);
    azimuthHitTarget.position.copy(azimuthPosition);

    const elevationRadians = (current.elevationDeg * Math.PI) / 180;
    const elevationPosition = new THREE.Vector3(
      -Math.cos(elevationRadians) * ORBIT_RADIUS,
      Math.sin(elevationRadians) * ORBIT_RADIUS,
      0,
    );
    elevationHandle.position.copy(elevationPosition);
    elevationHitTarget.position.copy(elevationPosition);

    const lighting = current.lighting;
    lightGroup.visible = Boolean(lighting);
    if (lighting) {
      const lightCart = sphericalToTiAngle(lighting, LIGHT_RADIUS);
      lightMarker.position.set(lightCart.x, lightCart.y, lightCart.z);
      lightAim.position.copy(lightMarker.position);
      lightAim.lookAt(0, 0, 0);
      lightHitTarget.position.copy(lightMarker.position);
      lightRayPositions.setXYZ(0, 0, 0, 0);
      lightRayPositions.setXYZ(1, lightCart.x, lightCart.y, lightCart.z);
      lightRayPositions.needsUpdate = true;
      const appearance = LIGHT_STYLE_APPEARANCES[lighting.style ?? "default"] ?? LIGHT_STYLE_APPEARANCES.default;
      lightMaterial.color.set(appearance.color);
      lightMaterial.emissive.set(appearance.color);
      lightRayMaterial.color.set(appearance.color);
      lightRayMaterial.opacity = appearance.rayOpacity;
      lightMarker.scale.setScalar(appearance.markerScale);
      lightCone.visible = appearance.coneScale > 0;
      lightCone.scale.setScalar(appearance.coneScale || 1);
    }

    // Reuse the preallocated attribute instead of rebuilding the geometry each frame.
    directionPositions.setXYZ(0, 0, 0, 0);
    directionPositions.setXYZ(1, markerPosition.x, markerPosition.y, markerPosition.z);
    directionPositions.needsUpdate = true;
    frame.rotation.z = (frameMarkerRotationDeg(current.rollDeg) * Math.PI) / 180;
    renderer.render(scene, camera);
  };

  if (image) {
    const loader = new THREE.TextureLoader();
    loadedTexture = loader.load(
      image,
      (texture) => {
        if (disposed) {
          texture.dispose();
          return;
        }
        onTextureState("loaded");
        imageWidth = texture.image?.naturalWidth ?? texture.image?.width ?? 0;
        imageHeight = texture.image?.naturalHeight ?? texture.image?.height ?? 0;
        if (imageWidth > 0 && imageHeight > 0) fitImagePlane(imageWidth, imageHeight);
        texture.colorSpace = THREE.SRGBColorSpace;
        imageMaterial.map = texture;
        imageMaterial.needsUpdate = true;
        renderer.render(scene, camera);
      },
      undefined,
      () => {
        if (!disposed) onTextureState("error");
      },
    );
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  /** Convert client coords to NDC and aim the shared raycaster. Returns false outside the canvas. */
  const aimRay = (clientX: number, clientY: number): boolean => {
    const rect = canvas.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return false;
    }
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return true;
  };

  const hitTest = (clientX: number, clientY: number): TiAngleDragMode | null => {
    if (!aimRay(clientX, clientY)) return null;
    const intersections = raycaster.intersectObjects([
      imagePlane,
      imageBack,
      ballHitTarget,
      azimuthHitTarget,
      elevationHitTarget,
      rollHitTarget,
      ...(getConfig().lighting ? [lightHitTarget] : []),
    ]);
    const first = intersections[0]?.object;
    if (!first || first === imagePlane || first === imageBack) return null;
    if (first === ballHitTarget) return "orbit";
    if (first === azimuthHitTarget) return "azimuth";
    if (first === elevationHitTarget) return "elevation";
    if (first === rollHitTarget) return "roll";
    if (first === lightHitTarget) return "light";
    return null;
  };

  const scratchA = new THREE.Vector3();
  const scratchB = new THREE.Vector3();

  /**
   * Analytic drag: project the pointer ray onto the constraint surface instead
   * of scanning the projected track one degree at a time. Each mode gets the
   * same world-space fidelity the old axis-only projection had.
   */
  const drag: TiAngleSceneApi["drag"] = (start, mode, startClientX, startClientY, clientX, clientY) => {
    if (mode === "roll") {
      // Screen-space angle delta around the camera rig: clockwise on screen maps
      // to positive roll, matching the 顺时针 semantics of rollDeg.
      cameraRig.getWorldPosition(scratchA).project(camera);
      const rect = canvas.getBoundingClientRect();
      const centerX = rect.left + (scratchA.x + 1) * rect.width / 2;
      const centerY = rect.top + (1 - scratchA.y) * rect.height / 2;
      const startAngle = Math.atan2(startClientY - centerY, startClientX - centerX);
      const currentAngle = Math.atan2(clientY - centerY, clientX - centerX);
      let delta = ((currentAngle - startAngle) * 180) / Math.PI;
      delta = ((delta + 180) % 360 + 360) % 360 - 180;
      return { ...start, ...normalizeTiAngleDegrees({ ...start, rollDeg: start.rollDeg + delta }) };
    }
    if (!aimRay(clientX, clientY)) return start;
    const ray = raycaster.ray;
    if (mode === "orbit") {
      // Nearest point on the marker sphere along the view ray.
      const t = Math.max(0, -ray.origin.dot(ray.direction));
      ray.at(t, scratchA);
      const direction = scratchA.lengthSq() > EPSILON
        ? scratchA.normalize()
        : scratchA.copy(ray.direction).negate();
      const point = direction.multiplyScalar(markerRadius(start));
      const degrees = cartesianToTiAngle(point);
      return { ...start, ...normalizeTiAngleDegrees({ ...start, ...degrees }) };
    }
    if (mode === "light") {
      // Same nearest-point-on-sphere intersection as orbit, but writing lighting
      // instead of the camera angles and keeping the full ±90° elevation range.
      const t = Math.max(0, -ray.origin.dot(ray.direction));
      ray.at(t, scratchA);
      const direction = scratchA.lengthSq() > EPSILON
        ? scratchA.normalize()
        : scratchA.copy(ray.direction).negate();
      const point = direction.multiplyScalar(LIGHT_RADIUS);
      const wrapped = ((point.x !== 0 || point.z !== 0)
        ? ((Math.atan2(point.x, point.z) * 180 / Math.PI + 180) % 360 + 360) % 360 - 180
        : 0);
      const elevationDeg = Math.round(clamp(
        (Math.asin(clamp(point.y / LIGHT_RADIUS, -1, 1)) * 180) / Math.PI,
        -90,
        90,
      )) || 0;
      const azimuthDeg = Math.round(wrapped) || 0;
      // Manual drag makes the position custom: keep the style, drop the pattern preset.
      return {
        ...start,
        lighting: {
          azimuthDeg,
          elevationDeg,
          ...(start.lighting?.style ? { style: start.lighting.style } : {}),
        },
      };
    }
    if (mode === "azimuth") {
      // Pointer ray ∩ orbit plane (y = ORBIT_Y) gives the angle directly.
      const dirY = ray.direction.y;
      if (Math.abs(dirY) < EPSILON) return start;
      const t = (ORBIT_Y - ray.origin.y) / dirY;
      if (t <= 0) return start;
      ray.at(t, scratchA);
      const azimuthDeg = (Math.atan2(scratchA.x, scratchA.z) * 180) / Math.PI;
      return { ...start, ...normalizeTiAngleDegrees({ ...start, azimuthDeg }) };
    }
    // mode === "elevation": ray ∩ the vertical arc plane (z = 0); the handle
    // parametrization is (-cos e, sin e, 0) so elevation = atan2(y, -x).
    const dirZ = ray.direction.z;
    if (Math.abs(dirZ) < EPSILON) return start;
    const t = -ray.origin.z / dirZ;
    if (t <= 0) return start;
    ray.at(t, scratchB);
    const elevationDeg = (Math.atan2(scratchB.y, -scratchB.x) * 180) / Math.PI;
    return { ...start, ...normalizeTiAngleDegrees({ ...start, elevationDeg }) };
  };

  const resize = (width: number, height: number) => {
    renderer.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)), false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };

  const zoom = (deltaY: number) => {
    const distance = camera.position.length();
    const next = clamp(distance * (deltaY > 0 ? 1.12 : 0.89), CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX);
    if (next === distance) return;
    camera.position.setLength(next);
    render();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    loadedTexture?.dispose();
    scene.traverse((object) => {
      const disposable = object as Mesh & {
        material?: Material | Material[];
      };
      disposable.geometry?.dispose();
      const materials = disposable.material
        ? Array.isArray(disposable.material)
          ? disposable.material
          : [disposable.material]
        : [];
      materials.forEach((material) => {
        const textureMaterial = material as Material & { map?: Texture | null };
        textureMaterial.map?.dispose();
        material.dispose();
      });
    });
    renderer.dispose();
    scene.clear();
  };

  return { render, hitTest, drag, resize, zoom, dispose };
}
